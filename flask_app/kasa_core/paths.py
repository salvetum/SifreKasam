"""Runtime data-directory helpers."""

import errno
import logging
import os
import shutil

from .constants import SETUP_MIN_FREE_BYTES, SETUP_RECOMMENDED_FREE_BYTES


log = logging.getLogger(__name__)

# Kurulum ön kontrolünde "hata" yerine geçen durumlar için etiketler.
STORAGE_ERROR_NONE = ""
STORAGE_ERROR_PERMISSION = "permission"
STORAGE_ERROR_SPACE = "space"
STORAGE_ERROR_UNKNOWN = "unknown"


def ensure_private_data_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError as exc:
        log.warning("Veri dizini izinleri sıkılaştırılamadı: %s", exc)
    return path


def _classify_os_error(exc: OSError) -> str:
    if exc.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        return STORAGE_ERROR_PERMISSION
    if exc.errno in (errno.ENOSPC, errno.EDQUOT, errno.EFBIG):
        return STORAGE_ERROR_SPACE
    return STORAGE_ERROR_UNKNOWN


def _probe_writable(directory: str) -> tuple[bool, str]:
    """Dizinde gercekten dosya yazilip silinebildigini dogrular.

    Izin kontrolu stat() ile degil, yazma denemesiyle yapilir: salt-okunur
    bir dizin stat'a gore yazilabilir gorunur ama dosya olusturulamaz.
    """
    probe = os.path.join(directory, ".kasa-write-probe")
    try:
        with open(probe, "wb") as handle:
            handle.write(b"0")
        return True, ""
    except OSError as exc:
        return False, _classify_os_error(exc)
    finally:
        try:
            os.remove(probe)
        except OSError:
            pass


def get_storage_status(directory: str | None = None) -> dict:
    """Kurulum oncesi depolama/izin durumunu ozetler.

    Donus sozlugu template'e dogrudan gecirilebilir; hicbir gizli deger
    icermez (yalnizca yol, izin durumu ve bayt adedi).

    `space_known` False ise `free_bytes`/`has_space` alanlari anlamsizdir:
    disk olcumusu yapilamadi, bu yuzden "bos alan yetersiz" sonucu
    cikarilmaz ve kurulum yalnizca yazma izniyle engellenir.
    """
    target = directory or get_data_dir()
    status = {
        "path": target,
        "exists": False,
        "writable": False,
        "free_bytes": 0,
        "total_bytes": 0,
        "space_known": False,
        "has_space": False,
        "low_space": False,
        "error_kind": STORAGE_ERROR_NONE,
    }
    try:
        status["exists"] = os.path.isdir(target)
    except OSError:
        status["exists"] = False

    writable, probe_error = _probe_writable(target)
    status["writable"] = writable

    try:
        usage = shutil.disk_usage(target)
    except OSError as exc:
        status["error_kind"] = probe_error or _classify_os_error(exc)
        return status
    status["space_known"] = True
    status["free_bytes"] = usage.free
    status["total_bytes"] = usage.total
    status["has_space"] = usage.free >= SETUP_MIN_FREE_BYTES
    status["low_space"] = usage.free < SETUP_RECOMMENDED_FREE_BYTES

    if not writable and not status["error_kind"]:
        status["error_kind"] = probe_error or STORAGE_ERROR_PERMISSION
    return status


def get_data_dir() -> str:
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return ensure_private_data_dir(os.path.join(appdata, ".SifrekasamV2"))
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"),
        ".config",
    )
    return ensure_private_data_dir(os.path.join(xdg, "sifrekasam"))


def get_backgrounds_dir() -> str:
    return ensure_private_data_dir(os.path.join(get_data_dir(), "backgrounds"))
