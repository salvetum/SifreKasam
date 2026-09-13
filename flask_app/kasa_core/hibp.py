"""HaveIBeenPwned k-anonimlik istemcisi (canlı sızıntı taraması).

Güvenlik modeli:
- Şifrenin **tamamı asla** ağa gönderilmez; yalnızca SHA-1 parmak izinin ilk
  5 altıgen karakteri gönderilir (k-anonimlik). Sunucu bu önekle eşleşen
  sonek listesini döner; tam parmak izi eşleşmesi tamamen yerelde yapılır.
- Yerel önbellek yalnızca ``prefix → sonek kümesi`` tutar; düz şifre, başlık,
  kullanıcı adı veya tam parmak izi asla saklanmaz / günlüğe yazılmaz.
- İsteğe bağlı disk kalıcılığı (``set_persistence_path``): tarama sonuçları
  yeniden başlatmalarda kaybolmasın diye aynı ``prefix → sonek kümesi`` JSON
  dosyasına yazılır. Bu veri HIBP'nin açık aralık verisidir (k-anonim), sır
  içermez; yol verilmezse kalıcılık devre dışıdır (test/taşınabilir mod).
- TLS doğrulaması zorunludur (``ssl`` varsayılan bağlam). Herhangi bir ağ
  hatasında işlem sessizce başarısız olur (``None``) ve önbelleğe yazılmaz;
  hiçbir yeniden deneme ("retry") yapılmaz.
- HIBP aralık ucu istekler arası yaklaşık 1,5 saniye sınır uygular; bu modül
  istemci tarafında da aynı sınırlamayı (varsayılan 1,6sn) senkron uygular.
- Kill-switch açıkken ``scan_passwords`` tek bir istek bile göndermeden hiçbir
  şey yapmaz. ``cached_breach_status`` ise
  YALNIZCA önbelleği okur ve hiçbir zaman ağ isteği başlatmaz — rapor üretimi
  sırasında kullanılacak olan budur.
"""

import hashlib
import json
import logging
import os
import threading
import time
from collections import defaultdict
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from kasa_core.network_policy import internet_allowed

log = logging.getLogger(__name__)

HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/{prefix}'
DEFAULT_TIMEOUT = 8.0
MIN_REQUEST_INTERVAL = 1.6  # saniye; HIBP limitinin biraz üzerinde
CACHE_TTL_SECONDS = 6 * 3600  # HIBP önerisi boğunca zarar vermez; 6 saat

_USER_AGENT = 'SifreKasam PasswordManager/1.0 (offline-first, k-anonymity)'


def sha1_hex(password: str) -> str:
    """Şifrenin büyük harf SHA-1 parmak izi (k-anonim önek için)."""
    digest = hashlib.sha1(password.encode('utf-8', 'ignore')).hexdigest()
    return digest.upper()


_lock = threading.Lock()
_target_cache: dict[str, tuple[float, frozenset[str]]] = {}
_last_fetch_at = 0.0
_cache_file_path: str | None = None


def set_persistence_path(path: str | None) -> None:
    """Önbelleğin disk yolunu ayarlar; yol verilirse diskteki kaydı yükler.

    Diske yalnızca k-anonim ``prefix → sonek kümesi`` yazılır: düz şifre,
    başlık, kullanıcı adı veya tam parmak izi hiçbir zaman saklanmaz. Yol
    ``None`` ise kalıcılık devre dışı kalır (test/taşınabilir mod).
    """
    global _cache_file_path
    _cache_file_path = path
    if path:
        _load_cache()


def _load_cache() -> None:
    path = _cache_file_path
    if not path or not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        now = time.time()
        with _lock:
            for prefix, item in data.items():
                if not isinstance(item, dict):
                    continue
                created_at = float(item.get('t', 0) or 0)
                suffixes = item.get('s') or []
                if now - created_at <= CACHE_TTL_SECONDS and suffixes:
                    _target_cache[str(prefix)] = (created_at, frozenset(suffixes))
    except (OSError, ValueError, TypeError, KeyError) as exc:
        log.warning('HIBP onbellek diskten okunamadi: %s', exc)


