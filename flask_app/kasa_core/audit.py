"""Kasa güvenlik olay günlüğü (audit log).

Amaç: kasa kimliğine, erişimine ve bütünlüğüne dokunan olayları kalıcı ve
ayrıştırılabilir bir günlüğe yazmak. Kullanıcı kararı gereği arayüz/UI **yoktur**:
günlük yalnızca konsola ve log dosyasına yazılır.

Modül iki kural üzerine kuruludur; ikisi de testle zorlanır:

1. **Sır asla yazılmaz.** Reddedilen alan adlarından birini taşıyan olay
   *hiç* yazılmaz (fail-closed) — yazılan bir satırda parola, şifreli metin,
   anahtar, tuz veya kayıt içeriği bulunamaz. İzinli bir alana sızan Fernet
   benzeri değerler ``<maskeli>`` ile değiştirilir.
2. **Günlük satırı, günlük satırı taklit edemez.** Alan adı ve değerlerden
   kontrol karakterleri temizlenir, satır JSON olarak serileştirilir; log
   enjeksiyonu (içeriğe gömülü sahte günlük satırı) bu yüzden mümkün değildir.

Yazma hatası uygulamayı düşürmemelidir: günlük teşhis aracıdır, iş akışının
parçası değil. Bu yüzden tüm yazma yolları ``audit()`` içinde istisna yutmadan
geçer ve çağıran tarafa yalnızca başarı/başarısızlık bilgisi döner.
"""

from __future__ import annotations

import json
import logging
import logging.handlers
import os
import re
import threading
from typing import Any

from kasa_core.time_utils import utc_iso_timestamp

log = logging.getLogger(__name__)

# Dosya adı ve rotasyon sınırları mevcut backend log handler'ı ile aynıdır:
# iki günlük de aynı disk bütçesini paylaşmasın diye ayrı dosya + aynı boyut.
AUDIT_FILE_NAME = 'guvenlik-olaylari.log'
AUDIT_MAX_BYTES = 1024 * 1024
AUDIT_BACKUP_COUNT = 3

# Konsol ve dosya satırlarının ortak etiketi. Kullanıcı arayüzü olmadığı için
# bu etiket, günlüğün insan gözüyle taranabilir kalan tek unsurudur.
AUDIT_TAG = '[GUVENLIK]'
AUDIT_MASKED = '<maskeli>'
# Alan adı sınırsız büyüyebilir (örn. istemci User-Agent'ı); günlük satırını
# okunur ve makine-ayrıştırılabilir tutmak için değerler bu uzunlukta kırpılır.
AUDIT_MAX_VALUE_CHARS = 64

# Alan adı KURALLARI. Buradaki asıl savunma DENY listesi değil, ALLOW
# listesidir: yalnızca aşağıdaki ``ALLOWED_FIELD_NAMES`` kümesindeki adlar
# günlüğe yazılabilir. Deny listesi tek başına yeterli değildir — ölçüldü ki
# ``icerik``/``kullanici`` gibi listede olmayan bir ad geçer sayılıp içine
# ne konursa konulsun düz yazılıyordu (parola sızıntısı). Kasa verisinin
# "asla yazılmaması" gereksinimi ancak varsayılan-red (allowlist) ile
# garantilenebilir: yeni bir çağrı noktası yeni bir alan adı uydurursa
# olay yazılmaz, sessizce içerik sızmaz.
#
# DENY listesi yine de muamul edilir: iç içe geçmiş dict/list içinde gizlenen
# sırları yakalar ve bir alan adı hem izinli hem reddedilmişse (kasten ya da
# yanlışlıkla) reddedilir. Yani "izinli" olmak bir alanı otomatik olarak
# güvenli yapmaz; içerik taraması da devreye girer.
ALLOWED_FIELD_NAMES = frozenset({
    # sayımlar — olayın boyutunu anlatır, içerik anlatmaz
    'kayitsayisi', 'silinenkayitsayisi', 'kalansaniye', 'adet', 'toplam',
    'oturumdusuruldu',
    # kayıt TÜRÜ / kanal gibi kapalı bir kümeden gelen, kullanıcı verisi olmayan alan
    'tur', 'kanal', 'kaynak', 'sebep',
    # uç adı / form alanı adı — koda sabit gelir, kullanıcı verisi taşımaz
    'uc', 'endpoint', 'metot', 'alan',
    # ağ bağlamı
    'uzaktanmi', 'yerel', 'uzak',
    # yedek dosyasının kendi adı (sifrekasam_otomatik_<tarih>.kasaenc kalıbı;
    # içerik değil, dosya adı). Yine de değer taramasından geçer.
    'dosya',
    # yayın sürümü
    'surum',
})

