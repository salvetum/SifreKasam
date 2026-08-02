"""Translation coverage tests for user-facing template and JavaScript strings."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TRANSLATION_CALL = re.compile(
    r"""(?<![\w$])_\(\s*(['"])(.*?)\1\s*\)""",
    re.DOTALL,
)
UNICODE_ESCAPE = re.compile(r"\\u([0-9a-fA-F]{4})")


def _decode_javascript_unicode_escapes(value: str) -> str:
    return UNICODE_ESCAPE.sub(
        lambda match: chr(int(match.group(1), 16)),
        value,
    )


class TranslationCoverageTests(unittest.TestCase):
    def test_english_catalog_covers_user_facing_literal_keys(self) -> None:
        files = [
            *sorted((ROOT / "flask_app" / "templates").glob("*.html")),
            ROOT / "flask_app" / "static" / "app.js",
            ROOT / "flask_app" / "static" / "password-generator.js",
            ROOT / "flask_app" / "static" / "toast.js",
            ROOT / "flask_app" / "static" / "reveal-copy.js",
            ROOT / "flask_app" / "static" / "password-strength.js",
            ROOT / "flask_app" / "static" / "custom-controls.js",
            ROOT / "flask_app" / "static" / "lan-settings.js",
            ROOT / "flask_app" / "static" / "modal-system.js",
            ROOT / "flask_app" / "static" / "heartbeat.js",
            ROOT / "flask_app" / "static" / "appearance-settings.js",
            ROOT / "flask_app" / "static" / "vault-index.js",
            ROOT / "flask_app" / "static" / "vault-form.js",
        ]
        used_keys: set[str] = set()
        for path in files:
            source = path.read_text(encoding="utf-8")
            used_keys.update(
                _decode_javascript_unicode_escapes(key)
                for _, key in TRANSLATION_CALL.findall(source)
            )

        english = json.loads(
            (ROOT / "flask_app" / "translations" / "en.json").read_text(
                encoding="utf-8"
            )
        )
        missing = sorted(used_keys - english.keys())

        self.assertEqual(missing, [], f"Missing English translations: {missing}")

    def test_settings_language_change_does_not_restart_login_flow(self) -> None:
        index_template = (
            ROOT / "flask_app" / "templates" / "index.html"
        ).read_text(encoding="utf-8")

        self.assertNotIn("window.location.href = '/loading?lang='", index_template)
        self.assertIn("window.location.reload();", index_template)


if __name__ == "__main__":
    unittest.main()
