"""Pure input-normalization helpers."""

from urllib.parse import urlparse

from kasa_core.constants import (
    DEFAULT_ACCENT_COLOR,
    DEFAULT_BACKGROUND_STYLE,
    DEFAULT_GLASS_QUALITY,
    VALID_BACKGROUND_STYLES,
    VALID_GLASS_QUALITIES,
    VALID_RECORD_TYPES,
)


def normalize_record_type(value: str | None) -> str:
    return value if value in VALID_RECORD_TYPES else "Other"


def normalize_text(
    value: object | None,
    fallback: str = "",
    max_length: int | None = None,
) -> str:
    text = str(value if value not in (None, "") else fallback).strip()
    return text[:max_length] if max_length and len(text) > max_length else text


def normalize_url(value: object | None) -> str:
    url = normalize_text(value)
    if not url:
        return ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return parsed.geturl()


def normalize_theme(value: object) -> str:
    return "light" if value == "light" else "dark"


def normalize_glass_effects(value: object) -> bool:
    return str(value).lower() not in {"false", "0", "off", "disabled", "kapali"}


def normalize_theme_option(value: object, default: bool = True) -> bool:
    if value is None:
        return default
    return str(value).lower() not in {"false", "0", "off", "disabled", "kapali"}


def normalize_hex_color(
    value: object,
    fallback: str = DEFAULT_ACCENT_COLOR,
) -> str:
    text = str(value or "").strip()
    if not text.startswith("#"):
        text = f"#{text}"
    if len(text) == 7 and all(
        character in "0123456789abcdefABCDEF" for character in text[1:]
    ):
        return text.lower()
    return fallback


def normalize_background_style(value: object) -> str:
    text = str(value or DEFAULT_BACKGROUND_STYLE).strip().lower()
    return text if text in VALID_BACKGROUND_STYLES else DEFAULT_BACKGROUND_STYLE


def normalize_glass_quality(value: object) -> str:
    text = str(value or DEFAULT_GLASS_QUALITY).strip().lower()
    return text if text in VALID_GLASS_QUALITIES else DEFAULT_GLASS_QUALITY


def safe_int(
    value: object | None,
    default: int,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    if minimum is not None:
        number = max(minimum, number)
    if maximum is not None:
        number = min(maximum, number)
    return number