# Alan adı reddi: normalleştirme (küçük harf + alfasayı olmayan karakterler
# atılır) sonrası bu kümedeki bir adı taşıyan olay hiç yazılmaz. Kume "tam
# eşleşme" ile çalışır; böylece `kayit_sayisi` gibi güvenli sayım alanları
# `sayi` gibi masum bir adla çakışmadan geçer.
DENIED_FIELD_NAMES = frozenset({
    # Parolalar
    'password', 'passwd', 'pass', 'pwd', 'passphrase',
    'masterpassword', 'newpassword', 'oldpassword', 'currentpassword',
    'lanpassword', 'backuppassword', 'encryptedpassword', 'passwordconfirm',
    # Anahtarlar, token'lar, sırlar
    'secret', 'secrets', 'clientsecret', 'token', 'accesstoken', 'refreshtoken',
    'apptoken', 'csrftoken', 'sessionkey', 'flasksecretkey', 'apikey',
    'key', 'apikeysecret', 'privatekey', 'vaultkey', 'masterkey',
    'encryptionkey', 'fernetkey', 'signingkey', 'recoverykey', 'seed',
    'authorization', 'cookie', 'credentials', 'auth',
    # Hash / tuz / şifreli malzeme
    'hash', 'masterhash', 'passwordhash', 'salt', 'pbkdf2salt', 'cipher',
    'ciphertext', 'encrypted', 'encrypteddata', 'blob', 'nonce', 'iv',
    # Kayıt içeriği (kasa verisi)
    'title', 'recordtitle', 'name', 'username', 'user', 'login', 'account',
    'email', 'cardholder', 'holder', 'note', 'notes', 'comment', 'text',
    'content', 'value', 'data', 'payload', 'body', 'record', 'records',
    'url', 'websiteurl', 'website', 'domain', 'expirydate', 'pin', 'totp',
    'otp', 'answer', 'hint',
})

# Değer maskeleme: izinli alana sızan şifreleme materyali günlüğe yazılmaz.
# İki biçim de kapsanır:
#   - Fernet BELİRTECİ (şifreli metin): sürüm baytı 0x80 -> base64 "gAAA..."
#   - Fernet ANAHTARI: 44 karakter, url-safe base64, '=' ile biter
# Anahtar "g" ile başlamaz; yalnızca belirteç başlar. Sadece belirteci
# maskelemek, kasa anahtarının sızmasına yol açardı.
_FERNET_TOKEN_RE = re.compile(r'\Ag[A-Za-z0-9_-]{20,}={0,2}\Z')
_FERNET_KEY_RE = re.compile(r'\A[A-Za-z0-9_-]{43}={1,2}\Z')
_CONTROL_CHARS_RE = re.compile(r'[\x00-\x1f\x7f]')
_FIELD_NAME_NOISE_RE = re.compile(r'[^a-z0-9]')

_handler_lock = threading.RLock()
_handler: logging.Handler | None = None
_log_dir: str | None = None