def _persist_cache() -> None:
    path = _cache_file_path
    if not path:
        return
    try:
        with _lock:
            snapshot = {
                prefix: {'t': created_at, 's': sorted(suffixes)}
                for prefix, (created_at, suffixes) in _target_cache.items()
            }
        if not snapshot:
            return
        tmp_path = f'{path}.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as handle:
            json.dump(snapshot, handle, ensure_ascii=False, sort_keys=True)
        os.replace(tmp_path, path)
    except (OSError, TypeError, ValueError) as exc:
        log.warning('HIBP onbellek diske yazilamadi: %s', exc)


def _cache_get(prefix: str) -> frozenset[str] | None:
    with _lock:
        item = _target_cache.get(prefix)
    if not item:
        return None
    created_at, suffixes = item
    if time.time() - created_at > CACHE_TTL_SECONDS:
        with _lock:
            _target_cache.pop(prefix, None)
        return None
    return suffixes


def _pace(min_interval: float) -> None:
    global _last_fetch_at
    with _lock:
        wait = min_interval - (time.time() - _last_fetch_at)
        if wait > 0:
            time.sleep(wait)
        _last_fetch_at = time.time()


def _fetch_suffixes(prefix: str, timeout: float) -> frozenset[str]:
    """HIBP aralık ucu: eşleşen sonekleri çeker. Hata durumunda yükseltir."""
    request = Request(
        HIBP_RANGE_URL.format(prefix=prefix),
        headers={'User-Agent': _USER_AGENT, 'Accept': 'text/plain'},
    )
    with urlopen(request, timeout=timeout) as response:
        body = response.read().decode('utf-8', 'replace')
    suffixes: set[str] = set()
    for line in body.splitlines():
        suffix, _, _count = line.partition(':')
        suffix = suffix.strip()
        if suffix:
            suffixes.add(suffix)
    return frozenset(suffixes)


def cached_breach_status(password: str) -> bool | None:
    """Yalnızca önbellekten sızıntı durumu; hiçbir zaman ağ isteği başlatmaz.

    Rapor üretimi sırasında çağrılır — kill-switch açık olsa bile güvenlidir,
    çünkü istek yoktur. Daha önce canlı taranmış önekler için kesin sonuç,
    taranmamışlar için ``None`` döner.
    """
    digest = sha1_hex(password)
    cached = _cache_get(digest[:5])
    if cached is None:
        return None
    return digest[5:] in cached


def scan_passwords(
    passwords: list[str],
    on_progress: Callable[[int, int, int], None] | None = None,
    should_abort: Callable[[], bool] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    min_interval: float = MIN_REQUEST_INTERVAL,
) -> tuple[int, int]:
    """Tüm şifrelerin öneklerini (her önek bir kez) tarar; önbelleği besler.

    Her önek için cache kontrolü: taze kayıt varsa ağ isteği yapılmaz.
    ``on_progress(done, total, breached)`` her önek sonrası çağrılır.
    ``should_abort`` True döndürürse döngü erken sonlanır.
    Dönüş: (işlenen önek, bulunan sızıntı sayısı). Kill-switch açıkken
    hiçbir şey yapmaz ve (0, 0) döner.
    """
    if not internet_allowed():
        return 0, 0

    grouped: dict[str, list[str]] = defaultdict(list)
    for password in passwords:
        digest = sha1_hex(password)
        grouped[digest[:5]].append(digest[5:])

    total = len(grouped)
    done = 0
    breached = 0
    try:
        for prefix, suffixes in grouped.items():
            if should_abort and should_abort():
                break
            cached = _cache_get(prefix)
            if cached is None:
                _pace(min_interval)
                try:
                    cached = _fetch_suffixes(prefix, timeout)
                except (HTTPError, URLError, TimeoutError, OSError) as exc:
                    log.warning('HIBP aralik taramasi basarisiz (%s): %s', prefix, exc)
                    cached = None
                else:
                    with _lock:
                        _target_cache[prefix] = (time.time(), cached)
            if cached is not None:
                breached += sum(1 for suffix in suffixes if suffix in cached)
            done += 1
            if on_progress:
                on_progress(done, total, breached)
    finally:
        # Kesinti/hata olsa bile eldeki sonuçları diske yaz (varsa).
        _persist_cache()
    return done, breached