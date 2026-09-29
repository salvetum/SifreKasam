"""Kasa ayar tablosu için tek okuma/yazma noktası.

Aynı ayar tek istek içinde defalarca okunur (kart döngüleri, context processor,
ayarlar API yanıtları). Her okuma ayrı bir SQL sorgusu demekti; istek başına
``flask.g`` üzerinde tutulan önbellek bu maliyeti sıfırlar. Yazma tarafı da
önbelleği tazeler ki aynı istek içindeki yaz-oku akışları bayat kalmasın.

Bu modül, kasa_core içinde birbirinden bağımsız kopyalanmış ayar okuma/yazma
yardımcılarını (appearance, backups, lan_access, network_policy) tek uygulamaya
bağlar. Semantikler zaten birebir aynıydı; tek fark önbellekti.

Döngüsel import yok: bu modül yalnızca ``kasa_core.extensions`` (kasa_core'dan
import almaz) ve ``kasa_core.models`` (yalnızca extensions'a bağlı) import eder.
"""

from flask import g, has_request_context

from kasa_core.extensions import db
from kasa_core.models import Setting

# İstek önbelleğinin ``flask.g`` üzerindeki anahtarı. Bu ad geçmişte yalnızca
# appearance modülüne aitti; modül adı değiştiği için anahtar korunmuştur.
# Modül dışından referans verilmez.
_CACHE_KEY = '_appearance_settings_cache'


def _request_cache() -> dict[str, str | None] | None:
    """İstek bağlamı varsa o isteğe ait ayar önbelleğini döndürür.

    İstek bağlamı dışında (arka plan iş parçacıkları, migration, CLI) ``None``
    döner; bu durumda her çağrı doğrudan veritabanına gider.
    """
    if not has_request_context():
        return None
    return g.setdefault(_CACHE_KEY, {})


def get_setting(key: str) -> str | None:
    """Ayarın ham (string) değerini döndürür; kayıt yoksa ``None``."""
    cache = _request_cache()
    if cache is not None and key in cache:
        return cache[key]
    setting = Setting.query.filter_by(key=key).first()
    value = setting.value if setting else None
    if cache is not None:
        cache[key] = value
    return value


def set_setting(key: str, value: str) -> None:
    """Ayarı yazar (yoksa oluşturur) ve istek önbelleğini tazeler."""
    cache = _request_cache()
    if cache is not None:
        cache[key] = value
    setting = Setting.query.filter_by(key=key).first()
    if setting:
        setting.value = value
    else:
        db.session.add(Setting(key=key, value=value))


def forget_setting(key: str) -> None:
    """Anahtarı istek önbelleğinden düşürür.

    Ayar satırları SQLAlchemy ORM yerine toplu (bulk) ``delete()`` ile silindiğinde
    önbellek bayat kalır. Silme yapan her yolun çağırması gerekir; aksi halde
    aynı istek içinde sonraki okuma silinmiş değeri döndürür.
    """
    cache = _request_cache()
    if cache is not None:
        cache.pop(key, None)