class _AuditFileHandler(logging.handlers.RotatingFileHandler):
    """Yazma hatasında günlük akışını düşürmeyen rotasyonlu dosya handler'ı.

    Varsayılan ``handleError`` hatayı stderr'e basar ve bu, hatayı yol açan
    çağrıyı yine de gürültülendirir. Biz yalnızca konsola kısa bir uyarı
    düşüyoruz; yığın izi veya dosya içeriği asla yazılmıyor.

    ``handleError`` ayrıca hatayı işaretler: ``StreamHandler.emit`` yazma
    hatalarını YUTAR, yani ``audit()`` istisna görmez. Bu bayrak olmadan
    ``audit()`` yazılamayan bir olay için de True dönerdi; çağıran taraf
    (ve testler) yanlışlıkla "günlüğe yazıldı" sanardı.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.last_error = False
        super().__init__(*args, **kwargs)

    def handleError(self, record: logging.LogRecord) -> None:
        self.last_error = True
        log.warning("Güvenlik günlüğü satırı yazılamadı.")


def _normalize_field_name(name: str) -> str:
    """Alan adını reddi/karşılaştırma için normalize eder (küçük harf, alfasayı)."""
    return _FIELD_NAME_NOISE_RE.sub('', str(name).lower())


def _sanitize_text(value: str) -> str:
    """Kontrol karakterlerini temizler ve uzunluğu sınırlar.

    Satır sonu ve tab temizlenmezse günlüğe gömülü sahte satırlar oluşabilir
    (log enjeksiyonu). Temizlik hemen ardından JSON serileştirmesi geldiği için
    satır her durumda tek satır kalır.
    """
    cleaned = _CONTROL_CHARS_RE.sub(' ', str(value)).strip()
    return cleaned[:AUDIT_MAX_VALUE_CHARS]


def _is_denied_field(name: str) -> bool:
    return _normalize_field_name(name) in DENIED_FIELD_NAMES


def _is_allowed_field(name: str) -> bool:
    """Alan adı izin listesinde VE red listesinde değilse yazılabilir.

    Red listesi önceliklidir: bir ad iki kümede de bulunuyorsa yazılmaz.
    """
    normalized = _normalize_field_name(name)
    if normalized in DENIED_FIELD_NAMES:
        return False
    return normalized in ALLOWED_FIELD_NAMES


def _contains_denied_field(value: Any) -> bool:
    """İç içe geçmiş sözlük/liste değerlerinin anahtarlarını da denetler.

    ``audit('x', extra={'password': '...'})`` gibi bir çağrı, üst anahtar
    (``extra``) izinli görünse bile sızdırmamalıdır.
    """
    if isinstance(value, dict):
        return any(_is_denied_field(key) or _contains_denied_field(item)
                   for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_contains_denied_field(item) for item in value)
    return False


def _clean_value(value: Any) -> Any:
    """Değeri günlüğe yazılabilecek hale getirir.

    Sayı/bool/None JSON için yerinde kalır; metinler temizlenir, Fernet benzeri
    değerler maskelenir, uzun metinler kırpılır.
    """
    if value is None or isinstance(value, (bool, int, float)):
        return value
    # Maskeleme KIRPMA ÖNCESİ yapılır: uzun bir şifreli metin önce 64
    # karaktere kırpılırsa geri kalanı Fernet imzasını kaybeder ve günlüğe
    # şifreli metin sızar.
    raw = _CONTROL_CHARS_RE.sub(' ', str(value)).strip()
    if _FERNET_TOKEN_RE.match(raw) or _FERNET_KEY_RE.match(raw):
        return AUDIT_MASKED
    return raw[:AUDIT_MAX_VALUE_CHARS]


def set_audit_log_dir(logs_dir: str) -> bool:
    """Günlük dosyasının yazılacağı dizini belirler (idempotent).

    ``app.py`` LOGS_DIR hesaplandıktan hemen sonra bir kez çağrılır. Aynı
    dizinle tekrar çağrılması mevcut handler'ı korur (dosya tanıtıcısı
    değişmez, üzerine yazma/kayıp olmaz); farklı bir dizine geçişte eski
    handler kapatılır. Dizin oluşturulamazsa günlük sessizce devre dışı kalır —
    uygulama çalışmaya devam eder.
    """
    global _handler, _log_dir
    try:
        target = os.path.abspath(str(logs_dir))
    except (TypeError, ValueError):
        return False

    with _handler_lock:
        if _handler is not None and _log_dir == target:
            return True
        if _handler is not None:
            try:
                _handler.close()
            except Exception:
                pass
            _handler = None
            _log_dir = None
        try:
            os.makedirs(target, exist_ok=True)
            handler = _AuditFileHandler(
                os.path.join(target, AUDIT_FILE_NAME),
                maxBytes=AUDIT_MAX_BYTES,
                backupCount=AUDIT_BACKUP_COUNT,
                encoding='utf-8',
                # Dosya ilk yazımda açılır: geçersiz/erişilemeyen dizin
                # uygulama açılışını değil, yalnızca günlük yazımını etkiler.
                delay=True,
            )
            handler.setFormatter(logging.Formatter('%(message)s'))
            handler.setLevel(logging.INFO)
        except OSError:
            log.warning("Güvenlik günlüğü dizini hazırlanamadı; günlük kapalı.")
            return False
        _handler = handler
        _log_dir = target
        return True


def get_audit_log_path() -> str | None:
    """Aktif günlük dosyasının tam yolunu döndürür (yoksa ``None``)."""
    with _handler_lock:
        if _log_dir is None:
            return None
        return os.path.join(_log_dir, AUDIT_FILE_NAME)


def _emit(payload: dict[str, Any]) -> bool:
    """Hazırlanmış olayı konsola ve dosyaya yazar. Hata durumunda False."""
    line = AUDIT_TAG + ' ' + json.dumps(payload, ensure_ascii=False, sort_keys=True)

    # Konsol: kök logger (uygulamanın mevcut çıktı kanalı).
    try:
        log.info(line)
    except Exception:
        pass

    # Dosya: doğrudan handler. ``Handler.handle`` üzerinden çağrılır; bu yol
    # Logger.handle'daki ``logging.disable`` kontrolünden geçmez, böylece test
    # ve teşhis sırasında günlük sessizleştirilse de olay kaydı korunur.
    with _handler_lock:
        handler = _handler
    if handler is None:
        return False
    try:
        handler.last_error = False
        handler.handle(logging.LogRecord(
            name='kasa_core.audit', level=logging.INFO, pathname=__file__,
            lineno=0, msg=line, args=(), exc_info=None,
        ))
    except Exception:
        # Rotasyon/erişim hatası günlüğü düşürmemeli.
        return False
    # emit() içe yutulmuş hataları last_error ile bildirir.
    return not handler.last_error


def audit(event: str, **fields: Any) -> bool:
    """Tek güvenlik olayı günlüğe yazar.

    Satır biçimi: ``[GUVENLIK] {"event": ..., "ts": ..., ...}`` — JSON, tek
    satır, ``ensure_ascii=False``.

    Reddedilen bir alan adı (parola, anahtar, kayıt içeriği ...), izin
    listesinde olmayan bir alan adı veya iç içe geçmiş bir reddedilen **hiç yazılmaz**; ``False``
    döner. Yazma hatası da ``False`` döner, istisna yükselmez.

    Dönüş: olay dosyaya kalıcı olarak yazıldıysa ``True``.
    """
    try:
        if not isinstance(event, str):
            return False
        name = _sanitize_text(event)
        if not name:
            return False

        for key in fields:
            if not _is_allowed_field(key):
                # Nedeni ayırt et: red listesi mi, yoksa izin listesinde
                # olmadığı mı? Konsolda ikisi de görünür, dosyaya hiçbiri
                # yazılmaz (varsayılan-red).
                reason = 'reddedilen' if _is_denied_field(key) else 'izin listesinde olmayan'
                log.warning("%s Alan %s, olay yazılmadı: %s", AUDIT_TAG, reason, key)
                return False
            if _contains_denied_field(fields[key]):
                log.warning("%s İç içe reddedilen alan, olay yazılmadı: %s",
                            AUDIT_TAG, key)
                return False

        payload: dict[str, Any] = {
            'ts': utc_iso_timestamp(),
            'event': name,
        }
        for key, value in fields.items():
            payload[_sanitize_text(key)] = _clean_value(value)
        return _emit(payload)
    except Exception:
        # Günlük asla uygulamayı düşürmemeli.
        return False


def read_audit_log(limit: int = 100) -> list[dict[str, Any]]:
    """Günlüğün **son** ``limit`` olayını kronolojik sırayla döndürür.

    Bozuk/yarım satırlar atlanır (rotasyon sırasında oluşabilir). Dosya yoksa
    boş liste döner; okuma hatası da istisna yükseltmez.
    """
    if limit <= 0:
        return []
    path = get_audit_log_path()
    if path is None:
        return []
    entries: list[dict[str, Any]] = []
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            for line in handle:
                line = line.strip()
                if not line.startswith(AUDIT_TAG):
                    continue
                raw = line[len(AUDIT_TAG):].strip()
                try:
                    parsed = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if isinstance(parsed, dict):
                    entries.append(parsed)
    except OSError:
        return entries
    return entries[-limit:]
