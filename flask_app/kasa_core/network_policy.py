"""İnternet Kill-Switch ve çevrimiçi özellik kapıları.

Kasa varsayılan olarak çevrimdışı çalışır: hiçbir modül otomatik ağ isteği
başlatmaz. Kullanıcı isteğe bağlı çevrimiçi özellikleri (canlı sızıntı
taraması gibi) etkinleştirdiğinde tüm çıkış istekleri ``internet_allowed()``
kapısından geçmek zorundadır.

Semantik:
- ``internet_kill_switch`` = 'true'  → uygulamanın tüm dış ağ erişimi engellenir.
- ``internet_kill_switch`` = 'false' (varsayılan) → kapalı; uygulama internet
  kullanabilir, ancak hiçbir özellik otomatik olarak ağ çağrısı yapmaz.
- ``live_breach_scan`` = 'true' → canlı HIBP taraması etkin; yine de
  ``internet_allowed()`` doğru olmadan tek bir istek bile gönderilmez.
"""

from kasa_core.models import Setting

INTERNET_KILL_SWITCH_SETTING = 'internet_kill_switch'
LIVE_BREACH_SCAN_SETTING = 'live_breach_scan'

# Varsayılan: kill-switch kapalı (engelleme yok). Çevrimdışı ilk kurulum,
# canlı tarama ayrıca kapalı olduğu için yine de garanti edilir.
DEFAULT_INTERNET_KILL_SWITCH_ENABLED = False
DEFAULT_LIVE_BREACH_SCAN_ENABLED = False


def _get_setting(key: str) -> str | None:
    setting = Setting.query.filter_by(key=key).first()
    return setting.value if setting else None


def internet_kill_switch_enabled() -> bool:
    """Kill-switch açık mı? Açıksa hiçbir dış ağ isteğine izin verilmez."""
    value = _get_setting(INTERNET_KILL_SWITCH_SETTING)
    if value is None:
        return DEFAULT_INTERNET_KILL_SWITCH_ENABLED
    return value.lower() == 'true'


def internet_allowed() -> bool:
    """Uygulama dış ağa istek gönderebilir mi? (kill-switch kapalı mı?)"""
    return not internet_kill_switch_enabled()


def live_breach_scan_enabled() -> bool:
    value = _get_setting(LIVE_BREACH_SCAN_SETTING)
    if value is None:
        return DEFAULT_LIVE_BREACH_SCAN_ENABLED
    return value.lower() == 'true'


def live_breach_scan_available() -> bool:
    """Canlı tarama hem etkin hem de ağ erişimi açık mı?"""
    return internet_allowed() and live_breach_scan_enabled()