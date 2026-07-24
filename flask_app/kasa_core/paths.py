"""Runtime data-directory helpers."""

import logging
import os


log = logging.getLogger(__name__)


def ensure_private_data_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError as exc:
        log.warning("Veri dizini izinleri sıkılaştırılamadı: %s", exc)
    return path


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
