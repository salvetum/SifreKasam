"""Persistent appearance and general setting access."""

import json
import logging
import os
import time
import uuid
from typing import Any

from kasa_core.constants import (
    DEFAULT_ANIMATED_BACKGROUNDS_ENABLED,
    DEFAULT_CHROMA_ACCENT_ENABLED,
    DEFAULT_CHROMA_ACCENT_SPEED,
    DEFAULT_GRADIENTS_ENABLED,
    DEFAULT_HARDWARE_ACCELERATION_ENABLED,
    DEFAULT_INTERFACE_ANIMATIONS_ENABLED,
)
from kasa_core.extensions import db
from kasa_core.models import Setting
from kasa_core.validation import (
    normalize_background_style,
    normalize_chroma_accent_speed,
    normalize_glass_effects,
    normalize_glass_quality,
    normalize_hex_color,
    normalize_theme,
    normalize_theme_mode,
    normalize_theme_option,
)

log = logging.getLogger(__name__)


class AppearanceSettings:
    """Stores settings in SQLite with an atomic JSON fallback."""

    def __init__(self, theme_file: str):
        self.theme_file = theme_file

    def load_file(self) -> dict:
        try:
            if os.path.exists(self.theme_file):
                with open(self.theme_file, "r", encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                    return data if isinstance(data, dict) else {}
        except Exception:
            pass
        return {}

    def save_file(self, **updates: Any) -> None:
        data = self.load_file()
        data.update(updates)
        temporary_file = f"{self.theme_file}.{uuid.uuid4().hex}.tmp"
        try:
            with open(temporary_file, "w", encoding="utf-8") as file_handle:
                json.dump(data, file_handle, ensure_ascii=False)
            for attempt in range(3):
                try:
                    os.replace(temporary_file, self.theme_file)
                    break
                except PermissionError:
                    if attempt < 2:
                        log.warning("theme.json kilitli, %d. deneme...", attempt + 1)
                        time.sleep(0.2)
                    else:
                        log.warning("theme.json atomic replace basarisiz, direct write fallback")
                        with open(self.theme_file, "w", encoding="utf-8") as f:
                            json.dump(data, f, ensure_ascii=False)
                        os.unlink(temporary_file)
        except Exception:
            if os.path.exists(temporary_file):
                try:
                    os.unlink(temporary_file)
                except OSError:
                    pass
            raise

    @staticmethod
    def get_setting(key: str) -> str | None:
        setting = Setting.query.filter_by(key=key).first()
        return setting.value if setting else None

    @staticmethod
    def set_setting(key: str, value: str) -> None:
        setting = Setting.query.filter_by(key=key).first()
        if setting:
            setting.value = value
        else:
            db.session.add(Setting(key=key, value=value))

    def get_saved_theme(self) -> str:
        try:
            value = self.get_setting("theme")
            if value:
                return normalize_theme(value)
        except Exception:
            pass
        return normalize_theme(self.load_file().get("theme", "dark"))

    def get_glass_effects_enabled(self) -> bool:
        try:
            value = self.get_setting("glass_effects_enabled")
            if value is not None:
                return normalize_glass_effects(value)
        except Exception:
            pass
        data = self.load_file()
        if "glass_effects_enabled" in data:
            return normalize_glass_effects(data["glass_effects_enabled"])
        return True

    def get_saved_accent_color(self) -> str:
        try:
            value = self.get_setting("accent_color")
            if value:
                return normalize_hex_color(value)
        except Exception:
            pass
        return normalize_hex_color(self.load_file().get("accent_color"))

    def get_saved_background_style(self) -> str:
        try:
            value = self.get_setting("background_style")
            if value:
                return normalize_background_style(value)
        except Exception:
            pass
        return normalize_background_style(self.load_file().get("background_style"))

    def get_chroma_accent_enabled(self) -> bool:
        try:
            value = self.get_setting("chroma_accent_enabled")
            if value is not None:
                return normalize_theme_option(value, DEFAULT_CHROMA_ACCENT_ENABLED)
        except Exception:
            pass
        return normalize_theme_option(
            self.load_file().get("chroma_accent_enabled"),
            DEFAULT_CHROMA_ACCENT_ENABLED,
        )

    def get_chroma_accent_speed(self) -> int:
        try:
            value = self.get_setting("chroma_accent_speed")
            if value is not None:
                return normalize_chroma_accent_speed(value)
        except Exception:
            pass
        return normalize_chroma_accent_speed(
            self.load_file().get("chroma_accent_speed")
        )

    def get_glass_quality(self) -> str:
        try:
            value = self.get_setting("glass_quality")
            if value:
                return normalize_glass_quality(value)
        except Exception:
            pass
        return normalize_glass_quality(self.load_file().get("glass_quality"))

    def get_animated_backgrounds_enabled(self) -> bool:
        try:
            value = self.get_setting("animated_backgrounds_enabled")
            if value is not None:
                return normalize_theme_option(
                    value,
                    DEFAULT_ANIMATED_BACKGROUNDS_ENABLED,
                )
        except Exception:
            pass
        return normalize_theme_option(
            self.load_file().get("animated_backgrounds_enabled"),
            DEFAULT_ANIMATED_BACKGROUNDS_ENABLED,
        )

    def get_interface_animations_enabled(self) -> bool:
        try:
            value = self.get_setting("interface_animations_enabled")
            if value is not None:
                return normalize_theme_option(
                    value,
                    DEFAULT_INTERFACE_ANIMATIONS_ENABLED,
                )
        except Exception:
            pass
        return normalize_theme_option(
            self.load_file().get("interface_animations_enabled"),
            DEFAULT_INTERFACE_ANIMATIONS_ENABLED,
        )

    def get_gradients_enabled(self) -> bool:
        try:
            value = self.get_setting("gradients_enabled")
            if value is not None:
                return normalize_theme_option(value, DEFAULT_GRADIENTS_ENABLED)
        except Exception:
            pass
        return normalize_theme_option(
            self.load_file().get("gradients_enabled"),
            DEFAULT_GRADIENTS_ENABLED,
        )

    def save_glass_effects(self, value: object) -> bool:
        enabled = normalize_glass_effects(value)
        self.set_setting("glass_effects_enabled", str(enabled).lower())
        self.save_file(glass_effects_enabled=enabled)
        return enabled

    def save_theme(self, value: object) -> str:
        theme = normalize_theme(value)
        self.set_setting("theme", theme)
        self.save_file(theme=theme)
        return theme

    def get_theme_mode(self) -> str:
        try:
            value = self.get_setting("theme_mode")
            if value:
                return normalize_theme_mode(value)
        except Exception:
            pass
        data = self.load_file()
        if "theme_mode" in data:
            return normalize_theme_mode(data["theme_mode"])
        return self.get_saved_theme()

    def save_theme_mode(self, value: object) -> str:
        mode = normalize_theme_mode(value)
        self.set_setting("theme_mode", mode)
        self.save_file(theme_mode=mode)
        return mode

    def save_accent_color(self, value: object) -> str:
        color = normalize_hex_color(value)
        self.set_setting("accent_color", color)
        self.save_file(accent_color=color)
        return color

    def save_background_style(self, value: object) -> str:
        background = normalize_background_style(value)
        self.set_setting("background_style", background)
        self.save_file(background_style=background)
        return background

    def save_chroma_accent_enabled(self, value: object) -> bool:
        enabled = normalize_theme_option(value, DEFAULT_CHROMA_ACCENT_ENABLED)
        self.set_setting("chroma_accent_enabled", str(enabled).lower())
        self.save_file(chroma_accent_enabled=enabled)
        return enabled

    def save_chroma_accent_speed(self, value: object) -> int:
        speed = normalize_chroma_accent_speed(value)
        self.set_setting("chroma_accent_speed", str(speed))
        self.save_file(chroma_accent_speed=speed)
        return speed

    def save_glass_quality(self, value: object) -> str:
        quality = normalize_glass_quality(value)
        self.set_setting("glass_quality", quality)
        self.save_file(glass_quality=quality)
        return quality

    def save_animated_backgrounds(self, value: object) -> bool:
        enabled = normalize_theme_option(
            value,
            DEFAULT_ANIMATED_BACKGROUNDS_ENABLED,
        )
        self.set_setting("animated_backgrounds_enabled", str(enabled).lower())
        self.save_file(animated_backgrounds_enabled=enabled)
        return enabled

    def save_interface_animations(self, value: object) -> bool:
        enabled = normalize_theme_option(
            value,
            DEFAULT_INTERFACE_ANIMATIONS_ENABLED,
        )
        self.set_setting("interface_animations_enabled", str(enabled).lower())
        self.save_file(interface_animations_enabled=enabled)
        return enabled

    def save_gradients(self, value: object) -> bool:
        enabled = normalize_theme_option(value, DEFAULT_GRADIENTS_ENABLED)
        self.set_setting("gradients_enabled", str(enabled).lower())
        self.save_file(gradients_enabled=enabled)
        return enabled

    def get_hardware_acceleration_enabled(self) -> bool:
        try:
            value = self.get_setting("hardware_acceleration_enabled")
            if value is not None:
                return normalize_theme_option(
                    value,
                    DEFAULT_HARDWARE_ACCELERATION_ENABLED,
                )
        except Exception:
            pass
        return normalize_theme_option(
            self.load_file().get("hardware_acceleration_enabled"),
            DEFAULT_HARDWARE_ACCELERATION_ENABLED,
        )

    def save_hardware_acceleration(self, value: object) -> bool:
        enabled = normalize_theme_option(
            value,
            DEFAULT_HARDWARE_ACCELERATION_ENABLED,
        )
        self.set_setting("hardware_acceleration_enabled", str(enabled).lower())
        self.save_file(hardware_acceleration_enabled=enabled)
        return enabled
