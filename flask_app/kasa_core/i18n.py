"""JSON-backed translation service."""

import json
import os
from collections.abc import Callable
from typing import Any


class TranslationService:
    def __init__(
        self,
        translations_dir: str,
        get_setting: Callable[[str], str | None],
        set_setting: Callable[[str, str], None],
        save_appearance: Callable[..., None],
    ):
        self.translations_dir = translations_dir
        self.get_setting = get_setting
        self.set_setting = set_setting
        self.save_appearance = save_appearance
        self.cache: dict[str, dict] = {}

    def get_available_languages(self) -> list[dict]:
        languages = []
        if not os.path.isdir(self.translations_dir):
            return [{"code": "tr", "name": "Türkçe"}]
        for filename in sorted(os.listdir(self.translations_dir)):
            if not filename.endswith(".json"):
                continue
            code = filename[:-5]
            try:
                with open(
                    os.path.join(self.translations_dir, filename),
                    "r",
                    encoding="utf-8",
                ) as file_handle:
                    data = json.load(file_handle)
                languages.append(
                    {"code": code, "name": data.get("language_name", code)}
                )
            except Exception:
                languages.append({"code": code, "name": code})
        return languages or [{"code": "tr", "name": "Türkçe"}]

    def load_translations(self, language: str) -> dict:
        if not language or not language.replace("-", "").replace("_", "").isalnum():
            language = "tr"
        if language in self.cache:
            return self.cache[language]
        filepath = os.path.join(self.translations_dir, f"{language}.json")
        if os.path.exists(filepath):
            try:
                with open(filepath, "r", encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                self.cache[language] = data
                return data
            except Exception:
                pass
        self.cache[language] = {}
        return {}

    def get_saved_language(self) -> str:
        try:
            value = self.get_setting("language")
            if value:
                return value
        except Exception:
            pass
        return "tr"

    def save_language(self, value: str) -> str:
        requested = value.strip() if value else "tr"
        allowed = {
            item["code"] for item in self.get_available_languages()
        }
        code = requested if requested in allowed else "tr"
        self.set_setting("language", code)
        self.save_appearance(language=code)
        return code

    def translate(self, key: str) -> str:
        language = self.get_saved_language()
        if language == "tr":
            return key
        translations: dict[str, Any] = self.load_translations(language)
        return translations.get(key, key)
