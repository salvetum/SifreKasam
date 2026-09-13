"""ŞifreKasam birleşik test paketi.

İçerik:
- Kasa çekirdek servisleri (import/export, sürüm, zaman, görünüm)
- Şifre gücü analizi
- Çeviri kapsamı
- Rota sözleşmeleri
- Güvenlik regresyon testleri
"""

from __future__ import annotations

import io
import json
import os
import re
import stat
import sys
import tempfile
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from flask import Flask

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FLASK_APP_DIR = PROJECT_ROOT / "flask_app"
RUNTIME_DIR = Path(tempfile.mkdtemp(prefix="sifrekasam-tests-"))
os.environ["APPDATA"] = str(RUNTIME_DIR)
os.environ["XDG_CONFIG_HOME"] = str(RUNTIME_DIR)
if str(FLASK_APP_DIR) not in sys.path:
    sys.path.insert(0, str(FLASK_APP_DIR))

import app as app_module  # noqa: E402
import kasa_core.hibp as hibp_module  # noqa: E402
from kasa_core import backgrounds as backgrounds_module  # noqa: E402
from kasa_core import lan_access as lan_access_module  # noqa: E402
from kasa_core import login_lockout  # noqa: E402
from kasa_core import network_policy  # noqa: E402
from kasa_core.paths import ensure_private_data_dir as _ensure_private_data_dir  # noqa: E402
from kasa_core.health_actions import (  # noqa: E402
    find_duplicate_groups,
    generate_strong_password,
    weak_record_problems,
)
from kasa_core.hibp import (  # noqa: E402
    cached_breach_status,
    scan_passwords,
    sha1_hex,
)
from kasa_core.import_export import (  # noqa: E402
    build_export_payload,
    parse_expiry,
    parse_import_payload,
)
from kasa_core.encrypted_backup import (  # noqa: E402
    HEADER_LEN,
    CorruptBackupError,
    InvalidPasswordError,
    build_encrypted_export_payload,
    decrypt_encrypted_records,
    decrypt_payload,
    encrypt_payload,
    generate_backup_password,
)
from kasa_core.password_strength import (  # noqa: E402
    ACCEPTABLE_PASSWORD_SCORE,
    analyze_password,
    normalize_user_inputs,
    password_is_weak,
    score_password,
)
from kasa_core.reports import build_distribution_counts  # noqa: E402
from kasa_core.reports import build_vault_report_payloads  # noqa: E402
from kasa_core.reports import BREACHED_COMMON_PASSWORDS  # noqa: E402
from kasa_core.time_utils import (  # noqa: E402
    utc_iso_timestamp,
    utc_now,
    utc_now_naive,
)
from kasa_core.validation import (
    normalize_chroma_accent_speed,
    normalize_glass_blur,
    normalize_glass_veil,
)  # noqa: E402
from kasa_core.versioning import is_newer_version  # noqa: E402
from brand_icons import BRAND_COLORS, getBrandIcon  # noqa: E402

TRANSLATION_CALL = re.compile(
    r"""(?<![\w$])_\(\s*(['"])(.*?)\1\s*\)""",
    re.DOTALL,
)
UNICODE_ESCAPE = re.compile(r"\\u([0-9a-fA-F]{4})")

EXPECTED_ROUTES = {
    "login": ("/login", {"GET", "POST"}),
    "index": ("/", {"GET"}),
    "ekle_sayfasi": ("/ekle", {"GET", "POST"}),
    "duzenle_sayfasi": ("/duzenle/<kayit_id>", {"GET", "POST"}),
    "sil_kayit": ("/sil/<kayit_id>", {"POST"}),
    "pin_kayit": ("/pin/<kayit_id>", {"POST"}),
    "get_gecmis": ("/gecmis/<kayit_id>", {"GET"}),
    "get_record_password": ("/api/record/<kayit_id>/password", {"GET"}),
    "password_strength": ("/api/password-strength", {"POST"}),
    "api_stats": ("/api/stats", {"GET"}),
    "saglik_raporu": ("/saglik", {"GET"}),
    "breach_scan_start": ("/api/breach/scan", {"POST"}),
    "breach_scan_status": ("/api/breach/scan", {"GET"}),
    "health_duplicates_preview": ("/api/health/duplicates/preview", {"GET"}),
    "health_duplicates_merge": ("/api/health/duplicates/merge", {"POST"}),
    "health_weak_count": ("/api/health/weak/count", {"GET"}),
    "health_rotate_weak": ("/api/health/rotate-weak", {"POST"}),
    "health_backup_now": ("/api/health/backup", {"POST"}),
    "health_export": ("/api/health/export", {"GET"}),
    "save_settings": ("/save_settings", {"POST"}),
    "settings_theme_mode": ("/settings/theme-mode", {"GET", "POST"}),
    "settings_hardware_acceleration": ("/settings/hardware-acceleration", {"GET", "POST"}),
    "settings_runtime": ("/settings/runtime", {"GET"}),
    "export_data": ("/export", {"GET"}),
    "import_data": ("/import", {"POST"}),
    "bulk_delete": ("/api/bulk/delete", {"POST"}),
    "bulk_category": ("/api/bulk/category", {"POST"}),
    "bulk_export": ("/api/bulk/export", {"POST"}),
    "change_password": ("/change-password", {"POST"}),
    "change_password_progress": ("/change-password/progress/<task_id>", {"GET"}),
    "notifications_dismiss": ("/api/notifications/dismiss", {"POST"}),
    "notifications_dismiss_all": ("/api/notifications/dismiss-all", {"POST"}),
    "notifications_reset": ("/api/notifications", {"DELETE"}),
}


def _decode_javascript_unicode_escapes(value: str) -> str:
    return UNICODE_ESCAPE.sub(
        lambda match: chr(int(match.group(1), 16)),
        value,
    )


class ImportExportServiceTests(unittest.TestCase):
    def test_json_and_kasa_payloads_keep_record_data(self) -> None:
        records = [{"title": "Örnek", "password": "gizli"}]

        for export_format in ("json", "kasa"):
            payload, mimetype = build_export_payload(records, export_format)
            parsed = parse_import_payload(
                f"yedek.{export_format}",
                payload.decode("utf-8"),
            )

            self.assertEqual(parsed, records)
            self.assertIn("json", mimetype)

    def test_txt_payload_round_trip_preserves_supported_fields(self) -> None:
        records = [{
            "type": "Website",
            "category": "Genel",
            "title": "ŞifreKasam",
            "website_url": "https://example.com",
            "login": "kullanıcı",
            "email": "kullanici@mail.com",
            "card_holder": "",
            "password": "gizli",
            "comment": "not",
            "expiry_date": "2030-01-02",
        }]

        payload, mimetype = build_export_payload(records, "txt")
        parsed = parse_import_payload("yedek.txt", payload.decode("utf-8"))

        self.assertEqual(parsed, records)
        self.assertEqual(mimetype, "text/plain; charset=utf-8")

    def test_invalid_import_shape_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid-import-payload"):
            parse_import_payload("yedek.json", json.dumps({"title": "tek"}))

    def test_expiry_parser_fails_closed(self) -> None:
        self.assertEqual(parse_expiry("2030-01-02").strftime("%Y-%m-%d"), "2030-01-02")
        self.assertIsNone(parse_expiry("02.01.2030"))
        self.assertIsNone(parse_expiry(None))


class EncryptedBackupTests(unittest.TestCase):
    """Şifreli .kasaenc yedek formatı (AES-256-GCM + scrypt)."""

    PASSWORD = "Rüküş-alfabe-1990!"

    def test_round_trip_preserves_records(self) -> None:
        records = [{
            "type": "Website",
            "title": "Gizli",
            "password": "gerçek-şifre",
            "comment": "not",
        }]
        blob = build_encrypted_export_payload(records, self.PASSWORD)
        self.assertTrue(blob.startswith(b"KASAENC1"))
        self.assertEqual(decrypt_encrypted_records(blob, self.PASSWORD), records)

    def test_same_payload_same_password_unique_blobs(self) -> None:
        records = [{"title": "A", "password": "B"}]
        first = encrypt_payload(
            json.dumps(records, ensure_ascii=False).encode("utf-8"), self.PASSWORD
        )
        second = encrypt_payload(
            json.dumps(records, ensure_ascii=False).encode("utf-8"), self.PASSWORD
        )
        self.assertNotEqual(first, second)  # rastgele salt + nonce

    def test_wrong_password_raises_invalid_password(self) -> None:
        blob = encrypt_payload(b"cok-gizli", self.PASSWORD)
        with self.assertRaises(InvalidPasswordError):
            decrypt_payload(blob, "yanlış-şifre")

    def test_tampered_ciphertext_fails_closed(self) -> None:
        blob = bytearray(encrypt_payload(b"cok-gizli", self.PASSWORD))
        blob[-3] ^= 0xFF  # garbage tag byte
        with self.assertRaises(InvalidPasswordError):
            decrypt_payload(bytes(blob), self.PASSWORD)

    def test_corrupt_header_is_rejected(self) -> None:
        blob = bytearray(encrypt_payload(b"cok-gizli", self.PASSWORD))
        blob[0] = ord("X")  # magic boz
        with self.assertRaises(CorruptBackupError):
            decrypt_payload(bytes(blob), self.PASSWORD)

    def test_truncated_blob_is_rejected(self) -> None:
        minimal = bytes(encrypt_payload(b"cok-gizli", self.PASSWORD))[:HEADER_LEN]
        with self.assertRaises(CorruptBackupError):
            decrypt_payload(minimal, self.PASSWORD)

    def test_invalid_decrypted_json_is_rejected(self) -> None:
        blob = encrypt_payload(b"bu-json-degil", self.PASSWORD)
        with self.assertRaises(CorruptBackupError):
            decrypt_encrypted_records(blob, self.PASSWORD)

    def test_generated_password_is_strong_and_unique(self) -> None:
        first = generate_backup_password()
        second = generate_backup_password()
        self.assertNotEqual(first, second)
        self.assertGreaterEqual(len(first), 20)

    def test_oversized_kdf_n_is_rejected_without_allocating(self) -> None:
        """DoS koruması: başlıktaki aşırı N değeri scrypt çalıştırılmadan reddedilir."""
        from kasa_core.encrypted_backup import HEADER_LEN, MAGIC, VERSION
        huge_n = (1 << 19)  # 128 * 2^19 * 8 = 512 MiB+ → üst sınırı aşar
        header = MAGIC + bytes([VERSION]) + huge_n.to_bytes(4, "big") \
            + (8).to_bytes(4, "big") + (1).to_bytes(4, "big") \
            + b"\x00" * 16 + b"\x00" * 12
        blob = header + b"\x00" * 32
        with self.assertRaises(CorruptBackupError):
            decrypt_payload(blob, self.PASSWORD)

    def test_oversized_kdf_r_is_rejected_without_allocating(self) -> None:
        from kasa_core.encrypted_backup import MAGIC, VERSION
        huge_r = 256
        header = MAGIC + bytes([VERSION]) + (1 << 17).to_bytes(4, "big") \
            + huge_r.to_bytes(4, "big") + (1).to_bytes(4, "big") \
            + b"\x00" * 16 + b"\x00" * 12
        blob = header + b"\x00" * 32
        with self.assertRaises(CorruptBackupError):
            decrypt_payload(blob, self.PASSWORD)


class BrandIconServiceTests(unittest.TestCase):
    """Yerel marka ikon mimarisi: getBrandIcon(title, domain)."""

    BRAND_ICON_DIR = PROJECT_ROOT / "flask_app" / "static" / "brand-icons"

    def test_required_brand_icons_exist_locally(self) -> None:
        requested = {
            "discord", "huggingface", "instagram", "google", "github", "steam",
        }
        present = {p.stem for p in self.BRAND_ICON_DIR.glob("*.svg")}
        missing = sorted(requested - present)
        self.assertEqual(missing, [])

    def test_returns_inline_svg_with_local_brand(self) -> None:
        result = str(getBrandIcon("GitHub", "https://github.com/ankor"))
        self.assertIn('data-brand="github"', result)
        self.assertIn("<svg", result)
        self.assertIn("</svg>", result)
        self.assertIn('fill="currentColor"', result)

    def test_domain_matching_beats_title(self) -> None:
        result = str(getBrandIcon("Herhangi Bir Not", "https://discord.com/channels"))
        self.assertIn('data-brand="discord"', result)

    def test_title_matching_when_domain_is_missing(self) -> None:
        result = str(getBrandIcon("Discord Hesabım", ""))
        self.assertIn('data-brand="discord"', result)

    def test_fallback_returns_generic_lock_for_unmatched(self) -> None:
        result = str(getBrandIcon("Yerel Banka", "https://banka-yerel.example.com"))
        self.assertIn('data-brand="default"', result)
        self.assertNotIn("http", result)

    def test_zero_network_output_contains_no_external_url(self) -> None:
        samples = [
            getBrandIcon("GitHub"),
            getBrandIcon("Google", "mail.google.com"),
            getBrandIcon("Steam", "store.steampowered.com"),
            getBrandIcon("Instagram"),
            getBrandIcon("Hugging Face", "https://huggingface.co/models"),
        ]
        for sample in samples:
            with self.subTest(brand=str(sample)[:40]):
                self.assertNotIn("http://", str(sample))
                self.assertNotIn("https://", str(sample))

    def test_brand_colors_are_mapped(self) -> None:
        for brand in ("discord", "huggingface", "instagram", "google", "github", "steam"):
            with self.subTest(brand=brand):
                self.assertIn(brand, BRAND_COLORS)

    def test_card_grid_uses_brand_helper_without_external_favicon_apis(self) -> None:
        card_template = (
            PROJECT_ROOT / "flask_app" / "templates" / "partials" / "card-grid.html"
        ).read_text(encoding="utf-8")
        self.assertIn("getBrandIcon", card_template)
        for external_ref in ("clearbit", "google.com/s2", "icons.duckduckgo.com", "favicon"):
            self.assertNotIn(external_ref, card_template)

    def test_brand_icon_type_fallback(self) -> None:
        # (a) Markasi olan kayit → marka ikonu (tip argümani yok sayilir).
        result = str(getBrandIcon("GitHub", "https://github.com/ankor", "Website"))
        self.assertIn('data-brand="github"', result)
        self.assertNotIn("type:", result)

        # (b) Markasi yok + record_type "CreditCard" → kart/type ikonu.
        result = str(getBrandIcon("Yerel Banka", "https://banka-yerel.example.com", "CreditCard"))
        self.assertIn('data-brand="type:CreditCard"', result)
        self.assertIn("<svg", result)
        self.assertIn("</svg>", result)

        # (c) Markasi yok + record_type "Website" → dünya/type ikonu.
        result = str(getBrandIcon("Yerel Site", "", "Website"))
        self.assertIn('data-brand="type:Website"', result)

        # (d) Markasi yok + record_type "Application" → masaüstü/type ikonu.
        result = str(getBrandIcon("Yerel Uygulama", "", "Application"))
        self.assertIn('data-brand="type:Application"', result)

        # (e) Markasi yok + record_type "SecureNote" → not/type ikonu.
        result = str(getBrandIcon("Yerel Not", "", "SecureNote"))
        self.assertIn('data-brand="type:SecureNote"', result)

        # (f) Markasi yok + record_type "Other" → default kilit ikonu.
        result = str(getBrandIcon("Yerel Kayit", "", "Other"))
        self.assertIn('data-brand="default"', result)

        # (g) Markasi yok + record_type bos → default kilit ikonu.
        result = str(getBrandIcon("Yerel Kayit", "", ""))
        self.assertIn('data-brand="default"', result)

    def test_brand_icon_two_arg_call_still_works(self) -> None:
        # 2 argümanli çağri (record_type verilmez) eski davranisi sürdürür.
        result = str(getBrandIcon("Yerel Banka", "https://banka-yerel.example.com"))
        self.assertIn('data-brand="default"', result)
        result = str(getBrandIcon("GitHub", "https://github.com/ankor"))
        self.assertIn('data-brand="github"', result)

    def test_default_lock_icon_viewbox_has_top_padding(self) -> None:
        # Kilit ikonunun üstü kesilmesin: viewbox üstte negatif min-y ile baslar.
        result = str(getBrandIcon("Bilinmeyen Kayit", "https://ornek-bilinmeyen.example.com"))
        self.assertIn('viewBox="0 -40 512 552"', result)


class VersioningServiceTests(unittest.TestCase):
    def test_beta_version_compares_by_numeric_release(self) -> None:
        self.assertTrue(is_newer_version("v2.6.0", "2.5.12"))
        self.assertFalse(is_newer_version("v2.5.12", "2.5.12"))


class TimeServiceTests(unittest.TestCase):
    def test_utc_helpers_preserve_storage_compatibility(self) -> None:
        self.assertIs(utc_now().tzinfo, UTC)
        self.assertIsNone(utc_now_naive().tzinfo)
        self.assertRegex(
            utc_iso_timestamp(),
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$",
        )


class AppearanceValidationTests(unittest.TestCase):
    def test_chroma_speed_only_accepts_supported_values(self) -> None:
        self.assertEqual(normalize_chroma_accent_speed(30), 30)
        self.assertEqual(normalize_chroma_accent_speed("8"), 8)
        self.assertEqual(normalize_chroma_accent_speed(12), 15)
        self.assertEqual(normalize_chroma_accent_speed("invalid"), 15)

    def test_glass_blur_is_clamped_between_0_and_1_5(self) -> None:
        self.assertEqual(normalize_glass_blur(1.0), 1.0)
        self.assertEqual(normalize_glass_blur("0.75"), 0.75)
        self.assertEqual(normalize_glass_blur(0), 0.0)
        self.assertEqual(normalize_glass_blur(1.5), 1.5)
        self.assertEqual(normalize_glass_blur(9), 1.5)
        self.assertEqual(normalize_glass_blur(-2), 0.0)

    def test_glass_blur_invalid_inputs_fall_back_to_default(self) -> None:
        self.assertEqual(normalize_glass_blur(None), 1.0)
        self.assertEqual(normalize_glass_blur("abc"), 1.0)
        self.assertEqual(normalize_glass_blur(float("nan")), 1.0)

    def test_glass_veil_is_clamped_between_0_and_2(self) -> None:
        self.assertEqual(normalize_glass_veil(1.0), 1.0)
        self.assertEqual(normalize_glass_veil("1.25"), 1.25)
        self.assertEqual(normalize_glass_veil(0), 0.0)
        self.assertEqual(normalize_glass_veil(2), 2.0)
        self.assertEqual(normalize_glass_veil(5), 2.0)
        self.assertEqual(normalize_glass_veil(-1), 0.0)

    def test_glass_veil_invalid_inputs_fall_back_to_default(self) -> None:
        self.assertEqual(normalize_glass_veil(None), 1.0)
        self.assertEqual(normalize_glass_veil("abc"), 1.0)
        self.assertEqual(normalize_glass_veil(float("nan")), 1.0)


class PasswordStrengthTests(unittest.TestCase):
    def test_common_passwords_remain_weak(self) -> None:
        self.assertLess(analyze_password("password")["score"], ACCEPTABLE_PASSWORD_SCORE)
        self.assertLess(analyze_password("P@ssword1")["score"], ACCEPTABLE_PASSWORD_SCORE)

    def test_long_unpredictable_passwords_are_strong(self) -> None:
        self.assertGreaterEqual(
            analyze_password("J7!vQ2#nL9@xR4$k")["score"],
            ACCEPTABLE_PASSWORD_SCORE,
        )
        self.assertFalse(password_is_weak("correct horse battery staple"))

    def test_short_passwords_cannot_score_as_strong(self) -> None:
        analysis = analyze_password("Aa1!short")

        self.assertLess(analysis["score"], ACCEPTABLE_PASSWORD_SCORE)
        self.assertFalse(analysis["requirements"]["min_length"])
        self.assertIn("min_length", analysis["missing_requirements"])

    def test_character_variety_is_required_for_non_passphrases(self) -> None:
        checks = {
            "OnlyLettersLong": ("number", "symbol"),
            "lowercase123!": ("uppercase",),
            "UPPERCASE123!": ("lowercase",),
            "MixedCaseOnlyLong": ("number", "symbol"),
        }

        for password, missing_requirements in checks.items():
            with self.subTest(password=password):
                analysis = analyze_password(password)
                self.assertLess(analysis["score"], ACCEPTABLE_PASSWORD_SCORE)
                for requirement in missing_requirements:
                    self.assertIn(
                        requirement,
                        analysis["missing_requirements"],
                    )

    def test_all_character_requirements_are_reported(self) -> None:
        analysis = analyze_password("J7!vQ2#nL9@xR4$k")

        self.assertTrue(all(analysis["requirements"].values()))
        self.assertEqual(analysis["missing_requirements"], [])

    def test_record_context_penalizes_related_passwords(self) -> None:
        password = "AcmePortal1!"
        without_context = analyze_password(password)["score"]
        with_context = analyze_password(
            password,
            ["AcmePortal", "https://acme.example", "admin@acme.example"],
        )["score"]

        self.assertGreaterEqual(without_context, ACCEPTABLE_PASSWORD_SCORE)
        self.assertLess(with_context, ACCEPTABLE_PASSWORD_SCORE)

    def test_context_normalization_extracts_domain_and_login_tokens(self) -> None:
        values = normalize_user_inputs([
            "https://vault.example.com/login",
            "kaan@example.com",
        ])
        folded_values = {value.casefold() for value in values}

        self.assertIn("vault.example.com", folded_values)
        self.assertIn("vault", folded_values)
        self.assertIn("kaan", folded_values)
        self.assertIn("example.com", folded_values)

    def test_non_matching_context_never_changes_the_score(self) -> None:
        password = "J7!vQ2#nL9@xR4$k"
        baseline = analyze_password(password)["score"]

        for values in (
            ["AcmePortal", "https://acme.example", "admin@acme.example"],
            ["tamamen alakasız", "x", "1234567890"],
            ["OrnekFirma", "kullanici@ornek.com"],
        ):
            with self.subTest(values=values):
                self.assertEqual(
                    analyze_password(password, values)["score"],
                    baseline,
                )


class TranslationCoverageTests(unittest.TestCase):
    def test_english_catalog_covers_user_facing_literal_keys(self) -> None:
        files = [
            *sorted((PROJECT_ROOT / "flask_app" / "templates").glob("*.html")),
            PROJECT_ROOT / "flask_app" / "static" / "app.js",
            PROJECT_ROOT / "flask_app" / "static" / "password-generator.js",
            PROJECT_ROOT / "flask_app" / "static" / "toast.js",
            PROJECT_ROOT / "flask_app" / "static" / "reveal-copy.js",
            PROJECT_ROOT / "flask_app" / "static" / "password-strength.js",
            PROJECT_ROOT / "flask_app" / "static" / "custom-controls.js",
            PROJECT_ROOT / "flask_app" / "static" / "lan-settings.js",
            PROJECT_ROOT / "flask_app" / "static" / "modal-system.js",
            PROJECT_ROOT / "flask_app" / "static" / "heartbeat.js",
            PROJECT_ROOT / "flask_app" / "static" / "appearance-settings.js",
            PROJECT_ROOT / "flask_app" / "static" / "vault-index.js",
            PROJECT_ROOT / "flask_app" / "static" / "vault-form.js",
        ]
        used_keys: set[str] = set()
        for path in files:
            source = path.read_text(encoding="utf-8")
            used_keys.update(
                _decode_javascript_unicode_escapes(key)
                for _, key in TRANSLATION_CALL.findall(source)
            )

        english = json.loads(
            (PROJECT_ROOT / "flask_app" / "translations" / "en.json").read_text(
                encoding="utf-8"
            )
        )
        missing = sorted(used_keys - english.keys())

        self.assertEqual(missing, [], f"Missing English translations: {missing}")

    def test_settings_language_change_does_not_restart_login_flow(self) -> None:
        templates_dir = PROJECT_ROOT / "flask_app" / "templates"
        index_template = (templates_dir / "index.html").read_text(encoding="utf-8")
        # Dil degisikligi mantigi partial dosyalara tasinabilir; tum sablon
        # agacini birlikte tarayarak yeniden yonlendirme desenini arıyoruz.
        rendered_sources = [index_template] + [
            p.read_text(encoding="utf-8")
            for p in sorted(templates_dir.glob("partials/**/*.html"))
        ]
        combined = "\n".join(rendered_sources)

        self.assertNotIn("window.location.href = '/loading?lang='", combined)
        self.assertIn("window.location.reload();", combined)


class RouteContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = app_module.app.test_client()

    def test_route_paths_and_methods_remain_stable(self) -> None:
        rules = {rule.endpoint: rule for rule in app_module.app.url_map.iter_rules()}

        for endpoint, (path, methods) in EXPECTED_ROUTES.items():
            with self.subTest(endpoint=endpoint):
                self.assertIn(endpoint, rules)
                self.assertEqual(rules[endpoint].rule, path)
                self.assertEqual(rules[endpoint].methods - {"HEAD", "OPTIONS"}, methods)

    def test_public_shell_routes_still_render(self) -> None:
        for path in ("/login", "/loading", "/manifest.json", "/sw.js"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_settings_runtime_reports_desired_and_actual_lan_state(self) -> None:
        with patch.dict(os.environ, {"FLASK_HOST": "0.0.0.0"}):
            response = self.client.get(
                "/settings/runtime",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIsInstance(payload["lan_enabled"], bool)
        self.assertIsInstance(payload["runtime_lan_enabled"], bool)
        self.assertTrue(payload["runtime_lan_enabled"])

    def test_vault_pages_require_authentication(self) -> None:
        for path in ("/", "/api/stats", "/saglik"):
            with self.subTest(path=path):
                response = self.client.get(
                    path,
                    headers={"X-App-Token": app_module.APP_TOKEN},
                )
                self.assertEqual(response.status_code, 302)
                self.assertIn("/login", response.headers["Location"])

    def test_delete_json_request_does_not_render_index_redirect(self) -> None:
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True

        with patch.object(app_module, "backup_database"), \
                patch.object(
                    app_module,
                    "_delete_records_and_history",
                    return_value=1,
                ), \
                patch.object(app_module.db.session, "commit"), \
                patch.object(app_module, "invalidate_vault_report_cache"):
            response = self.client.post(
                "/sil/test-record",
                base_url="https://localhost",
                headers={
                    "X-App-Token": app_module.APP_TOKEN,
                    "Accept": "application/json",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok", "deleted": 1})
        self.assertIsNone(response.location)

    def test_password_strength_endpoint_uses_authenticated_backend_engine(self) -> None:
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True

        response = self.client.post(
            "/api/password-strength",
            base_url="https://localhost",
            headers={"X-App-Token": app_module.APP_TOKEN},
            json={
                "password": "AcmePortal1!",
                "user_inputs": ["AcmePortal"],
            },
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertLess(payload["score"], 3)
        self.assertIn("requirements", payload)
        self.assertIn("missing_requirements", payload)
        self.assertNotIn("password", payload)

    def test_settings_save_must_not_reference_module_local_timer(self) -> None:
        """The settings form save previously crashed with a ReferenceError.

        ``appearanceSaveTimer`` lives inside ``appearance-settings.js`` (an ES
        module) but ``app.js`` referenced it directly after the module split,
        which raised *after* the loading overlay was shown and left it stuck on
        every settings save. The save must use the exported canceller instead.
        """
        app_js = (PROJECT_ROOT / "flask_app" / "static" / "app.js").read_text(encoding="utf-8")
        appearance_js = (PROJECT_ROOT / "flask_app" / "static" / "appearance-settings.js").read_text(encoding="utf-8")

        self.assertNotIn("clearTimeout(appearanceSaveTimer)", app_js)
        self.assertIn("cancelPendingAppearanceSave", app_js)
        self.assertIn("cancelPendingAppearanceSave,", appearance_js)


class ContentSecurityPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = app_module.app.test_client()

    def test_csp_uses_request_nonce_without_unsafe_inline(self) -> None:
        response = self.client.get('/login')
        policy = response.headers.get('Content-Security-Policy', '')
        nonce_match = re.search(r"script-src 'self' 'nonce-([^']+)'", policy)

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("'unsafe-inline'", policy)
        self.assertIsNotNone(nonce_match)
        self.assertIn(f"style-src 'self' 'nonce-{nonce_match.group(1)}'", policy)
        self.assertIn("script-src-attr 'none'", policy)
        self.assertIn("style-src-attr 'none'", policy)

        html = response.get_data(as_text=True)
        nonce_attribute = f'nonce="{nonce_match.group(1)}"'
        self.assertIn('window.LANG', html)
        self.assertIn('window.TRANSLATIONS', html)
        self.assertTrue(all(nonce_attribute in tag for tag in re.findall(r'<script\b[^>]*>', html)))
        self.assertTrue(all(nonce_attribute in tag for tag in re.findall(r'<style\b[^>]*>', html)))

    def test_csp_nonce_changes_for_each_request(self) -> None:
        first = self.client.get('/login').headers['Content-Security-Policy']
        second = self.client.get('/login').headers['Content-Security-Policy']
        first_nonce = re.search(r"'nonce-([^']+)'", first).group(1)
        second_nonce = re.search(r"'nonce-([^']+)'", second).group(1)

        self.assertNotEqual(first_nonce, second_nonce)

    def test_first_setup_guidance_is_rendered_only_for_new_vaults(self) -> None:
        with patch.object(app_module, "_is_first_setup", return_value=True):
            first_setup_html = self.client.get('/login').get_data(as_text=True)
        with patch.object(app_module, "_is_first_setup", return_value=False):
            existing_vault_html = self.client.get('/login').get_data(as_text=True)

        self.assertIn('id="first-setup-guidance"', first_setup_html)
        self.assertNotIn('id="first-setup-guidance"', existing_vault_html)
        self.assertIn('id="master-password-confirm"', first_setup_html)
        self.assertNotIn('id="master-password-confirm"', existing_vault_html)


class StylesheetDependencyTests(unittest.TestCase):
    def test_bootstrap_stylesheet_is_not_bundled_or_referenced(self) -> None:
        self.assertFalse((PROJECT_ROOT / "flask_app" / "static" / "bootstrap.min.css").exists())

        template_text = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (PROJECT_ROOT / "flask_app" / "templates").glob("*")
            if path.is_file()
        )
        self.assertNotIn("bootstrap.min.css", template_text)


class SecurityUnitTests(unittest.TestCase):
    def test_metadata_round_trip_does_not_store_plaintext(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        encrypted = app_module.encrypt_metadata(fernet, "user@example.com")

        self.assertTrue(encrypted.startswith(app_module.RECORD_METADATA_PREFIX))
        self.assertNotIn("user@example.com", encrypted)
        self.assertEqual(app_module.decrypt_metadata(fernet, encrypted), "user@example.com")

    def test_login_backoff_is_exponential_and_capped(self) -> None:
        self.assertEqual(login_lockout.backoff_seconds(4), 0)
        self.assertEqual(login_lockout.backoff_seconds(5), 30)
        self.assertEqual(login_lockout.backoff_seconds(6), 60)
        self.assertEqual(login_lockout.backoff_seconds(10), 960)
        self.assertEqual(login_lockout.backoff_seconds(11), 1800)
        self.assertEqual(login_lockout.backoff_seconds(100), 1800)

    def test_data_directory_permissions_are_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "vault"
            _ensure_private_data_dir(str(path))
            _ensure_private_data_dir(str(path))

            self.assertTrue(path.is_dir())
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)


class MetadataMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.test_app = Flask("security-tests")
        self.test_app.config.update(
            SECRET_KEY="security-tests",
            SQLALCHEMY_DATABASE_URI="sqlite://",
            SQLALCHEMY_TRACK_MODIFICATIONS=False,
        )
        app_module.db.init_app(self.test_app)
        self.app_context = self.test_app.app_context()
        self.app_context.push()
        app_module.db.create_all()
        self.fernet = Fernet(Fernet.generate_key())

    def tearDown(self) -> None:
        app_module.db.drop_all()
        app_module.db.session.remove()
        for engine in app_module.db.engines.values():
            engine.dispose()
        self.app_context.pop()

    def add_plaintext_record(self) -> str:
        record = app_module.Record(
            id="legacy-record",
            type="Website",
            category="Genel",
            title="Example Account",
            website_url="https://example.com",
            login="user@example.com",
            encrypted_password=app_module.safe_encrypt(self.fernet, "secret"),
            encrypted_comment=app_module.safe_encrypt(self.fernet, "note"),
        )
        app_module.db.session.add(record)
        app_module.db.session.commit()
        return record.id

    def test_first_setup_detection_fails_closed_for_existing_vaults(self) -> None:
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False):
            self.assertTrue(app_module._is_first_setup())

        app_module.db.session.add(app_module.Setting(
            key="master_hash",
            value=app_module.hash_master_password("existing-password"),
        ))
        app_module.db.session.commit()
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False):
            self.assertFalse(app_module._is_first_setup())

        app_module.Setting.query.filter_by(key="master_hash").delete()
        app_module.db.session.commit()
        with patch.object(app_module, "_vault_initialized", return_value=True), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False):
            self.assertFalse(app_module._is_first_setup())
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=True):
            self.assertFalse(app_module._is_first_setup())

    def test_vault_marker_is_written_only_after_explicit_finalize(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sifrekasam-marker-") as temp_dir:
            marker_path = Path(temp_dir) / "vault.initialized"
            with patch.object(app_module, "VAULT_INIT_FILE", str(marker_path)):
                app_module._mark_vault_initialized()
                self.assertFalse(marker_path.exists())
                app_module.db.session.commit()
                app_module._write_vault_initialized_marker()

            self.assertTrue(marker_path.exists())
        self.assertEqual(app_module._get_setting("vault_initialized"), "true")

    def test_plaintext_metadata_migration_encrypts_existing_records(self) -> None:
        record_id = self.add_plaintext_record()

        with patch.object(app_module, "backup_database") as backup:
            self.assertTrue(app_module.migrate_plaintext_record_metadata(self.fernet))

        app_module.db.session.expire_all()
        record = app_module.db.session.get(app_module.Record, record_id)
        self.assertGreaterEqual(backup.call_count, 2)
        self.assertEqual(app_module._get_setting(app_module.RECORD_METADATA_SETTING), "true")
        self.assertNotIn("Example Account", record.title)
        self.assertNotIn("example.com", record.website_url)
        self.assertNotIn("user@example.com", record.login)
        self.assertEqual(app_module.decrypt_metadata(self.fernet, record.title), "Example Account")
        self.assertEqual(app_module.decrypt_metadata(self.fernet, record.website_url), "https://example.com")
        self.assertEqual(app_module.decrypt_metadata(self.fernet, record.login), "user@example.com")
        self.assertFalse(app_module.migrate_plaintext_record_metadata(self.fernet))

    def test_metadata_migration_rolls_back_on_encryption_error(self) -> None:
        record_id = self.add_plaintext_record()
        original_encrypt = app_module.encrypt_metadata

        def fail_on_login(fernet: Fernet, value: str) -> str:
            if value == "user@example.com":
                raise RuntimeError("simulated migration failure")
            return original_encrypt(fernet, value)

        with patch.object(app_module, "backup_database"), \
                patch.object(app_module, "encrypt_metadata", side_effect=fail_on_login):
            with self.assertRaises(RuntimeError):
                app_module.migrate_plaintext_record_metadata(self.fernet)

        app_module.db.session.expire_all()
        record = app_module.db.session.get(app_module.Record, record_id)
        self.assertEqual(record.title, "Example Account")
        self.assertEqual(record.website_url, "https://example.com")
        self.assertEqual(record.login, "user@example.com")
        self.assertIsNone(app_module._get_setting(app_module.RECORD_METADATA_SETTING))

    def test_imported_metadata_is_encrypted_immediately(self) -> None:
        record = app_module._parse_import_record({
            "type": "Website",
            "title": "Imported Account",
            "website_url": "https://imported.example",
            "login": "imported-user",
            "password": "secret",
        }, self.fernet)

        self.assertEqual(app_module.decrypt_metadata(self.fernet, record.title), "Imported Account")
        self.assertEqual(app_module.decrypt_metadata(self.fernet, record.website_url), "https://imported.example")
        self.assertEqual(app_module.decrypt_metadata(self.fernet, record.login), "imported-user")

    def test_password_history_skips_consecutive_duplicates(self) -> None:
        record = app_module.Record(
            id="history-record",
            type="Website",
            category="Genel",
            title=app_module.encrypt_metadata(self.fernet, "History Account"),
            encrypted_password=app_module.safe_encrypt(self.fernet, "first-password"),
        )
        app_module.db.session.add(record)
        app_module.db.session.commit()

        self.assertTrue(app_module._append_password_history(
            record.id, record.encrypted_password, self.fernet))
        app_module.db.session.commit()
        self.assertFalse(app_module._append_password_history(
            record.id, record.encrypted_password, self.fernet))
        self.assertEqual(app_module.PasswordHistory.query.filter_by(
            record_id=record.id).count(), 1)

        next_password = app_module.safe_encrypt(self.fernet, "second-password")
        self.assertTrue(app_module._append_password_history(
            record.id, next_password, self.fernet))
        app_module.db.session.commit()
        self.assertEqual(app_module.PasswordHistory.query.filter_by(
            record_id=record.id).count(), 2)

    def test_health_report_uses_context_and_accepts_score_three(self) -> None:
        record = app_module.Record(
            id="strength-record",
            type="Website",
            category="Genel",
            title=app_module.encrypt_metadata(self.fernet, "Acme Portal"),
            website_url=app_module.encrypt_metadata(
                self.fernet,
                "https://acme.example",
            ),
            login=app_module.encrypt_metadata(self.fernet, "admin@acme.example"),
            encrypted_password=app_module.safe_encrypt(
                self.fernet,
                "AcmePortal-2026!",
            ),
        )
        app_module.db.session.add(record)
        app_module.db.session.commit()
        received_inputs = []

        def score_password(password: str, user_inputs: object) -> int:
            received_inputs.extend(user_inputs)
            return 3

        stats, health = build_vault_report_payloads(
            self.fernet,
            score_password,
        )

        self.assertEqual(stats["zayif"], 0)
        self.assertEqual(health["zayif"], [])
        self.assertIn("Acme Portal", received_inputs)
        self.assertIn("https://acme.example", received_inputs)
        self.assertIn("admin@acme.example", received_inputs)

    def test_legacy_salt_migration_preserves_and_encrypts_metadata(self) -> None:
        master_password = "legacy-master-password"
        legacy_fernet = Fernet(app_module._derive_key_with_salt(
            master_password,
            app_module.LEGACY_PBKDF2_SALT,
            app_module.LEGACY_PBKDF2_ITERATIONS,
        ))
        record = app_module.Record(
            id="legacy-salt-record",
            type="Website",
            category="Genel",
            title="Legacy Account",
            website_url="https://legacy.example",
            login="legacy-user",
            encrypted_password=app_module.safe_encrypt(legacy_fernet, "legacy-secret"),
            encrypted_comment=app_module.safe_encrypt(legacy_fernet, "legacy-note"),
        )
        app_module.db.session.add(record)
        app_module.db.session.commit()

        with patch.object(app_module, "backup_database"):
            self.assertTrue(app_module.migrate_legacy_pbkdf2_salt(master_password))

        app_module.db.session.expire_all()
        migrated = app_module.db.session.get(app_module.Record, record.id)
        current_fernet = Fernet(app_module.derive_key(master_password))
        self.assertEqual(app_module.decrypt_metadata(current_fernet, migrated.title), "Legacy Account")
        self.assertEqual(app_module.decrypt_metadata(current_fernet, migrated.website_url), "https://legacy.example")
        self.assertEqual(app_module.decrypt_metadata(current_fernet, migrated.login), "legacy-user")
        self.assertEqual(app_module.safe_decrypt(current_fernet, migrated.encrypted_password), "legacy-secret")


class CustomBackgroundUploadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        self._token = {'X-App-Token': app_module.APP_TOKEN}
        backgrounds_module._upload_log.clear()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True

    def tearDown(self) -> None:
        bg_dir = app_module.BACKGROUND_DIR
        if os.path.isdir(bg_dir):
            for name in os.listdir(bg_dir):
                try:
                    os.unlink(os.path.join(bg_dir, name))
                except OSError:
                    pass
            history_dir = os.path.join(bg_dir, 'history')
            if os.path.isdir(history_dir):
                for name in os.listdir(history_dir):
                    try:
                        os.unlink(os.path.join(history_dir, name))
                    except OSError:
                        pass

    def _make_png(self, size_bytes: int = 100) -> bytes:
        from PIL import Image
        import io as _io
        # Her çağrıda farklı içerik üret: aynı baytların tekrar yüklenmesi
        # artık dedup nedeniyle yeni history kaydı oluşturmaz.
        self._png_seq = getattr(self, '_png_seq', 0) + 1
        img = Image.new('RGB', (4, 4), color=(self._png_seq * 40 % 256, 64, 32))
        buf = _io.BytesIO()
        img.save(buf, format='PNG')
        data = buf.getvalue()
        if size_bytes > len(data):
            data = data + b'\x00' * (size_bytes - len(data))
        return data

    def _make_gif(self) -> bytes:
        from PIL import Image
        import io as _io
        img = Image.new('RGB', (4, 4), color=(128, 64, 32))
        buf = _io.BytesIO()
        img.save(buf, format='GIF')
        return buf.getvalue()

    def test_rejects_non_image_file(self) -> None:
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(b'<script>alert(1)</script>'), 'evil.html'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertIn(response.status_code, (400, 415))
        data = response.get_json()
        self.assertIn('error', data)

    def test_rejects_oversized_image(self) -> None:
        oversized = self._make_png(size_bytes=app_module.CUSTOM_BACKGROUND_MAX_IMAGE_BYTES + 1)
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(oversized), 'big.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertIn('error', data)

    def _make_png_with_size(self, width: int, height: int) -> bytes:
        import struct as _struct
        import zlib as _zlib

        def _chunk(typ: bytes, data: bytes) -> bytes:
            return (_struct.pack('>I', len(data)) + typ + data
                    + _struct.pack('>I', _zlib.crc32(typ + data) & 0xffffffff))

        ihdr = _struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
        idat = _zlib.compress(b'\x00' * 9)
        return (b'\x89PNG\r\n\x1a\n'
                + _chunk(b'IHDR', ihdr)
                + _chunk(b'IDAT', idat)
                + _chunk(b'IEND', b''))

    def test_rejects_oversized_dimension_image(self) -> None:
        huge = self._make_png_with_size(10000, 10000)
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(huge), 'huge.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertIn('error', data)

    def test_limits_upload_rate(self) -> None:
        for _ in range(app_module.CUSTOM_BACKGROUND_UPLOAD_MAX_PER_WINDOW):
            response = self.client.post('/api/background/upload', data={
                'file': (io.BytesIO(self._make_png()), 'ok.png'),
            }, content_type='multipart/form-data', headers=self._token)
            self.assertEqual(response.status_code, 200)
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'ok.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 429)
        data = response.get_json()
        self.assertIn('error', data)

    def test_current_url_is_mtime_versioned(self) -> None:
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'ok.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 200)
        with patch.object(app_module, "get_fernet", return_value=Fernet(Fernet.generate_key())):
            page = self.client.get('/', headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'/api/background/current?v=', page.data)

    def test_background_served_with_private_cache(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'ok.png'),
        }, content_type='multipart/form-data', headers=self._token)
        response = self.client.get('/api/background/current', headers=self._token)
        self.assertEqual(response.status_code, 200)
        cache_control = response.headers.get('Cache-Control', '')
        self.assertIn('private', cache_control)
        self.assertIn('max-age=', cache_control)
        self.assertTrue(response.headers.get('ETag'))

    def test_background_served_with_etag_revalidation(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'ok.png'),
        }, content_type='multipart/form-data', headers=self._token)
        first = self.client.get('/api/background/current', headers=self._token)
        etag = first.headers.get('ETag')
        self.assertTrue(etag)
        second = self.client.get(
            '/api/background/current', headers={**self._token, 'If-None-Match': etag})
        self.assertEqual(second.status_code, 304)

    def test_accepts_valid_webm(self) -> None:
        webm_data = b'\x1a\x45\xdf\xa3' + b'webm-sample-magic-bytes'
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(webm_data), 'anim.webm'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['status'], 'ok')
        self.assertTrue(data.get('is_video'))
        self.assertFalse(data.get('is_gif'))
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertTrue(entries[0]['is_video'])
        self.assertEqual(entries[0]['mime'], 'video/webm')

    def test_accepts_valid_mp4(self) -> None:
        mp4_data = b'\x00\x00\x00\x18ftypisom' + b'\x00\x00\x00\x08free'
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(mp4_data), 'video.mp4'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['status'], 'ok')
        self.assertTrue(data.get('is_video'))

    def test_rejects_fake_video_extension(self) -> None:
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(b'definitely not an mp4 video'), 'fake.mp4'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertIn('error', data)

    def test_accepts_valid_png(self) -> None:
        png_data = self._make_png()
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), 'photo.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['status'], 'ok')
        self.assertIn('url', data)

    def test_accepts_valid_gif(self) -> None:
        gif_data = self._make_gif()
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(gif_data), 'anim.gif'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data.get('is_gif'))

    def test_serves_uploaded_background(self) -> None:
        png_data = self._make_png()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), 'test.png'),
        }, content_type='multipart/form-data', headers=self._token)
        response = self.client.get('/api/background/current', headers=self._token)
        self.assertEqual(response.status_code, 200)

    def test_delete_removes_background(self) -> None:
        png_data = self._make_png()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), 'del.png'),
        }, content_type='multipart/form-data', headers=self._token)
        response = self.client.delete('/api/background', headers=self._token)
        self.assertEqual(response.status_code, 200)
        response = self.client.get('/api/background/current', headers=self._token)
        self.assertEqual(response.status_code, 404)

    def test_upload_rejects_empty_file(self) -> None:
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(b''), ''),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 400)

    def test_filename_is_uuid_not_user_input(self) -> None:
        png_data = self._make_png()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), '../../etc/passwd.png'),
        }, content_type='multipart/form-data', headers=self._token)
        bg_dir = app_module.BACKGROUND_DIR
        if os.path.isdir(bg_dir):
            files = [f for f in os.listdir(bg_dir) if os.path.isfile(os.path.join(bg_dir, f))]
            self.assertTrue(files)
            for name in files:
                self.assertRegex(name, r'^[0-9a-f]{32}\.png$')
                self.assertNotIn('..', name)
                self.assertNotIn('etc', name)

    def test_old_background_removed_on_new_upload(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)
        bg_dir = app_module.BACKGROUND_DIR
        if os.path.isdir(bg_dir):
            files = [f for f in os.listdir(bg_dir) if os.path.isfile(os.path.join(bg_dir, f))]
            self.assertEqual(len(files), 1)

    def test_rejects_text_content_with_png_extension(self) -> None:
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(b'This is plain text, not an image.'), 'fake.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertIn('error', data)

    def test_unauthorized_upload_without_token(self) -> None:
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'test.png'),
        }, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 403)

    def test_unauthorized_delete_without_token(self) -> None:
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.delete('/api/background')
        self.assertEqual(response.status_code, 403)

    def test_serve_without_token_allowed_locally(self) -> None:
        # Aktif arka plan medyası login ekranında bile yüklenir; yerel oturumsuz
        # istekler auth'sız erişebilir. Örnek yoksa 404 döner (403 auth bloğu değil).
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.get('/api/background/current')
        self.assertEqual(response.status_code, 404)

    def test_serve_background_lan_requires_auth(self) -> None:
        with app_module.app.app_context():
            previous = app_module._get_setting('lan_enabled')
            app_module._set_setting('lan_enabled', 'true')
            app_module.db.session.commit()
        try:
            lan_client = app_module.app.test_client()
            response = lan_client.get(
                '/api/background/current',
                environ_base={'REMOTE_ADDR': '192.168.1.50'},
            )
            self.assertEqual(response.status_code, 302)
            self.assertIn('/login', response.headers.get('Location', ''))
        finally:
            with app_module.app.app_context():
                app_module._set_setting('lan_enabled', previous)
                app_module.db.session.commit()

    def test_serve_background_remote_forbidden_when_lan_off(self) -> None:
        with app_module.app.app_context():
            previous = app_module._get_setting('lan_enabled')
            app_module._set_setting('lan_enabled', 'false')
            app_module.db.session.commit()
        try:
            remote_client = app_module.app.test_client()
            response = remote_client.get(
                '/api/background/current',
                environ_base={'REMOTE_ADDR': '192.168.1.90'},
            )
            self.assertEqual(response.status_code, 403)
        finally:
            with app_module.app.app_context():
                app_module._set_setting('lan_enabled', previous)
                app_module.db.session.commit()

    def test_token_without_session_redirects_to_login(self) -> None:
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'test.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 302)
        self.assertIn('/login', response.headers.get('Location', ''))

    def test_custom_background_endpoints_not_in_public_endpoints(self) -> None:
        public = app_module._PUBLIC_ENDPOINTS
        self.assertNotIn('upload_custom_background', public)
        self.assertNotIn('delete_custom_background', public)
        self.assertNotIn('delete_custom_background_all', public)
        self.assertNotIn('serve_custom_background', public)

    def test_custom_background_endpoints_not_in_token_endpoints(self) -> None:
        token_eps = app_module._TOKEN_ENDPOINTS
        self.assertNotIn('upload_custom_background', token_eps)
        self.assertNotIn('delete_custom_background', token_eps)
        self.assertNotIn('delete_custom_background_all', token_eps)
        self.assertNotIn('serve_custom_background', token_eps)

    def test_upload_atomically_sets_background_style_to_custom(self) -> None:
        png_data = self._make_png()
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), 'atom.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(app_module.get_saved_background_style(), 'custom')

    def test_history_list_empty_by_default(self) -> None:
        response = self.client.get('/api/background/history', headers=self._token)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['entries'], [])

    def test_history_serve_rejects_non_uuid_name(self) -> None:
        for name in ('not-a-real-name.png', '..%2F..%2Fetc%2Fpasswd', '', '12345.png'):
            response = self.client.get(
                f'/api/background/history/{name}', headers=self._token
            )
            self.assertEqual(response.status_code, 404, name)

    def test_history_activate_rejects_invalid_id(self) -> None:
        response = self.client.post(
            '/api/background/history/../activate', headers=self._token
        )
        self.assertEqual(response.status_code, 404)
        response = self.client.post(
            '/api/background/history/missing.png/activate', headers=self._token
        )
        self.assertEqual(response.status_code, 404)

    def test_history_delete_rejects_invalid_id(self) -> None:
        response = self.client.delete(
            '/api/background/history/../', headers=self._token
        )
        self.assertEqual(response.status_code, 404)
        response = self.client.delete(
            '/api/background/history/missing.png', headers=self._token
        )
        self.assertEqual(response.status_code, 404)

    def test_history_endpoints_not_in_public_endpoints(self) -> None:
        public = app_module._PUBLIC_ENDPOINTS
        self.assertNotIn('list_custom_background_history', public)
        self.assertNotIn('serve_history_background', public)
        self.assertNotIn('activate_history_background', public)
        self.assertNotIn('delete_history_background', public)

    def test_history_endpoints_not_in_token_endpoints(self) -> None:
        token_eps = app_module._TOKEN_ENDPOINTS
        self.assertNotIn('list_custom_background_history', token_eps)
        self.assertNotIn('serve_history_background', token_eps)
        self.assertNotIn('activate_history_background', token_eps)
        self.assertNotIn('delete_history_background', token_eps)

    def _current_background_id(self):
        if not os.path.isdir(app_module.BACKGROUND_DIR):
            return None
        for name in os.listdir(app_module.BACKGROUND_DIR):
            if app_module._safe_background_filename(name):
                return name
        return None

    def test_new_upload_moves_previous_into_history(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        first_id = self._current_background_id()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)
        second_id = self._current_background_id()
        bg_dir = app_module.BACKGROUND_DIR
        root_files = [f for f in os.listdir(bg_dir) if os.path.isfile(os.path.join(bg_dir, f))]
        self.assertEqual(len(root_files), 1)
        response = self.client.get('/api/background/history', headers=self._token)
        self.assertEqual(response.status_code, 200)
        entries = response.get_json()['entries']
        self.assertEqual(len(entries), 2)
        self.assertTrue(entries[0]['is_active'])
        self.assertEqual(entries[0]['id'], second_id)
        self.assertFalse(entries[1]['is_active'])
        self.assertEqual(entries[1]['id'], first_id)

    def test_activate_history_background_becomes_current(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        first_id = self._current_background_id()
        self.assertIsNotNone(first_id)
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertNotEqual(self._current_background_id(), first_id)

        response = self.client.post(
            f'/api/background/history/{first_id}/activate', headers=self._token
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._current_background_id(), first_id)
        self.assertEqual(app_module.get_saved_background_style(), 'custom')
        serve = self.client.get('/api/background/current', headers=self._token)
        self.assertEqual(serve.status_code, 200)

    def test_delete_history_background_removes_entry(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        first_id = self._current_background_id()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)
        second_id = self._current_background_id()

        response = self.client.delete(
            f'/api/background/history/{first_id}', headers=self._token
        )
        self.assertEqual(response.status_code, 200)
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(len(entries), 1)
        self.assertTrue(entries[0]['is_active'])
        self.assertEqual(entries[0]['id'], second_id)
        self.assertEqual(self._current_background_id(), second_id)

    def test_delete_active_background_keeps_history(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        first_id = self._current_background_id()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)
        second_id = self._current_background_id()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'third.png'),
        }, content_type='multipart/form-data', headers=self._token)
        third_id = self._current_background_id()

        response = self.client.delete('/api/background', headers=self._token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.client.get('/api/background/current', headers=self._token).status_code,
            404,
        )
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(len(entries), 2)
        self.assertFalse(entries[0]['is_active'])
        self.assertEqual(entries[0]['id'], second_id)
        self.assertFalse(entries[1]['is_active'])
        self.assertEqual(entries[1]['id'], first_id)
        self.assertNotIn(third_id, [entry['id'] for entry in entries])
        self.assertEqual(app_module.get_saved_background_style(), 'aurora')

    def test_delete_all_backgrounds_clears_history_too(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)

        response = self.client.delete('/api/background/all', headers=self._token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.client.get('/api/background/current', headers=self._token).status_code,
            404,
        )
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(entries, [])
        self.assertEqual(app_module.get_saved_background_style(), 'aurora')

    def test_delete_all_backgrounds_requires_auth(self) -> None:
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.delete('/api/background/all')
        self.assertEqual(response.status_code, 403)

    def test_history_reports_gif_flag(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_gif()), 'anim.gif'),
        }, content_type='multipart/form-data', headers=self._token)
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'photo.png'),
        }, content_type='multipart/form-data', headers=self._token)
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(len(entries), 2)
        self.assertTrue(entries[0]['is_active'])
        self.assertFalse(entries[0]['is_gif'])
        self.assertFalse(entries[1]['is_active'])
        self.assertTrue(entries[1]['is_gif'])

    def test_history_reports_metadata_fields(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(len(entries), 1)
        active = entries[0]
        self.assertTrue(active['is_active'])
        self.assertEqual(active['mime'], 'image/png')
        self.assertEqual(active['width'], 4)
        self.assertEqual(active['height'], 4)
        self.assertGreater(active['size'], 0)

    def test_reuploading_same_image_does_not_duplicate_history(self) -> None:
        png_data = self._make_png()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        first_id = self._current_background_id()
        self.assertIsNotNone(first_id)
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 200)
        # Aynı içerik: yeni history kaydı oluşmaz, aktif dosya değişmez.
        self.assertEqual(self._current_background_id(), first_id)
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(len(entries), 1)
        self.assertTrue(entries[0]['is_active'])
        self.assertEqual(entries[0]['id'], first_id)

    def test_reuploading_history_image_reactivates_it(self) -> None:
        png_data = self._make_png()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        first_id = self._current_background_id()
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)
        second_id = self._current_background_id()
        self.assertNotEqual(first_id, second_id)
        # İlk görseli tekrar yükle: history'deki kayıt aktifleşir, yeni kayıt oluşmaz.
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(png_data), 'first-again.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._current_background_id(), first_id)
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(len(entries), 2)
        self.assertTrue(entries[0]['is_active'])
        self.assertEqual(entries[0]['id'], first_id)
        self.assertFalse(entries[1]['is_active'])
        self.assertEqual(entries[1]['id'], second_id)


class CsrfAndPasswordStrengthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = app_module.app.test_client()

    def _extract_csrf_token(self, html: str) -> str:
        match = re.search(r'name="csrf_token" value="([^"]+)"', html)
        self.assertIsNotNone(match)
        return match.group(1)

    def test_login_page_injects_csrf_token(self) -> None:
        html = self.client.get('/login').get_data(as_text=True)
        self.assertIn('name="csrf_token"', html)
        self.assertIn('window.KASA_CSRF_TOKEN', html)

    def test_login_post_rejects_wrong_csrf_token(self) -> None:
        self.client.get('/login')
        response = self.client.post('/login', data={
            'master_password': 'ignored', 'csrf_token': 'forged-token',
        })
        self.assertEqual(response.status_code, 400)

    def test_login_post_rejects_missing_csrf_token(self) -> None:
        self.client.get('/login')
        response = self.client.post('/login', data={'master_password': 'ignored'})
        self.assertEqual(response.status_code, 400)

    def test_first_setup_accepts_weak_master_password(self) -> None:
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False):
            token = self._extract_csrf_token(
                self.client.get('/login').get_data(as_text=True)
            )
            response = self.client.post('/login', data={
                'master_password': '1234567890123456',
                'master_password_confirm': '1234567890123456',
                'csrf_token': token,
            })
        self.assertEqual(response.status_code, 302)
        with app_module.app.app_context():
            app_module.Setting.query.filter_by(key='master_hash').delete()
            app_module.Setting.query.filter_by(key='pbkdf2_salt_b64').delete()
            app_module.Setting.query.filter_by(key='record_metadata_encryption_v1').delete()
            app_module.Setting.query.filter_by(key='vault_initialized').delete()
            app_module.db.session.commit()
        if os.path.exists(app_module.VAULT_INIT_FILE):
            os.remove(app_module.VAULT_INIT_FILE)

    def test_first_setup_requires_matching_confirm(self) -> None:
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False):
            token = self._extract_csrf_token(
                self.client.get('/login').get_data(as_text=True)
            )
            response = self.client.post('/login', data={
                'master_password': '1234567890123456',
                'master_password_confirm': '1234567890123457',
                'csrf_token': token,
            })
        self.assertEqual(response.status_code, 400)
        self.assertIn('eşleşmiyor', response.get_data(as_text=True))

    def test_first_setup_requires_confirm(self) -> None:
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False):
            token = self._extract_csrf_token(
                self.client.get('/login').get_data(as_text=True)
            )
            response = self.client.post('/login', data={
                'master_password': '1234567890123456',
                'csrf_token': token,
            })
        self.assertEqual(response.status_code, 400)
        self.assertIn('eşleşmiyor', response.get_data(as_text=True))

    def test_change_password_rejects_weak_new_password(self) -> None:
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        response = self.client.post('/change-password', data={
            'old_password': 'whatever',
            'new_password': '1234567890123456',
        }, headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(response.status_code, 400)
        self.assertIn('çok zayıf', response.get_json()['error'])


class LanAccessPasswordTests(unittest.TestCase):
    """LAN erişim şifresi: master şifre ağa gönderilmez, sarma/çözme doğrulanır."""

    MASTER = 'test-master-password'

    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        login_lockout._login_attempts.clear()
        self._reset_vault_state()

    def tearDown(self) -> None:
        login_lockout._login_attempts.clear()
        self._reset_vault_state()

    @classmethod
    def _reset_vault_state(cls) -> None:
        with app_module.app.app_context():
            for key in ('master_hash', 'pbkdf2_salt_b64', 'vault_initialized',
                        'lan_enabled'):
                app_module.Setting.query.filter_by(key=key).delete()
            app_module._clear_lan_access_settings()
            app_module.db.session.commit()
            if os.path.exists(app_module.VAULT_INIT_FILE):
                os.remove(app_module.VAULT_INIT_FILE)

    @classmethod
    def _seed_vault(cls) -> None:
        with app_module.app.app_context():
            app_module.db.session.add(app_module.Setting(
                key='master_hash',
                value=app_module.hash_master_password(cls.MASTER),
            ))
            app_module.db.session.add(app_module.Setting(
                key='pbkdf2_salt_b64', value=app_module._new_salt_b64()))
            app_module.db.session.add(app_module.Setting(
                key='vault_initialized', value='true'))
            app_module.db.session.commit()

    @staticmethod
    def _extract_csrf(html: str) -> str:
        match = re.search(r'name="csrf_token" value="([^"]+)"', html)
        assert match is not None
        return match.group(1)

    def _local_login(self) -> None:
        token = self._extract_csrf(self.client.get('/login').get_data(as_text=True))
        response = self.client.post('/login', data={
            'master_password': self.MASTER,
            'csrf_token': token,
        })
        self.assertEqual(response.status_code, 302)

    def _enable_lan(self) -> None:
        response = self.client.post(
            '/save_settings', data={'lan_enabled': '1'},
            headers={
                'X-App-Token': app_module.APP_TOKEN,
                'X-Requested-With': 'XMLHttpRequest',
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['lan_enabled'], True)

    def _lan_password(self) -> str:
        data = self.client.get(
            '/api/lan-info', headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        self.assertIn('lan_password', data)
        return data['lan_password']

    def _lan_login(self, password: str, remote: str = '192.168.1.50'):
        lan_client = app_module.app.test_client()
        token = self._extract_csrf(lan_client.get(
            '/login', environ_base={'REMOTE_ADDR': remote}).get_data(as_text=True))
        response = lan_client.post(
            '/login',
            data={'master_password': password, 'csrf_token': token},
            environ_base={'REMOTE_ADDR': remote},
        )
        return lan_client, response

    def test_enabling_lan_creates_access_setup_and_returns_password(self) -> None:
        self._seed_vault()
        self._local_login()
        self._enable_lan()

        with app_module.app.app_context():
            self.assertTrue(app_module._get_setting('lan_access_hash'))
            self.assertTrue(app_module._get_setting('lan_vault_wrap'))
            self.assertTrue(app_module._get_setting('lan_access_secret'))
            self.assertEqual(app_module._get_setting('lan_enabled'), 'true')

        lan_password = self._lan_password()
        self.assertTrue(lan_password)
        self.assertTrue(set(lan_password) <= set(lan_access_module.LAN_PASSWORD_ALPHABET))

    def test_lan_login_with_lan_access_password(self) -> None:
        self._seed_vault()
        self._local_login()
        self._enable_lan()
        lan_password = self._lan_password()

        lan_client, response = self._lan_login(lan_password)
        self.assertEqual(response.status_code, 302)
        self.assertIn('/', response.headers['Location'])
        index_response = lan_client.get(
            '/', environ_base={'REMOTE_ADDR': '192.168.1.50'},
        )
        self.assertEqual(index_response.status_code, 200)

    def test_lan_login_rejects_master_password(self) -> None:
        self._seed_vault()
        self._local_login()
        self._enable_lan()

        _, response = self._lan_login(self.MASTER, remote='192.168.1.60')
        self.assertEqual(response.status_code, 401)
        self.assertIn('LAN erişim şifresi', response.get_data(as_text=True))

    def test_lan_info_omits_password_without_local_vault_key(self) -> None:
        self._seed_vault()
        self._local_login()
        self._enable_lan()

        fresh = app_module.app.test_client()
        data = fresh.get(
            '/api/lan-info', headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        self.assertTrue(data['lan_access_configured'])
        self.assertNotIn('lan_password', data)

    def test_disabling_lan_clears_access_and_reenabling_rotates(self) -> None:
        self._seed_vault()
        self._local_login()
        self._enable_lan()
        first = self._lan_password()

        response = self.client.post(
            '/save_settings', data={'lan_enabled': ''},
            headers={
                'X-App-Token': app_module.APP_TOKEN,
                'X-Requested-With': 'XMLHttpRequest',
            },
        )
        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            self.assertFalse(app_module._get_setting('lan_access_hash'))
            self.assertEqual(app_module._get_setting('lan_enabled'), 'false')

        self._enable_lan()
        second = self._lan_password()
        self.assertNotEqual(first, second)

    def test_lan_client_cannot_run_first_setup(self) -> None:
        with patch.object(app_module, '_is_first_setup', return_value=True):
            with app_module.app.app_context():
                app_module._set_setting('lan_enabled', 'true')
                app_module.db.session.commit()
            lan_client = app_module.app.test_client()
            token = self._extract_csrf(lan_client.get(
                '/login', environ_base={'REMOTE_ADDR': '192.168.1.70'},
            ).get_data(as_text=True))
            response = lan_client.post(
                '/login',
                data={
                    'master_password': 'some-new-master-password',
                    'master_password_confirm': 'some-new-master-password',
                    'csrf_token': token,
                },
                environ_base={'REMOTE_ADDR': '192.168.1.70'},
            )
        self.assertEqual(response.status_code, 403)
        self.assertIn('bu bilgisayardan', response.get_data(as_text=True))

    def test_master_password_change_refreshes_lan_bindings(self) -> None:
        self._seed_vault()
        self._local_login()
        self._enable_lan()
        lan_password = self._lan_password()

        with app_module.app.app_context():
            old_key = app_module.derive_key(self.MASTER)
            new_key = app_module.derive_key('new-master-password-2')
            app_module._refresh_lan_access_bindings(old_key, new_key)
            self.assertEqual(app_module._unwrap_lan_vault_key(lan_password), new_key)
            self.assertIsNone(app_module._get_lan_access_password(old_key))
            self.assertEqual(
                app_module._get_lan_access_password(new_key), lan_password,
            )


class HardwareAccelerationSettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True

    def test_index_renders_hardware_acceleration_toggle(self) -> None:
        with patch.object(app_module, "get_fernet", return_value=Fernet(Fernet.generate_key())):
            response = self.client.get('/', headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('id="hardware-acceleration-toggle"', html)
        self.assertIn('name="hardware_acceleration_enabled"', html)

    def test_index_renders_power_save_toggle(self) -> None:
        with patch.object(app_module, "get_fernet", return_value=Fernet(Fernet.generate_key())):
            response = self.client.get('/', headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('id="power-save-toggle"', html)
        self.assertIn('name="power_save_enabled"', html)

    def test_settings_endpoint_round_trip(self) -> None:
        response = self.client.post(
            '/settings/hardware-acceleration',
            json={'hardware_acceleration_enabled': False},
            headers={'X-App-Token': app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(app_module.get_hardware_acceleration_enabled())
        data = self.client.get(
            '/settings/hardware-acceleration',
            headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        self.assertFalse(data['hardware_acceleration_enabled'])

    def test_appearance_endpoint_persists_glass_scales(self) -> None:
        response = self.client.post(
            '/settings/appearance',
            json={'glass_blur': 0.5, 'glass_veil': 1.25},
            headers={'X-App-Token': app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(app_module.get_glass_blur(), 0.5)
        self.assertEqual(app_module.get_glass_veil(), 1.25)

        data = self.client.get(
            '/settings/appearance',
            headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        self.assertEqual(data['glass_blur'], 0.5)
        self.assertEqual(data['glass_veil'], 1.25)

    def test_save_settings_persists_glass_scales(self) -> None:
        response = self.client.post('/save_settings', data={
            'glass_blur': '40',
            'glass_veil': '90',
        }, headers={
            'X-App-Token': app_module.APP_TOKEN,
            'X-Requested-With': 'XMLHttpRequest',
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['glass_blur'], 0.4)
        self.assertEqual(data['glass_veil'], 0.9)
        self.assertEqual(app_module.get_glass_blur(), 0.4)
        self.assertEqual(app_module.get_glass_veil(), 0.9)

    def test_save_settings_glass_scale_zero_is_preserved(self) -> None:
        response = self.client.post('/save_settings', data={
            'glass_blur': '0',
            'glass_veil': '0',
        }, headers={
            'X-App-Token': app_module.APP_TOKEN,
            'X-Requested-With': 'XMLHttpRequest',
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['glass_blur'], 0.0)
        self.assertEqual(data['glass_veil'], 0.0)
        self.assertEqual(app_module.get_glass_blur(), 0.0)
        self.assertEqual(app_module.get_glass_veil(), 0.0)

    def test_save_settings_glass_scale_clamps_to_max(self) -> None:
        response = self.client.post('/save_settings', data={
            'glass_blur': '150',
            'glass_veil': '200',
        }, headers={
            'X-App-Token': app_module.APP_TOKEN,
            'X-Requested-With': 'XMLHttpRequest',
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['glass_blur'], 1.5)
        self.assertEqual(data['glass_veil'], 2.0)
        self.assertEqual(app_module.get_glass_blur(), 1.5)
        self.assertEqual(app_module.get_glass_veil(), 2.0)

    def test_save_settings_persists_hardware_acceleration(self) -> None:
        response = self.client.post('/save_settings', data={
            'auto_lock_timeout': '5',
        }, headers={
            'X-App-Token': app_module.APP_TOKEN,
            'X-Requested-With': 'XMLHttpRequest',
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertFalse(data['hardware_acceleration_enabled'])
        self.assertFalse(app_module.get_hardware_acceleration_enabled())

        response = self.client.post('/save_settings', data={
            'hardware_acceleration_enabled': 'on',
            'auto_lock_timeout': '5',
        }, headers={
            'X-App-Token': app_module.APP_TOKEN,
            'X-Requested-With': 'XMLHttpRequest',
        })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(app_module.get_hardware_acceleration_enabled())

    def test_settings_endpoint_reports_boolean(self) -> None:
        data = self.client.get(
            '/settings/hardware-acceleration',
            headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        self.assertIn('hardware_acceleration_enabled', data)
        self.assertIsInstance(data['hardware_acceleration_enabled'], bool)

    def test_save_settings_persists_power_save(self) -> None:
        response = self.client.post('/save_settings', data={
            'auto_lock_timeout': '5',
        }, headers={
            'X-App-Token': app_module.APP_TOKEN,
            'X-Requested-With': 'XMLHttpRequest',
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertIn('power_save_enabled', data)
        self.assertFalse(data['power_save_enabled'])
        self.assertFalse(app_module.get_power_save_enabled())

        response = self.client.post('/save_settings', data={
            'power_save_enabled': 'on',
            'auto_lock_timeout': '5',
        }, headers={
            'X-App-Token': app_module.APP_TOKEN,
            'X-Requested-With': 'XMLHttpRequest',
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['power_save_enabled'])
        self.assertTrue(app_module.get_power_save_enabled())

    def test_appearance_endpoint_persists_power_save(self) -> None:
        response = self.client.post(
            '/settings/appearance',
            json={'power_save_enabled': False},
            headers={'X-App-Token': app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(app_module.get_power_save_enabled())
        data = self.client.get(
            '/settings/appearance',
            headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        self.assertFalse(data['power_save_enabled'])

        response = self.client.post(
            '/settings/appearance',
            json={'power_save_enabled': True},
            headers={'X-App-Token': app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertIn('power_save_enabled', data)
        self.assertTrue(data['power_save_enabled'])
        self.assertTrue(app_module.get_power_save_enabled())


class RecordFormTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True

    def test_add_form_renders_username_email_and_password_fields(self) -> None:
        response = self.client.get(
            '/ekle',
            headers={'X-App-Token': app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('name="login"', html)
        self.assertIn('id="login_group"', html)
        self.assertIn('name="email"', html)
        self.assertIn('id="email_group"', html)
        self.assertIn('name="password"', html)
        self.assertIn('id="password_group"', html)

    def test_add_record_persists_username_email_and_password(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        with patch.object(app_module, "backup_database"), \
                patch.object(app_module, "invalidate_vault_report_cache"), \
                patch.object(app_module, "get_fernet", return_value=fernet):
            response = self.client.post(
                '/ekle',
                data={
                    'kayit_tipi': 'Website',
                    'kategori': 'Genel',
                    'isim': 'Example Site',
                    'website_url': 'https://example.com',
                    'login': 'kullanici',
                    'email': 'kullanici@mail.com',
                    'password': 's3cret',
                    'comment': '',
                    'expiry_date': '',
                },
                headers={'X-App-Token': app_module.APP_TOKEN},
            )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers['Location'].endswith('/'), True)
        with app_module.app.app_context():
            record = next(
                (r for r in app_module.Record.query.filter_by(type='Website')
                 if app_module.decrypt_metadata(fernet, r.login) == "kullanici"),
                None,
            )
            self.assertIsNotNone(record)
            self.assertEqual(
                app_module.decrypt_metadata(fernet, record.email),
                "kullanici@mail.com",
            )

    def test_index_card_shows_email_detail(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        record = app_module.Record(
            id="email-card-record",
            type="Website",
            category="Genel",
            title=app_module.encrypt_metadata(fernet, "Example Site"),
            website_url=app_module.encrypt_metadata(fernet, "https://example.com"),
            login=app_module.encrypt_metadata(fernet, "kullanici"),
            email=app_module.encrypt_metadata(fernet, "kullanici@mail.com"),
            encrypted_password=app_module.safe_encrypt(fernet, "s3cret"),
        )
        with app_module.app.app_context():
            app_module.db.session.add(record)
            app_module.db.session.commit()

        with patch.object(app_module, "get_fernet", return_value=fernet):
            response = self.client.get(
                '/',
                headers={'X-App-Token': app_module.APP_TOKEN},
            )

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('E-posta', html)
        self.assertIn('kullanici@mail.com', html)


class CardAndStatsUiTemplateTests(unittest.TestCase):
    """Kart tasarımı + istatistik filtresi batch: şablon/asset/çeviri regresyonları."""

    PARTIALS = FLASK_APP_DIR / "templates" / "partials"

    def _read(self, name: str) -> str:
        return (self.PARTIALS / name).read_text(encoding="utf-8")

    def test_card_grid_has_stats_and_category_ui(self) -> None:
        html = self._read("card-grid.html")
        self.assertIn('data-id="{{ kayit.id }}"', html)
        self.assertIn("card-category-badge", html)
        self.assertIn("fa-tag", html)
        self.assertIn("card-weak-chip", html)
        self.assertIn("fa-triangle-exclamation", html)
        self.assertIn("vault-value-ellipsis", html)
        for icon in ("fa-key", "fa-globe", "fa-user", "fa-envelope",
                     "fa-credit-card", "fa-note-sticky"):
            self.assertIn(icon, html)

    def test_category_detail_row_replaced_by_badge(self) -> None:
        html = self._read("card-grid.html")
        self.assertIn("Kategori satırı gizli", html)
        # Eski detay satırı render'ı kalmamalı (badge, header içinde)
        self.assertNotIn('{% elif anahtar == \'Kategori\' %}\n                        <div class="vault-detail-row">', html)

    def test_header_bar_stats_filter_chips(self) -> None:
        html = self._read("dashboard-bar.html")
        self.assertIn('class="stats-filter-chip"', html)
        for value in ("all", "favorites", "zayif", "eski", "expired"):
            self.assertIn(f'data-stat-filter="{value}"', html)
        # İstatistik chip'leri anasayfa barına taşındı; navbar artık küresel
        self.assertNotIn("stats-filter-chip", self._read("dashboard-bar.html") and "")
        base = (FLASK_APP_DIR / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertNotIn("stats-filter-chip", base)

    def test_health_report_ui_has_donut_breach_and_actions(self) -> None:
        saglik = (FLASK_APP_DIR / "templates" / "saglik.html").read_text(encoding="utf-8")
        self.assertIn('id="health-donut"', saglik)
        self.assertIn('id="health-score-pct"', saglik)
        self.assertIn("conic-gradient", saglik)
        self.assertIn("Genel Güvenlik Skoru", saglik)
        self.assertIn("data-z=\"{{ dagitim.zayif }}\"", saglik)
        self.assertIn("data-s=\"{{ dagitim.guvenli }}\"", saglik)
        # 2) Hızlı aksiyon butonları + getBrandIcon entegrasyonu
        self.assertIn("sr-quick-action", saglik)
        self.assertIn("url_for('index', filtre='zayif')", saglik)
        self.assertIn("url_for('index', filtre='eski')", saglik)
        self.assertIn('id="reuse-toggle"', saglik)
        self.assertIn("getBrandIcon(item.title, item.url)", saglik)
        # 3) 5. kart: Sızdırılmış Şifreler (violet)
        self.assertIn('id="count-sizinti"', saglik)
        self.assertIn("sr-tone-violet", saglik)
        self.assertIn("c-violet", saglik)
        # 4) Eski halka/eski lejant kaldırıldı
        self.assertNotIn("sr-score-ring", saglik)
        self.assertNotIn("leg-expired", saglik)

    def test_health_report_template_has_live_scan_markup(self) -> None:
        saglik = (FLASK_APP_DIR / "templates" / "saglik.html").read_text(encoding="utf-8")
        self.assertIn('id="live-scan-btn"', saglik)
        self.assertIn("X-CSRF-Token", saglik)
        self.assertIn("window.KASA_CSRF_TOKEN", saglik)
        self.assertIn("live-scan-status", saglik)
        self.assertIn("CAN_LIVE_SCAN", saglik)
        # Tıklama akışı küresel tarama oturumuna bağlanır; yerel poller kaldırıldı
        self.assertNotIn("pollLiveScan", saglik)
        self.assertNotIn("scanPollTimer", saglik)

    def test_health_cards_collapsible_and_hover_popover_markup(self) -> None:
        saglik = (FLASK_APP_DIR / "templates" / "saglik.html").read_text(encoding="utf-8")
        for card_id in ("card-zayif", "card-tekrar", "card-eski",
                        "card-expired", "card-sizinti"):
            self.assertIn(f'id="{card_id}"', saglik)
        self.assertIn("sr-card-collapse", saglik)
        self.assertIn("sr-card-body", saglik)
        self.assertIn("window._('Genişlet')", saglik)
        for attr in ("data-pop-login", "data-pop-email", "data-pop-kategori",
                     "data-pop-skor", "data-pop-updated"):
            self.assertIn(attr, saglik)
        self.assertIn("pop.className = 'sr-pop'", saglik)
        self.assertIn("pointerenter", saglik)
        self.assertIn("setCardOpen", saglik)
        self.assertIn("setCardOpen(card, !isOpen)", saglik)
        self.assertNotIn("localStorage.getItem('sr-card-collapsed'", saglik)

    def test_health_report_has_search_sort_toolbar_and_closed_reuse_groups(self) -> None:
        saglik = (FLASK_APP_DIR / "templates" / "saglik.html").read_text(encoding="utf-8")
        for needle in (
            'id="sr-search-input"',
            'data-sort="name"',
            'data-sort="score"',
            'data-sort="date"',
            'id="sr-collapse-all"',
            "applyFilter",
            "applySort",
            "setCardOpen",
            "window.location.hash",
            "new URLSearchParams(window.location.search)",
        ):
            self.assertIn(needle, saglik)
        self.assertNotIn('sr-reuse-group" {% if loop.first %}open', saglik)
        self.assertIn("cleanupFilterEmpty", saglik)
        self.assertIn("syncCollapseAllLabel", saglik)
        self.assertIn("showPop", saglik)
        self.assertIn(".sr-card-collapse')", saglik)
        self.assertIn("scheduleReposition", saglik)
        self.assertIn("grid-template-columns: 1fr;", saglik)
        self.assertIn("grid-template-columns: 1fr !important", saglik)
        self.assertIn("backdrop-filter: var(--glass-vivid-blur)", saglik)
        self.assertIn("sr-dup-item-sub", saglik)
        self.assertIn("notify(window._('Rapor indirildi.')", saglik)
        self.assertNotIn("sr-dup-item-code", saglik)
        self.assertIn('class="sr-actions-bar"', saglik)
        self.assertIn(".sr-actions-bar .sr-toolbar", saglik)
        self.assertIn('kasa-toast kasa-toast-warning', saglik)
        self.assertIn("margin: 0 0 0 auto;", saglik)
        self.assertIn("repeat(5, minmax(0, 1fr)) !important", saglik)
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto auto", saglik)
        self.assertIn(".sr-item:hover { background: rgba(var(--accent-rgb), 0.06); }", saglik)
        self.assertIn("setCardOpen(card, !isOpen)", saglik)
        self.assertNotIn("setCardOpen(card, !savedCollapsed)", saglik)
        self.assertIn("sr-scroll-end-fab", saglik)
        self.assertIn("Sonuna İn", saglik)
        self.assertNotIn("class=\"sr-scroll-end\"", saglik)
        self.assertIn("updateFab", saglik)
        self.assertIn("LONG_LIST_PX", saglik)
        self.assertIn("fabTarget.scrollIntoView", saglik)
        self.assertNotIn("nearBottom", saglik)
        self.assertIn(".sr-card-head {", saglik)
        self.assertIn("flex-direction: row;", saglik)
        self.assertIn(".sr-card.is-collapsed .sr-card-body", saglik)
        self.assertIn("flex-wrap: nowrap;", saglik)
        self.assertIn("health-dup-selectall", saglik)
        self.assertIn("sr-dup-check", saglik)
        self.assertIn("sr-dup-expand", saglik)
        self.assertIn("sr-dup-hovercard", saglik)
        self.assertIn("sr-dup-more", saglik)
        self.assertIn("health-rotate-list", saglik)
        self.assertIn("sr-rotate-check", saglik)
        self.assertIn("health-rotate-selectall", saglik)
        self.assertIn("sr-rotate-score-s", saglik)
        self.assertIn("sr-rotate-more", saglik)
        self.assertIn("sr-rotate-hovercard", saglik)
        self.assertIn("buildTextReport", saglik)
        self.assertIn("text/plain;charset=utf-8", saglik)
        self.assertIn(".txt'", saglik)
        self.assertIn("/api/health/weak/preview", saglik)
        self.assertIn("btn-label-reveal", saglik)
        self.assertIn("max-width: 760px", saglik)
        self.assertIn("@media (max-width: 1200px)", saglik)
        self.assertIn("sr-action-tip", saglik)
        self.assertIn("sr-tip-msg", saglik)
        self.assertIn("Birleştirilecek item yok", saglik)
        self.assertIn("Yenilenecek item yok", saglik)

    def test_network_policy_settings_ui_present(self) -> None:
        panel = self._read("settings/panel-access.html")
        self.assertIn('name="internet_kill_switch"', panel)
        self.assertIn('name="live_breach_scan"', panel)
        self.assertIn('id="internet-kill-switch-toggle"', panel)
        self.assertIn('id="live-breach-scan-toggle"', panel)
        self.assertIn("INTERNET_KILL_SWITCH_ENABLED", panel)
        self.assertIn("LIVE_BREACH_SCAN_ENABLED", panel)
        self.assertIn("setting-internet-kill-switch-title", panel)
        self.assertIn("setting-live-scan-title", panel)

    def test_app_js_handles_update_check_disabled_state(self) -> None:
        app_js = (FLASK_APP_DIR / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("data.status === 'disabled'", app_js)
        self.assertIn("syncNetworkPolicyNotes", app_js)

    def test_deep_link_filter_hooks_into_vault_index(self) -> None:
        js = (FLASK_APP_DIR / "static" / "vault-index.js").read_text(encoding="utf-8")
        self.assertIn("filtre", js)
        self.assertIn("URLSearchParams", js)

    def test_asset_versions_bumped(self) -> None:
        base = (FLASK_APP_DIR / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn("cards.css') }}?v=76", base)
        self.assertIn("theme-states.css') }}?v=74", base)
        self.assertIn("utilities.css') }}?v=72", base)
        self.assertIn("app.js') }}?v=9.38", base)
        sw = (FLASK_APP_DIR / "templates" / "sw.js").read_text(encoding="utf-8")
        self.assertIn("assets-v193", sw)
        self.assertIn("assets-v193", self._read("scripts/sw-register.html"))

    def test_username_input_not_blocked_by_card_number_formatter(self) -> None:
        # Bug #1: kart numarası formatlama Kullanıcı Adı alanına şartsız
        # bağlanıyordu → rakam dışı her karakter siliniyordu.
        js = (FLASK_APP_DIR / "static" / "vault-form.js").read_text(encoding="utf-8")
        self.assertIn("currentType !== 'CreditCard'", js)

    def test_card_values_stay_single_line(self) -> None:
        # Bug #2: URL/Not değerleri 2 satıra sarmalanmamalı.
        cards = (FLASK_APP_DIR / "static" / "cards.css").read_text(encoding="utf-8")
        self.assertNotIn("-webkit-line-clamp: 2", cards)
        self.assertIn(".vault-note-text", cards)
        self.assertIn("white-space: nowrap", cards)
        responsive = (FLASK_APP_DIR / "static" / "responsive.css").read_text(encoding="utf-8")
        # Sarmalayan {white-space:normal; word-break:break-all} yalnızca masked şifrede kaldı
        self.assertEqual(responsive.count("word-break: break-all;"), 1)
        self.assertIn("text-overflow: ellipsis", responsive)

    def test_responsive_no_stats_div_selector(self) -> None:
        css = (FLASK_APP_DIR / "static" / "responsive.css").read_text(encoding="utf-8")
        self.assertNotIn("#stats-bar > div", css)
        self.assertIn(".stats-filter-chip", css)

    def test_stats_filter_translation_keys(self) -> None:
        keys = [
            "Tüm kayıtları göster",
            "Sadece favorileri göster",
            "Zayıf şifreli kayıtları göster",
            "Eski şifreli kayıtları göster",
            "Süresi dolmuş kayıtları göster",
        ]
        for lang in ("tr", "en"):
            data = json.loads(
                (FLASK_APP_DIR / "translations" / f"{lang}.json").read_text(encoding="utf-8")
            )
            for key in keys:
                self.assertIn(key, data, f"{lang}.json missing {key!r}")
                self.assertTrue(data[key].strip(), f"{lang}.json empty value {key!r}")


class CardAndStatsReportTests(unittest.TestCase):
    """Rapor payload'ına zayıf/eski/süresi dolmuş id listeleri eklendi."""

    def test_report_payload_includes_stat_id_lists(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        now = utc_now_naive()
        strong = "Xk9$vT2!mQ8@wL4#"
        records = [
            app_module.Record(
                id="batch-weak", type="Website", category="Genel",
                title=app_module.encrypt_metadata(fernet, "Zayif Site"),
                website_url=app_module.encrypt_metadata(fernet, "https://zayif.example.com"),
                login=app_module.encrypt_metadata(fernet, "zayif"),
                email=app_module.encrypt_metadata(fernet, "zayif@example.com"),
                encrypted_password=app_module.safe_encrypt(fernet, "123456"),
                updated_at=now,
            ),
            app_module.Record(
                id="batch-old", type="Website", category="Genel",
                title=app_module.encrypt_metadata(fernet, "Eski Site"),
                website_url=app_module.encrypt_metadata(fernet, "https://eski.example.com"),
                login=app_module.encrypt_metadata(fernet, "eski"),
                email=app_module.encrypt_metadata(fernet, "eski@example.com"),
                encrypted_password=app_module.safe_encrypt(fernet, strong),
                updated_at=now - timedelta(days=300),
            ),
            app_module.Record(
                id="batch-expired", type="Website", category="Genel",
                title=app_module.encrypt_metadata(fernet, "Süresi Dolan"),
                website_url=app_module.encrypt_metadata(fernet, "https://sone.example.com"),
                login=app_module.encrypt_metadata(fernet, "sone"),
                email=app_module.encrypt_metadata(fernet, "sone@example.com"),
                encrypted_password=app_module.safe_encrypt(fernet, strong),
                updated_at=now,
                expiry_date=now - timedelta(days=5),
            ),
            app_module.Record(
                id="batch-ok", type="Website", category="Genel",
                title=app_module.encrypt_metadata(fernet, "Saglam Site"),
                website_url=app_module.encrypt_metadata(fernet, "https://saglam.example.com"),
                login=app_module.encrypt_metadata(fernet, "saglam"),
                email=app_module.encrypt_metadata(fernet, "saglam@example.com"),
                encrypted_password=app_module.safe_encrypt(fernet, strong),
                updated_at=now,
            ),
        ]
        with app_module.app.app_context():
            app_module.db.session.add_all(records)
            app_module.db.session.commit()
            stats, health = build_vault_report_payloads(fernet, score_password)

        self.assertIn("batch-weak", stats["zayif_ids"])
        self.assertIn("batch-old", stats["eski_ids"])
        self.assertIn("batch-expired", stats["expired_ids"])
        self.assertNotIn("batch-ok", stats["zayif_ids"])
        self.assertNotIn("batch-ok", stats["eski_ids"])
        self.assertNotIn("batch-ok", stats["expired_ids"])

    def test_report_payload_includes_breach_and_url_field(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        now = utc_now_naive()
        records = [
            app_module.Record(
                id="breach-site", type="Website", category="Genel",
                title=app_module.encrypt_metadata(fernet, "Leak Portal"),
                website_url=app_module.encrypt_metadata(
                    fernet, "https://leak.example.com"),
                login=app_module.encrypt_metadata(fernet, "leak"),
                email=app_module.encrypt_metadata(fernet, "leak@example.com"),
                encrypted_password=app_module.safe_encrypt(fernet, "123456"),
                updated_at=now,
            ),
            app_module.Record(
                id="clean-site", type="Website", category="Genel",
                title=app_module.encrypt_metadata(fernet, "Güvenli Site"),
                website_url=app_module.encrypt_metadata(
                    fernet, "https://guvenli.example.com"),
                login=app_module.encrypt_metadata(fernet, "guvenli"),
                email=app_module.encrypt_metadata(fernet, "guvenli@example.com"),
                encrypted_password=app_module.safe_encrypt(
                    fernet, "R8#kQ2!vNp9$sWm4"),
                updated_at=now - timedelta(days=300),
            ),
        ]
        with app_module.app.app_context():
            app_module.db.session.add_all(records)
            app_module.db.session.commit()
            stats, health = build_vault_report_payloads(fernet, score_password)

        # Sızıntı tespiti: sadece bilinen yaygın şifre listesinden örnekler.
        self.assertIn("breach-site", stats["sizinti_ids"])
        self.assertNotIn("clean-site", stats["sizinti_ids"])
        self.assertIn("sizinti", health)
        sizinti_entry = next(
            x for x in health["sizinti"] if x["id"] == "breach-site")
        self.assertEqual(sizinti_entry["title"], "Leak Portal")
        self.assertEqual(sizinti_entry["url"], "https://leak.example.com")
        # URL alanı marka ikonları için risk listelerinde de mevcut.
        weak_entry = next(x for x in health["zayif"] if x["id"] == "breach-site")
        self.assertIn("url", weak_entry)
        eski_entry = next(x for x in health["eski"] if x["id"] == "clean-site")
        self.assertEqual(eski_entry["url"], "https://guvenli.example.com")

    def test_report_items_carry_hover_metadata_fields(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        now = utc_now_naive()
        record = app_module.Record(
            id="hover-fields", type="Website", category="Uyelikler",
            title=app_module.encrypt_metadata(fernet, "Hover Site"),
            website_url=app_module.encrypt_metadata(
                fernet, "https://hover.example.com"),
            login=app_module.encrypt_metadata(fernet, "hover-kullanici"),
            email=app_module.encrypt_metadata(
                fernet, "hover@example.com"),
            encrypted_password=app_module.safe_encrypt(fernet, "123456"),
            updated_at=now,
        )
        with app_module.app.app_context():
            app_module.db.session.add(record)
            app_module.db.session.commit()
            stats, health = build_vault_report_payloads(fernet, score_password)

        weak_entry = next(
            x for x in health["zayif"] if x["id"] == "hover-fields")
        self.assertEqual(weak_entry["login"], "hover-kullanici")
        self.assertEqual(weak_entry["email"], "hover@example.com")
        self.assertEqual(weak_entry["kategori"], "Uyelikler")
        self.assertEqual(weak_entry["updated_at"], now.isoformat())
        self.assertIsInstance(weak_entry["skor"], int)
        self.assertIn("hover-fields", stats["zayif_ids"])

    def test_distribution_counts_avoid_double_counting(self) -> None:
        # DB-bağımsız saf fonksiyon: Aynı kayıt birden çok risk kategorisinde
        # sayılmamalı; "guvenli" = hiçbir risk kategorisine sızmayan kayıt.
        dagitim = build_distribution_counts(
            toplam=3,
            weak_records=[{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
            password_map={
                "p1": [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
                "p2": [{"id": "c", "title": "C"}],
            },
            old_records=[{"id": "a", "title": "A"}],
            expired_records=[],
            breached_records=[{"id": "b", "title": "B"}],
        )
        self.assertEqual(dagitim, {"zayif": 2, "tekrar": 2, "eski": 1, "guvenli": 1})

    def test_breached_common_passwords_are_curated(self) -> None:
        # Liste güvenli kayıt anahtarlarını tetiklememeli: bilinen yaygın örnekler
        # dahil, rasgele üretilmiş güçlü şifreler hariç tutulmalı.
        self.assertIn("123456", BREACHED_COMMON_PASSWORDS)
        self.assertIn("qwerty", BREACHED_COMMON_PASSWORDS)
        self.assertIn("sifre", BREACHED_COMMON_PASSWORDS)
        self.assertNotIn("R8#kQ2!vNp9$sWm4", BREACHED_COMMON_PASSWORDS)
        self.assertNotIn("Xk9$vT2!mQ8@wL4#", BREACHED_COMMON_PASSWORDS)


class InternetKillSwitchAndHibpTests(unittest.TestCase):
    """İnternet Kill-Switch + HIBP k-anonimlik istemcisi birim testleri."""

    TOGGLE_KEYS = (
        network_policy.INTERNET_KILL_SWITCH_SETTING,
        network_policy.LIVE_BREACH_SCAN_SETTING,
    )

    def setUp(self) -> None:
        with app_module.app.app_context():
            for key in self.TOGGLE_KEYS:
                app_module.Setting.query.filter_by(key=key).delete()
            app_module.db.session.commit()
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        with app_module.app.app_context():
            for key in self.TOGGLE_KEYS:
                app_module.Setting.query.filter_by(key=key).delete()
            app_module.db.session.commit()
            with app_module._breach_scan_lock:
                app_module._breach_scan_state = {}
        hibp_module._target_cache.clear()
        hibp_module._last_fetch_at = 0.0

    def test_kill_switch_default_is_off(self) -> None:
        with app_module.app.app_context():
            self.assertFalse(network_policy.internet_kill_switch_enabled())
            self.assertTrue(network_policy.internet_allowed())
            self.assertFalse(network_policy.live_breach_scan_enabled())
            self.assertFalse(network_policy.live_breach_scan_available())

    def test_kill_switch_blocks_network_without_fetching(self) -> None:
        with app_module.app.app_context():
            app_module._set_setting('internet_kill_switch', 'true')
            app_module.db.session.commit()
            with patch.object(hibp_module, "_fetch_suffixes",
                              side_effect=AssertionError("network must not be used")):
                self.assertEqual(scan_passwords(["123456", "abcdef"], min_interval=0),
                                 (0, 0))

    def test_scan_passwords_sends_only_sha1_prefix(self) -> None:
        password = "ApplePortal!2026"
        digest = sha1_hex(password)
        captured: list[str] = []

        def fake_fetch(prefix: str, timeout: float = 8.0):
            captured.append(prefix)
            return frozenset([digest[5:]])

        with app_module.app.app_context():
            with patch.object(hibp_module, "_fetch_suffixes",
                              side_effect=fake_fetch):
                done, breached = scan_passwords([password], min_interval=0)
        self.assertEqual((done, breached), (1, 1))
        self.assertEqual(captured, [digest[:5]])
        # Tam parmak izi asla istekte kullanılmaz; yalnızca 5 haneli önek.
        self.assertNotEqual(captured[0], digest)

    def test_scan_passwords_negative_match_when_absent(self) -> None:
        with app_module.app.app_context():
            with patch.object(hibp_module, "_fetch_suffixes",
                              return_value=frozenset()):
                self.assertEqual(scan_passwords(["Clean-Pass-1!"], min_interval=0),
                                 (1, 0))

    def test_cached_breach_status_never_contacts_network(self) -> None:
        password = "Cached-Probe-777!"
        digest = sha1_hex(password)
        with app_module.app.app_context():
            with patch.object(hibp_module, "_fetch_suffixes",
                              return_value=frozenset([digest[5:]])):
                self.assertEqual(scan_passwords([password], min_interval=0), (1, 1))
        # Kill-switch açılsa bile önbellek okuması hiçbir istek başlatmaz.
        with app_module.app.app_context():
            app_module._set_setting('internet_kill_switch', 'true')
            app_module.db.session.commit()
            with patch.object(hibp_module, "_fetch_suffixes",
                              side_effect=AssertionError("network must not be used")):
                self.assertIs(cached_breach_status(password), True)
                self.assertEqual(scan_passwords([password], min_interval=0), (0, 0))

    def test_hibp_cache_persists_across_restart(self) -> None:
        password = "Persist-Probe-456!"
        digest = sha1_hex(password)
        cache_dir = tempfile.mkdtemp(prefix="sifrekasam-hibp-")
        cache_path = os.path.join(cache_dir, "hibp_cache.json")
        original_path = hibp_module._cache_file_path
        try:
            # Tarama → sonuç önbelleğe + diske kaydedilir.
            hibp_module.set_persistence_path(cache_path)
            with app_module.app.app_context():
                with patch.object(hibp_module, "_fetch_suffixes",
                                  return_value=frozenset([digest[5:]])):
                    self.assertEqual(scan_passwords([password], min_interval=0),
                                     (1, 1))
            # "Yeniden başlatma": bellek sıfır, diskten geri yüklenir.
            hibp_module._target_cache.clear()
            hibp_module.set_persistence_path(cache_path)
            # Geri yüklenen sonuç hiçbir ağ isteği olmadan okunabilir.
            with patch.object(hibp_module, "_fetch_suffixes",
                              side_effect=AssertionError("network must not be used")):
                self.assertIs(cached_breach_status(password), True)
        finally:
            hibp_module.set_persistence_path(original_path)
            hibp_module._target_cache.clear()
            hibp_module._last_fetch_at = 0.0
            try:
                os.remove(cache_path)
                os.rmdir(cache_dir)
            except OSError:
                pass

    def test_scan_passwords_deduplicates_prefixes(self) -> None:
        first, second = "Alpha1!2", "Beta2!3"
        prefix_first = sha1_hex(first)[:5]
        prefix_second = sha1_hex(second)[:5]
        if prefix_first == prefix_second:
            second = "Gamma3!4"
            prefix_second = sha1_hex(second)[:5]
        self.assertNotEqual(prefix_first, prefix_second)
        calls: list[str] = []
        all_suffixes = frozenset([sha1_hex(first)[5:], sha1_hex(second)[5:]])

        def fake_fetch(prefix: str, timeout: float = 8.0):
            calls.append(prefix)
            return all_suffixes

        with app_module.app.app_context():
            with patch.object(hibp_module, "_fetch_suffixes",
                              side_effect=fake_fetch):
                done, breached = scan_passwords(
                    [first, first, second], min_interval=0)
        # Aynı önek yalnızca bir kez çekilir; 2 eşleşme + 1 eşleşme.
        self.assertEqual(calls, [prefix_first, prefix_second])
        self.assertEqual((done, breached), (2, 3))

    def test_reports_merge_cached_hibp_results(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        now = utc_now_naive()
        password = "Se3ret-Not-Common-2026!"
        self.assertNotIn(password, BREACHED_COMMON_PASSWORDS)
        digest = sha1_hex(password)
        with app_module.app.app_context():
            with patch.object(hibp_module, "_fetch_suffixes",
                              return_value=frozenset([digest[5:]])):
                self.assertEqual(scan_passwords([password], min_interval=0), (1, 1))
        record = app_module.Record(
            id="hibp-merge-site", type="Website", category="Genel",
            title=app_module.encrypt_metadata(fernet, "Hibp Merge"),
            website_url=app_module.encrypt_metadata(
                fernet, "https://hibp-merge.example.com"),
            login=app_module.encrypt_metadata(fernet, "hibp"),
            email=app_module.encrypt_metadata(fernet, "hibp@example.com"),
            encrypted_password=app_module.safe_encrypt(fernet, password),
            updated_at=now,
        )
        with app_module.app.app_context():
            app_module.db.session.add(record)
            app_module.db.session.commit()
            try:
                stats, health = build_vault_report_payloads(fernet, score_password)
                self.assertIn("hibp-merge-site", stats["sizinti_ids"])
                self.assertNotIn(
                    "hibp-merge-site",
                    [r["id"] for r in health["zayif"]],
                )
            finally:
                app_module.db.session.delete(record)
                app_module.db.session.commit()
                hibp_module._target_cache.clear()


class BreachScanRouteTests(unittest.TestCase):
    """Canlı sızıntı taraması API kapıları ve durum raporu."""

    TOGGLE_KEYS = (
        network_policy.INTERNET_KILL_SWITCH_SETTING,
        network_policy.LIVE_BREACH_SCAN_SETTING,
        app_module.LAST_BREACH_SCAN_SETTING,
    )

    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        self._reset_toggles()

    def tearDown(self) -> None:
        self._reset_toggles()
        hibp_module._target_cache.clear()
        hibp_module._last_fetch_at = 0.0

    def _reset_toggles(self) -> None:
        with app_module.app.app_context():
            for key in self.TOGGLE_KEYS:
                app_module.Setting.query.filter_by(key=key).delete()
            app_module.db.session.commit()
            with app_module._breach_scan_lock:
                app_module._breach_scan_state = {}

    def _set_toggles(self, kill: str = 'false', live: str = 'false') -> None:
        with app_module.app.app_context():
            app_module._set_setting('internet_kill_switch', kill)
            app_module._set_setting('live_breach_scan', live)
            app_module.db.session.commit()

    def _wait_scan_finish(self) -> dict:
        state: dict = {}
        for _ in range(200):
            with app_module._breach_scan_lock:
                state = dict(app_module._breach_scan_state)
            if not state.get("running"):
                break
            time.sleep(0.05)
        return state

    def test_post_blocked_when_kill_switch_active(self) -> None:
        self._set_toggles(kill='true', live='true')
        with patch.object(app_module, "_hibp_scan_passwords",
                          side_effect=AssertionError("scan must not start")):
            response = self.client.post(
                "/api/breach/scan",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["reason"], "kill-switch")

    def test_post_blocked_when_live_scan_disabled(self) -> None:
        self._set_toggles(kill='false', live='false')
        response = self.client.post(
            "/api/breach/scan",
            headers={"X-App-Token": app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["reason"], "disabled")

    def test_post_starts_scan_and_status_reports_gates(self) -> None:
        self._set_toggles(kill='false', live='true')

        def fake_scan(passwords, on_progress=None, should_abort=None,
                      timeout=8.0, min_interval=1.6):
            # Tarama arka plan iş parçacığında koşar; network_policy DB okuması
            # (Setting.query) app context olmadan RuntimeError fırlatır.
            self.assertTrue(network_policy.internet_allowed())
            if on_progress:
                on_progress(1, 1, 1)
            return 1, 1

        with patch.object(app_module, "_collect_scan_passwords",
                          return_value=["Seed-Pass-1!", "Seed-Pass-1!"]), \
                patch.object(app_module, "_hibp_scan_passwords",
                             side_effect=fake_scan):
            response = self.client.post(
                "/api/breach/scan",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "started")
        self.assertEqual(payload["total"], 1)

        state = self._wait_scan_finish()
        self.assertFalse(state.get("running"))
        self.assertTrue(state.get("finished"))
        self.assertIsNone(state.get("error"))

        status = self.client.get(
            "/api/breach/scan",
            headers={"X-App-Token": app_module.APP_TOKEN},
        ).get_json()
        self.assertTrue(status["internet_allowed"])
        self.assertTrue(status["live_scan_enabled"])

        # Başarılı tarama, canlı kontrol hatırlatması için zaman damgasını yazar.
        with app_module.app.app_context():
            self.assertIsNotNone(
                app_module._get_setting(app_module.LAST_BREACH_SCAN_SETTING)
            )

    def test_status_requires_authentication(self) -> None:
        response = app_module.app.test_client().get(
            "/api/breach/scan",
            headers={"X-App-Token": app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login", response.headers["Location"])

    def test_save_settings_persists_network_policy_toggles(self) -> None:
        headers = {
            "X-App-Token": app_module.APP_TOKEN,
            "X-Requested-With": "XMLHttpRequest",
        }
        # Yalnızca canlı tarama açık: kill-switch kapalı olduğundan taranabilir.
        response = self.client.post(
            "/save_settings",
            data={"live_breach_scan": "1"},
            headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertFalse(data["internet_kill_switch_enabled"])
        self.assertTrue(data["live_breach_scan_enabled"])
        self.assertTrue(data["can_live_scan"])

        # Kill-switch açılırsa canlı tarama kullanılamaz hale gelir.
        response = self.client.post(
            "/save_settings",
            data={"internet_kill_switch": "1"},
            headers=headers,
        )
        data = response.get_json()
        self.assertTrue(data["internet_kill_switch_enabled"])
        self.assertFalse(data["can_live_scan"])

        # Boş kayıt her ikisini de varsayılana (kontrol) çevirir.
        response = self.client.post("/save_settings", data={}, headers=headers)
        data = response.get_json()
        self.assertFalse(data["internet_kill_switch_enabled"])
        self.assertFalse(data["live_breach_scan_enabled"])


class HealthActionsLogicTests(unittest.TestCase):
    """Sağlık hızlı eylemleri saf (DB-bağımsız) mantığı."""

    STRONG = "Xk9$vT2!mQ8@wL4#"

    def _record(self, fernet, rid, **overrides):
        fields = {
            "id": rid,
            "type": "Website",
            "category": "Genel",
            "title": app_module.encrypt_metadata(fernet, "Site"),
            "website_url": app_module.encrypt_metadata(
                fernet, "https://site.example.com"),
            "login": app_module.encrypt_metadata(fernet, "kullanici"),
            "email": app_module.encrypt_metadata(
                fernet, "kullanici@example.com"),
            "encrypted_password": app_module.safe_encrypt(fernet, self.STRONG),
            "encrypted_comment": "",
            "is_pinned": False,
            "expiry_date": None,
            "updated_at": None,
        }
        fields.update(overrides)
        return app_module.Record(**fields)

    def test_duplicate_groups_match_all_fields_and_exclude_different_records(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        records = [
            self._record(fernet, "dg-a1", updated_at=utc_now_naive()),
            self._record(fernet, "dg-a2", updated_at=utc_now_naive()),
            self._record(fernet, "dg-b1",
                         title=app_module.encrypt_metadata(fernet, "Farkli Site")),
        ]
        groups = find_duplicate_groups(records, fernet)
        self.assertEqual(len(groups), 1)
        candidate_ids = {groups[0]["survivor_id"], *groups[0]["member_ids"]}
        self.assertEqual(candidate_ids, {"dg-a1", "dg-a2"})

    def test_duplicate_survivor_prefers_pinned_then_newest(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        records = [
            self._record(fernet, "ds-newer", is_pinned=False,
                         updated_at=utc_now_naive()),
            self._record(fernet, "ds-pinned", is_pinned=True,
                         updated_at=None),
            self._record(fernet, "ds-older", is_pinned=False,
                         updated_at=utc_now_naive() - timedelta(days=10)),
        ]
        groups = find_duplicate_groups(records, fernet)
        self.assertEqual(groups[0]["survivor_id"], "ds-pinned")

    def test_duplicate_groups_skip_different_comments_and_unreadable_passwords(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        foreign_key = Fernet(Fernet.generate_key())
        records = [
            self._record(fernet, "dk-comment",
                         encrypted_comment=app_module.encrypt_metadata(
                             fernet, "notum")),
            self._record(fernet, "dk-plain", encrypted_comment=""),
            self._record(foreign_key, "dk-unreadable",
                         encrypted_password=app_module.safe_encrypt(
                             foreign_key, self.STRONG)),
        ]
        self.assertEqual(find_duplicate_groups(records, fernet), [])

    def test_generate_strong_password_meets_class_requirements(self) -> None:
        for _ in range(3):
            password = generate_strong_password()
            self.assertEqual(len(password), 24)
            self.assertTrue(any(ch.isupper() for ch in password))
            self.assertTrue(any(ch.islower() for ch in password))
            self.assertTrue(any(ch.isdigit() for ch in password))
            self.assertTrue(any(not ch.isalnum() for ch in password))
            self.assertFalse(any(ch in "Il1O0o" for ch in password))

    def test_weak_record_problems_only_flags_low_score(self) -> None:
        fernet = Fernet(Fernet.generate_key())
        records = [
            self._record(fernet, "w-weak",
                         encrypted_password=app_module.safe_encrypt(
                             fernet, "123456")),
            self._record(fernet, "w-strong"),
        ]
        problems = weak_record_problems(records, fernet, score_password)
        self.assertEqual([record.id for record, _ in problems], ["w-weak"])


class HealthQuickActionsRouteTests(unittest.TestCase):
    """Sağlık hızlı eylemleri API kapıları (hermetik fixture'lar)."""

    STRONG = "Xk9$vT2!mQ8@wL4#"

    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        self.fernet = Fernet(Fernet.generate_key())

    def _fixture(self, rid, password="123456", **overrides):
        fields = {
            "id": rid,
            "type": "Website",
            "category": "Genel",
            "title": app_module.encrypt_metadata(self.fernet, "Site " + rid),
            "website_url": app_module.encrypt_metadata(
                self.fernet, "https://site-" + rid + ".example.com"),
            "login": app_module.encrypt_metadata(
                self.fernet, "kullanici-" + rid),
            "email": app_module.encrypt_metadata(
                self.fernet, "kullanici-" + rid + "@example.com"),
            "encrypted_password": app_module.safe_encrypt(self.fernet, password),
            "encrypted_comment": "",
            "is_pinned": False,
            "expiry_date": None,
            "updated_at": None,
        }
        fields.update(overrides)
        return app_module.Record(**fields)

    def _dup_pair(self, rid_a: str, rid_b: str):
        meta = {
            "title": app_module.encrypt_metadata(self.fernet, "Çift Site"),
            "website_url": app_module.encrypt_metadata(
                self.fernet, "https://cift.example.com"),
            "login": app_module.encrypt_metadata(self.fernet, "cift"),
            "email": app_module.encrypt_metadata(
                self.fernet, "cift@example.com"),
        }
        return (
            self._fixture(rid_a, password=self.STRONG, **meta),
            self._fixture(rid_b, password=self.STRONG, **meta),
        )

    def test_preview_reports_groups_and_counts(self) -> None:
        dup_a, dup_b = self._dup_pair("hp-dup-a", "hp-dup-b")
        other = self._fixture("hp-other", password=self.STRONG)
        with patch.object(app_module, "get_fernet", return_value=self.fernet), \
                patch.object(app_module, "_record_rows",
                             return_value=[dup_a, dup_b, other]):
            response = self.client.get(
                "/api/health/duplicates/preview",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["deletable"], 1)
        group = payload["groups"][0]
        self.assertEqual(
            sorted([group["survivor_id"], *group["member_ids"]]),
            ["hp-dup-a", "hp-dup-b"],
        )

    def test_merge_backs_up_recomputes_and_deletes_duplicates_only(self) -> None:
        dup_a, dup_b = self._dup_pair("hp-m-dup-a", "hp-m-dup-b")
        other = self._fixture("hp-m-other", password=self.STRONG)
        with patch.object(app_module, "get_fernet", return_value=self.fernet), \
                patch.object(app_module, "_record_rows",
                             return_value=[dup_a, dup_b, other]), \
                patch.object(app_module, "_delete_records_and_history",
                             return_value=1) as delete_mock, \
                patch.object(app_module, "backup_database") as backup_mock:
            response = self.client.post(
                "/api/health/duplicates/merge",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["merged"], 1)
        self.assertEqual(payload["deleted"], 1)
        backup_mock.assert_called_once()
        # Survivor: en yüksek id (pinned/yeni değil) => en düşük id silinir.
        self.assertEqual(delete_mock.call_args[0][0], ["hp-m-dup-a"])

    def test_rotate_weak_replaces_only_weak_passwords(self) -> None:
        weak = self._fixture("hp-r-weak", password="123456")
        strong = self._fixture("hp-r-strong", password=self.STRONG)
        old_encrypted = weak.encrypted_password
        strong_encrypted = strong.encrypted_password
        with patch.object(app_module, "get_fernet", return_value=self.fernet), \
                patch.object(app_module, "_all_record_objects",
                             return_value=[weak, strong]), \
                patch.object(app_module, "backup_database"), \
                patch.object(app_module, "_append_password_history") as history_mock:
            response = self.client.post(
                "/api/health/rotate-weak",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["rotated"], 1)
        self.assertNotEqual(weak.encrypted_password, old_encrypted)
        new_password = app_module.safe_decrypt(self.fernet, weak.encrypted_password)
        self.assertNotEqual(new_password, "123456")
        history_mock.assert_called_once()
        self.assertEqual(history_mock.call_args[0][0], "hp-r-weak")
        # Güçlü kayda dokunulmaz.
        self.assertEqual(strong.encrypted_password, strong_encrypted)

    def test_rotate_weak_respects_selected_ids(self) -> None:
        first = self._fixture("hp-r2-first", password="123456")
        second = self._fixture("hp-r2-second", password="654321")
        first_encrypted = first.encrypted_password
        second_encrypted = second.encrypted_password
        with patch.object(app_module, "get_fernet", return_value=self.fernet), \
                patch.object(app_module, "_all_record_objects",
                             return_value=[first, second]), \
                patch.object(app_module, "backup_database"), \
                patch.object(app_module, "_append_password_history") as history_mock:
            response = self.client.post(
                "/api/health/rotate-weak",
                headers={"X-App-Token": app_module.APP_TOKEN,
                         "Content-Type": "application/json"},
                data='{"ids": ["hp-r2-first"]}',
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["rotated"], 1)
        self.assertNotEqual(first.encrypted_password, first_encrypted)
        self.assertEqual(history_mock.call_args[0][0], "hp-r2-first")
        # Seçilmeyen kayıt yenilenmez.
        self.assertEqual(second.encrypted_password, second_encrypted)

    def test_weak_count_and_export_return_expected_shapes(self) -> None:
        weak = self._fixture("hp-c-weak", password="123456")
        strong = self._fixture("hp-c-strong", password=self.STRONG)
        fake_stats = {
            "toplam": 2, "zayif": 1, "guvenli": 1,
            "zayif_ids": ["hp-c-weak"], "tekrar_ids": [], "eski_ids": [],
            "expired_ids": [], "sizinti_ids": [],
        }
        fake_health = {"zayif": [], "tekrar": [], "eski": [], "expired": [],
                       "sizinti": []}
        with patch.object(app_module, "get_fernet", return_value=self.fernet), \
                patch.object(app_module, "_all_record_objects",
                             return_value=[weak, strong]), \
                patch.object(app_module, "_build_vault_report_payloads",
                             return_value=(fake_stats, fake_health)):
            count_response = self.client.get(
                "/api/health/weak/count",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
            export_response = self.client.get(
                "/api/health/export",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(count_response.status_code, 200)
        self.assertEqual(count_response.get_json()["count"], 1)
        self.assertEqual(export_response.status_code, 200)
        export = export_response.get_json()
        self.assertIn("generated_at", export)
        self.assertEqual(export["stats"], fake_stats)
        self.assertEqual(export["health"], fake_health)

    def test_weak_preview_returns_scored_records(self) -> None:
        weak = self._fixture("hp-p-weak", password="123456")
        strong = self._fixture("hp-p-strong", password=self.STRONG)
        with patch.object(app_module, "get_fernet", return_value=self.fernet), \
                patch.object(app_module, "_all_record_objects",
                             return_value=[weak, strong]):
            response = self.client.get(
                "/api/health/weak/preview",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["count"], 1)
        rec = payload["records"][0]
        self.assertEqual(rec["id"], "hp-p-weak")
        self.assertEqual(rec["title"], "Site hp-p-weak")
        self.assertIsInstance(rec["score"], int)

    def _dup_group(self, rid_a: str, rid_b: str, title: str) -> tuple:
        meta = {
            "title": app_module.encrypt_metadata(self.fernet, title),
            "website_url": app_module.encrypt_metadata(
                self.fernet, "https://" + title + ".example.com"),
            "login": app_module.encrypt_metadata(self.fernet, title),
            "email": app_module.encrypt_metadata(
                self.fernet, title + "@example.com"),
        }
        return (
            self._fixture(rid_a, password=self.STRONG, **meta),
            self._fixture(rid_b, password=self.STRONG, **meta),
        )

    def test_merge_respects_selected_group_ids(self) -> None:
        dup_a, dup_b = self._dup_group("hp-s-a", "hp-s-b", "CiftOne")
        dup_c, dup_d = self._dup_group("hp-s-c", "hp-s-d", "CiftTwo")
        with patch.object(app_module, "get_fernet", return_value=self.fernet), \
                patch.object(app_module, "_record_rows",
                             return_value=[dup_a, dup_b, dup_c, dup_d]), \
                patch.object(app_module, "_delete_records_and_history",
                             return_value=1) as delete_mock, \
                patch.object(app_module, "backup_database") as backup_mock:
            response = self.client.post(
                "/api/health/duplicates/merge",
                headers={"X-App-Token": app_module.APP_TOKEN,
                         "Content-Type": "application/json"},
                data='{"ids": ["hp-s-c"]}',
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["merged"], 1)
        self.assertEqual(payload["deleted"], 1)
        backup_mock.assert_called_once()
        self.assertEqual(delete_mock.call_args[0][0], ["hp-s-c"])

    def test_merge_no_ids_merges_all_groups(self) -> None:
        dup_a, dup_b = self._dup_group("hp-t-a", "hp-t-b", "CiftThree")
        dup_c, dup_d = self._dup_group("hp-t-c", "hp-t-d", "CiftFour")
        with patch.object(app_module, "get_fernet", return_value=self.fernet), \
                patch.object(app_module, "_record_rows",
                             return_value=[dup_a, dup_b, dup_c, dup_d]), \
                patch.object(app_module, "_delete_records_and_history",
                             return_value=2) as delete_mock, \
                patch.object(app_module, "backup_database") as backup_mock:
            response = self.client.post(
                "/api/health/duplicates/merge",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["merged"], 2)
        self.assertEqual(payload["deleted"], 2)
        self.assertEqual(sorted(delete_mock.call_args[0][0]),
                         ["hp-t-a", "hp-t-c"])

    def test_backup_posts_without_touching_data(self) -> None:
        with patch.object(app_module, "backup_database") as backup_mock:
            response = self.client.post(
                "/api/health/backup",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")
        backup_mock.assert_called_once()

    def test_write_lock_blocks_mutations_with_409(self) -> None:
        app_module._vault_write_locked.set()
        try:
            response = self.client.post(
                "/api/health/duplicates/merge",
                headers={"X-App-Token": app_module.APP_TOKEN},
            )
        finally:
            app_module._vault_write_locked.clear()
        self.assertEqual(response.status_code, 409)

    def test_endpoints_require_authentication(self) -> None:
        anonymous = app_module.app.test_client()
        for method, path in (
            ("get", "/api/health/duplicates/preview"),
            ("get", "/api/health/weak/count"),
            ("get", "/api/health/export"),
            ("post", "/api/health/duplicates/merge"),
            ("post", "/api/health/rotate-weak"),
            ("post", "/api/health/backup"),
        ):
            with self.subTest(method=method, path=path):
                response = getattr(anonymous, method)(
                    path, headers={"X-App-Token": app_module.APP_TOKEN},
                )
                self.assertEqual(response.status_code, 302)
                self.assertIn("/login", response.headers["Location"])


class NotificationsReminderTests(unittest.TestCase):
    """Hatırlatma altyapısı: /api/notifications eşik/kimlik doğrulama mantığı."""

    SETTING_KEYS = (
        app_module.LAST_BACKUP_SETTING,
        app_module.LAST_BREACH_SCAN_SETTING,
        app_module.BACKUP_REMINDER_DAYS_SETTING,
        app_module.BREACH_REMINDER_DAYS_SETTING,
        network_policy.INTERNET_KILL_SWITCH_SETTING,
        network_policy.LIVE_BREACH_SCAN_SETTING,
    )

    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        self._cleanup_settings()
        self.addCleanup(self._cleanup_settings)

    def _cleanup_settings(self) -> None:
        with app_module.app.app_context():
            for key in self.SETTING_KEYS:
                app_module.Setting.query.filter_by(key=key).delete()
            app_module.db.session.commit()

    def _set(self, key: str, value: str) -> None:
        with app_module.app.app_context():
            app_module._set_setting(key, value)
            app_module.db.session.commit()

    def _reminder_kinds(self) -> list[str]:
        return [r["kind"] for r in self.client.get("/api/notifications").get_json()["reminders"]]

    def test_notifications_require_authentication(self) -> None:
        response = app_module.app.test_client().get(
            "/api/notifications",
            headers={"X-App-Token": app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login", response.headers["Location"])

    def test_never_backed_up_reminds_backup_only(self) -> None:
        # Canlı tarama kapalıyken yalnızca yedek hatırlatması çıkar.
        self.assertEqual(self._reminder_kinds(), ["backup"])

    def test_recent_backup_suppresses_reminder(self) -> None:
        self._set(app_module.LAST_BACKUP_SETTING, app_module._now_iso())
        self.assertNotIn("backup", self._reminder_kinds())

    def test_stale_backup_supplies_day_count(self) -> None:
        old = (datetime.now().astimezone() - timedelta(days=12)).isoformat(timespec='seconds')
        self._set(app_module.LAST_BACKUP_SETTING, old)
        payload = self.client.get("/api/notifications").get_json()
        backup = next(r for r in payload["reminders"] if r["kind"] == "backup")
        self.assertFalse(backup["never"])
        self.assertGreaterEqual(backup["days"], 12)
        self.assertEqual(backup["cta"], {"action": "settings", "panel": "data"})

    def test_breach_reminder_when_live_scan_enabled_but_never_checked(self) -> None:
        self._set(network_policy.LIVE_BREACH_SCAN_SETTING, 'true')
        kinds = self._reminder_kinds()
        self.assertIn("backup", kinds)
        self.assertIn("breach", kinds)

    def test_breach_reminder_summarizes_days_when_stale(self) -> None:
        self._set(network_policy.LIVE_BREACH_SCAN_SETTING, 'true')
        old = (datetime.now().astimezone() - timedelta(days=45)).isoformat(timespec='seconds')
        self._set(app_module.LAST_BREACH_SCAN_SETTING, old)
        payload = self.client.get("/api/notifications").get_json()
        breach = next(r for r in payload["reminders"] if r["kind"] == "breach")
        self.assertFalse(breach["never"])
        self.assertGreaterEqual(breach["days"], 45)
        self.assertEqual(breach["cta"]["action"], "navigate")

    def test_breach_reminder_suppressed_by_recent_scan(self) -> None:
        self._set(network_policy.LIVE_BREACH_SCAN_SETTING, 'true')
        self._set(app_module.LAST_BREACH_SCAN_SETTING, app_module._now_iso())
        self.assertNotIn("breach", self._reminder_kinds())


class NotificationPersistenceTests(unittest.TestCase):
    """Bildirim durumu kalıcılığı: susturma/sıfırlama endpoint'leri + GET dismissed."""

    SETTING_KEYS = (
        app_module.NOTIFICATION_DISMISSED_SETTING,
        app_module.LAST_BACKUP_SETTING,
        app_module.LAST_BREACH_SCAN_SETTING,
        app_module.BACKUP_REMINDER_DAYS_SETTING,
        app_module.BREACH_REMINDER_DAYS_SETTING,
        network_policy.INTERNET_KILL_SWITCH_SETTING,
        network_policy.LIVE_BREACH_SCAN_SETTING,
    )

    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        self._cleanup_settings()
        self.addCleanup(self._cleanup_settings)

    def _cleanup_settings(self) -> None:
        with app_module.app.app_context():
            for key in self.SETTING_KEYS:
                app_module.Setting.query.filter_by(key=key).delete()
            app_module.db.session.commit()

    def _headers(self) -> dict:
        return {"X-App-Token": app_module.APP_TOKEN}

    def test_get_notifications_includes_dismissed_field(self) -> None:
        response = self.client.get("/api/notifications", headers=self._headers())
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIn("dismissed", payload)
        self.assertIsInstance(payload["dismissed"], list)

    def test_dismiss_single_notification_persists(self) -> None:
        # Bildirimi sustur
        response = self.client.post(
            "/api/notifications/dismiss",
            json={"id": "backup"},
            headers=self._headers(),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        self.assertIn("backup", payload["dismissed"])

        # Kalıcı mı kontrol et
        response = self.client.get("/api/notifications", headers=self._headers())
        self.assertIn("backup", response.get_json()["dismissed"])

    def test_dismiss_multiple_notifications_persists(self) -> None:
        response = self.client.post(
            "/api/notifications/dismiss",
            json={"ids": ["backup", "breach"]},
            headers=self._headers(),
        )
        self.assertEqual(response.status_code, 200)
        dismissed = response.get_json()["dismissed"]
        self.assertIn("backup", dismissed)
        self.assertIn("breach", dismissed)

    def test_dismiss_is_idempotent(self) -> None:
        self.client.post(
            "/api/notifications/dismiss",
            json={"id": "backup"},
            headers=self._headers(),
        )
        self.client.post(
            "/api/notifications/dismiss",
            json={"id": "backup"},
            headers=self._headers(),
        )
        response = self.client.get("/api/notifications", headers=self._headers())
        dismissed = response.get_json()["dismissed"]
        self.assertEqual(dismissed.count("backup"), 1)

    def test_dismiss_empty_id_returns_400(self) -> None:
        response = self.client.post(
            "/api/notifications/dismiss",
            json={"id": ""},
            headers=self._headers(),
        )
        self.assertEqual(response.status_code, 400)

    def test_dismiss_no_ids_returns_400(self) -> None:
        response = self.client.post(
            "/api/notifications/dismiss",
            json={},
            headers=self._headers(),
        )
        self.assertEqual(response.status_code, 400)

    def test_dismiss_all_persists_current_reminder_ids(self) -> None:
        response = self.client.post(
            "/api/notifications/dismiss-all",
            headers=self._headers(),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        # Varsayılan olarak backup hatırlatması aktif, dönem-scoped ID sustain etmeli
        with app_module.app.app_context():
            active_id = (
                "backup-" + app_module._reminder_period_bucket(
                    app_module._reminder_frequency(
                        app_module.BACKUP_REMINDER_FREQUENCY_SETTING,
                        app_module.BACKUP_REMINDER_DAYS_SETTING,
                        app_module.DEFAULT_BACKUP_REMINDER_DAYS))
            )
        self.assertIn(active_id, payload["dismissed"])

    def test_dismiss_all_is_idempotent(self) -> None:
        self.client.post("/api/notifications/dismiss-all", headers=self._headers())
        response = self.client.post(
            "/api/notifications/dismiss-all", headers=self._headers(),
        )
        with app_module.app.app_context():
            active_id = (
                "backup-" + app_module._reminder_period_bucket(
                    app_module._reminder_frequency(
                        app_module.BACKUP_REMINDER_FREQUENCY_SETTING,
                        app_module.BACKUP_REMINDER_DAYS_SETTING,
                        app_module.DEFAULT_BACKUP_REMINDER_DAYS))
            )
        dismissed = response.get_json()["dismissed"]
        self.assertLessEqual(dismissed.count(active_id), 1)

    def test_delete_resets_dismissed_state(self) -> None:
        # Önce sustur
        self.client.post(
            "/api/notifications/dismiss",
            json={"ids": ["backup", "breach"]},
            headers=self._headers(),
        )
        # Sıfırla
        response = self.client.delete(
            "/api/notifications",
            headers=self._headers(),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["dismissed"], [])

        # GET ile de doğrula
        response = self.client.get("/api/notifications", headers=self._headers())
        self.assertEqual(response.get_json()["dismissed"], [])

    def test_dismissed_ids_not_in_public_or_token_endpoints(self) -> None:
        self.assertNotIn("notifications_dismiss", app_module._PUBLIC_ENDPOINTS)
        self.assertNotIn("notifications_dismiss_all", app_module._PUBLIC_ENDPOINTS)
        self.assertNotIn("notifications_reset", app_module._PUBLIC_ENDPOINTS)
        self.assertNotIn("notifications_dismiss", app_module._TOKEN_ENDPOINTS)
        self.assertNotIn("notifications_dismiss_all", app_module._TOKEN_ENDPOINTS)
        self.assertNotIn("notifications_reset", app_module._TOKEN_ENDPOINTS)

    def test_dismiss_requires_authentication(self) -> None:
        anonymous = app_module.app.test_client()
        response = anonymous.post(
            "/api/notifications/dismiss",
            json={"id": "backup"},
            headers={"X-App-Token": app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login", response.headers["Location"])


class MonitoringUiTemplateTests(unittest.TestCase):
    """Bildirim merkezi + küresel ilerleme çubuğu UI regresyonları."""

    def test_global_progress_bar_is_in_base(self) -> None:
        base = (FLASK_APP_DIR / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn('id="kasa-progress-bar"', base)
        self.assertIn("kasa-progress-fill", base)

    def test_base_has_global_topbar_block(self) -> None:
        base = (FLASK_APP_DIR / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn("{% block topbar %}", base)
        self.assertIn('class="kasa-navbar"', base)
        self.assertIn("{% block global_modals %}", base)
        self.assertIn("{% block navbar_crumb %}", base)

    def test_navbar_has_notifications_dropdown(self) -> None:
        base = (FLASK_APP_DIR / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn("notifications-dropdown-trigger", base)
        self.assertIn('id="kasa-notif-badge"', base)
        self.assertIn('id="kasa-notif-list"', base)
        self.assertIn("kasa-notif-menu", base)

    def test_navbar_keeps_lock_control(self) -> None:
        base = (FLASK_APP_DIR / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn('id="lock-vault-btn"', base)

    def test_dashboard_bar_holds_index_stats_and_search(self) -> None:
        db = (
            FLASK_APP_DIR / "templates" / "partials" / "dashboard-bar.html"
        ).read_text(encoding="utf-8")
        self.assertIn('id="stats-bar"', db)
        self.assertIn('id="search-input"', db)
        self.assertIn('id="category-filter"', db)
        # Anasayfa aksiyon butonları navbar'a (index navbar_actions) taşındı
        self.assertNotIn("passwordGeneratorModal", db)
        self.assertNotIn("saglik_raporu", db)
        self.assertNotIn("ekle_sayfasi", db)

    def test_index_navbar_actions_holds_primary_buttons(self) -> None:
        index = (FLASK_APP_DIR / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn("passwordGeneratorModal", index)
        self.assertIn("saglik_raporu", index)
        self.assertIn("ekle_sayfasi", index)

    def test_header_partial_removed_from_index(self) -> None:
        index = (FLASK_APP_DIR / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn("dashboard-bar.html", index)
        self.assertNotIn("header-bar.html", index)

    def test_app_js_wires_notifications_module(self) -> None:
        app_js = (FLASK_APP_DIR / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("import { initNotifications } from './notifications.js?v=9.3'", app_js)
        self.assertIn("initNotifications({ apiFetch });", app_js)

    def test_app_js_wires_scan_session_module(self) -> None:
        app_js = (FLASK_APP_DIR / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("import { initScanSession } from './scan-session.js'", app_js)
        self.assertIn("initScanSession({ apiFetch });", app_js)

    def test_scan_session_js_exposes_global_api(self) -> None:
        js = (FLASK_APP_DIR / "static" / "scan-session.js").read_text(encoding="utf-8")
        self.assertIn("window.KASA_SCAN", js)
        self.assertIn("kasa:scan-update", js)
        self.assertIn("kasa:scan-finished", js)
        self.assertIn("kasa-scan-session", js)

    def test_notifications_js_knows_reminder_cta_paths(self) -> None:
        js = (FLASK_APP_DIR / "static" / "notifications.js").read_text(encoding="utf-8")
        self.assertIn("/api/notifications", js)
        self.assertIn("kasa-notif-cta", js)
        self.assertIn("showWarningToast", js)

    def test_health_page_has_scan_reopen_control(self) -> None:
        saglik = (FLASK_APP_DIR / "templates" / "saglik.html").read_text(encoding="utf-8")
        self.assertIn('id="sr-scan-reopen-btn"', saglik)
        self.assertIn("syncScanReopen", saglik)
        self.assertIn("_('Tarama ilerlemesini göster')", saglik)

    def test_health_page_subscribes_to_scan_session_events(self) -> None:
        saglik = (FLASK_APP_DIR / "templates" / "saglik.html").read_text(encoding="utf-8")
        self.assertIn("kasa:scan-update", saglik)
        self.assertIn("kasa:scan-finished", saglik)
        self.assertIn("restoreScanSession", saglik)

    def test_subpages_place_back_control_in_navbar_actions(self) -> None:
        for name in ("saglik.html", "ekle.html"):
            page = (FLASK_APP_DIR / "templates" / name).read_text(encoding="utf-8")
            self.assertIn("{% block navbar_after_lock %}", page)
            self.assertIn("kasa-crumb-back", page)
            self.assertIn("kasa-navbar-back", page)
            self.assertIn("{% block navbar_crumb %}", page)


class PrivacyPolicyTests(unittest.TestCase):
    """Gizlilik politikası varlığı ve kritik açıklamalar için şablon/regresyon testleri."""

    def test_repo_root_privacy_markdown_exists(self) -> None:
        md = (PROJECT_ROOT / "PRIVACY.md").read_text(encoding="utf-8")
        for marker in ("k-anonim", "HaveIBeenPwned", "GitHub Releases",
                       "Fernet", "PBKDF2", "Yerel saklama"):
            self.assertIn(marker, md)

    def test_privacy_modal_is_included_from_base(self) -> None:
        base = (FLASK_APP_DIR / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn("privacypolicy-modal.html", base)

    def test_settings_data_panel_links_to_privacy_modal(self) -> None:
        panel = (
            FLASK_APP_DIR / "templates" / "partials" / "settings" / "panel-data.html"
        ).read_text(encoding="utf-8")
        self.assertIn('data-kasa-modal="privacyPolicyModal"', panel)
        self.assertIn("fa-scale-balanced", panel)
        self.assertIn("_('Gizlilik Politikası')", panel)

    def test_privacy_modal_discloses_key_data_flows(self) -> None:
        partial = (
            FLASK_APP_DIR / "templates" / "partials" / "privacypolicy-modal.html"
        ).read_text(encoding="utf-8")
        self.assertIn('id="privacyPolicyModal"', partial)
        # UI statik bloklar (TR/EN) çeviri kataloğundan GEÇİN temas etmemeli
        self.assertNotIn("_('ŞifreKasam", partial)
        self.assertIn('data-privacy-block="tr"', partial)
        self.assertIn('data-privacy-block="en"', partial)
        # Kritik ifşalar mevcut olmalı
        for marker in ("k-anonim", "tamamı asla gönderilmez",
                       "GitHub Releases", "Kill-Switch", "PBKDF2",
                       "first 5 characters", "never shared"):
            self.assertIn(marker, partial)


class BackupsModuleTests(unittest.TestCase):
    """kasa_core/backups birim testleri: anahtar sarmalı, create/rotate/list/read/delete."""

    SETTING_KEYS = (
        app_module._backups.BACKUP_KEY_WRAP_SETTING,
        app_module._backups.LAST_AUTO_BACKUP_SETTING,
        app_module.LAST_BACKUP_SETTING,
    )

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="kasa-backups-module-")
        self.fernet = Fernet(Fernet.generate_key())
        self._cleanup_settings()
        self.addCleanup(self._cleanup_settings)

    def _cleanup_settings(self) -> None:
        with app_module.app.app_context():
            for key in self.SETTING_KEYS:
                app_module.Setting.query.filter_by(key=key).delete()
            app_module.db.session.commit()

    def _managed_files(self) -> list:
        with app_module.app.app_context():
            return app_module._backups.list_backups(self.tmpdir)

    def test_create_backup_roundtrip_decrypts_to_records(self) -> None:
        records = [
            {"title": "Site", "password": "s3cret", "login": "kullanici"},
            {"title": "Kart", "password": "1234", "note": "mi"},
        ]
        with app_module.app.app_context():
            info = app_module._backups.create_backup(
                records, self.fernet, self.tmpdir)
            self.assertTrue(info["filename"].startswith("sifrekasam_otomatik_"))
            self.assertTrue(info["filename"].endswith(".kasaenc"))
            self.assertGreater(info["size"], 0)
            blob = app_module._backups.read_backup(
                self.tmpdir, info["filename"])
            parsed = decrypt_encrypted_records(
                blob, app_module._backups.backup_password(self.fernet))
            self.assertEqual(parsed, records)

    def test_backup_key_wrap_is_stable_and_refreshed(self) -> None:
        old_fernet = self.fernet
        new_fernet = Fernet(Fernet.generate_key())
        with app_module.app.app_context():
            first = app_module._backups.ensure_unwrapped_backup_key(old_fernet)
            app_module.db.session.commit()
            second = app_module._backups.ensure_unwrapped_backup_key(old_fernet)
            app_module.db.session.commit()
            self.assertEqual(first, second)

            app_module._backups.refresh_backup_key(old_fernet, new_fernet)
            app_module.db.session.commit()

            # Yeni anahtarla çözülür; eskisiyle çözülemez.
            from kasa_core.models import Setting
            wrap = Setting.query.filter_by(
                key=app_module._backups.BACKUP_KEY_WRAP_SETTING).first().value
            self.assertEqual(
                new_fernet.decrypt(wrap.encode()),
                first)
            with self.assertRaises(Exception):
                old_fernet.decrypt(wrap.encode())

            # backup_password yeni sarmalla aynı anahtarı döner
            unwrapped = app_module._backups.ensure_unwrapped_backup_key(new_fernet)
            self.assertEqual(unwrapped, first)

    def test_rotation_keeps_only_max_count(self) -> None:
        with app_module.app.app_context():
            for i in range(9):
                info = app_module._backups.create_backup(
                    [{"title": f"R{i}", "password": f"p{i}"}],
                    self.fernet, self.tmpdir)
            files = self._managed_files()
            self.assertEqual(len(files), app_module._backups.AUTO_BACKUP_MAX_COUNT)
            self.assertEqual(
                files[0]["filename"], info["filename"],
                "En yeni yedek listede kalmalı")

    def test_list_backups_only_managed_files_sorted(self) -> None:
        with app_module.app.app_context():
            app_module._backups.create_backup(
                [{"title": "A"}], self.fernet, self.tmpdir)
            time.sleep(0.01)
            second = app_module._backups.create_backup(
                [{"title": "B"}], self.fernet, self.tmpdir)
            # Yönetilmeyen dosya ekle (liste dışı kalmalı)
            (app_module._backups.backups_dir(self.tmpdir) / "baska.txt").write_text("x")
            files = self._managed_files()
            self.assertEqual(files[0]["filename"], second["filename"],
                             "En yenisi başta olmalı")
            self.assertTrue(all(f["filename"].startswith("sifrekasam_otomatik_")
                                for f in files))

    def test_read_backup_rejects_path_traversal(self) -> None:
        with app_module.app.app_context():
            with self.assertRaises(ValueError):
                app_module._backups.read_backup(
                    self.tmpdir, "../diske-sifrekasam.db")
            with self.assertRaises(ValueError):
                app_module._backups.read_backup(
                    self.tmpdir, "diger.kasaenc")

    def test_delete_backup_validates_and_removes(self) -> None:
        with app_module.app.app_context():
            info = app_module._backups.create_backup(
                [{"title": "Del"}], self.fernet, self.tmpdir)
            with self.assertRaises(ValueError):
                app_module._backups.delete_backup(self.tmpdir, "yok.kasaenc")
            self.assertTrue(
                app_module._backups.delete_backup(
                    self.tmpdir, info["filename"]))
            files = self._managed_files()
            self.assertEqual(files, [])


class AutomaticBackupApiTests(unittest.TestCase):
    """Otomatik yedek API yüzeyleri: list/create/delete/restore + güvenlik."""

    STRONG = "Xk9$vT2!mQ8@wL4#"

    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        self.fernet = Fernet(Fernet.generate_key())
        self._cleanup()
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        with app_module.app.app_context():
            for key in (
                app_module._backups.BACKUP_KEY_WRAP_SETTING,
                app_module._backups.LAST_AUTO_BACKUP_SETTING,
                app_module._backups.AUTO_BACKUP_INTERVAL_SETTING,
                app_module.LAST_BACKUP_SETTING,
            ):
                app_module.Setting.query.filter_by(key=key).delete()
            app_module.Record.query.delete()
            app_module.PasswordHistory.query.delete()
            app_module.db.session.commit()
            folder = app_module._backups.backups_dir(app_module.DATA_DIR)
            for entry in os.scandir(folder):
                if entry.name.startswith("sifrekasam_otomatik_"):
                    try:
                        os.unlink(entry.path)
                    except OSError:
                        pass

    def _headers(self) -> dict:
        return {"X-App-Token": app_module.APP_TOKEN}

    def _fixture(self, rid: str, password: str = "123456") -> app_module.Record:
        return app_module.Record(
            id=rid,
            type="Website",
            category="Genel",
            title=app_module.encrypt_metadata(self.fernet, "Site " + rid),
            website_url=app_module.encrypt_metadata(
                self.fernet, "https://" + rid + ".example.com"),
            login=app_module.encrypt_metadata(self.fernet, "kullanici-" + rid),
            email=app_module.encrypt_metadata(
                self.fernet, "kullanici-" + rid + "@example.com"),
            encrypted_password=app_module.safe_encrypt(self.fernet, password),
            encrypted_comment="",
            is_pinned=False,
            expiry_date=None,
            updated_at=None,
        )

    def test_list_requires_authentication(self) -> None:
        anonymous = app_module.app.test_client()
        response = anonymous.get(
            "/api/backups", headers=self._headers())
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login", response.headers["Location"])

    def test_list_returns_backups_and_max_count(self) -> None:
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            self.client.post("/api/backups/create", headers=self._headers())
            response = self.client.get("/api/backups", headers=self._headers())
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["max_count"],
                         app_module._backups.AUTO_BACKUP_MAX_COUNT)
        self.assertEqual(len(payload["backups"]), 1)

    def test_list_exposes_interval_and_next_backup(self) -> None:
        with app_module.app.app_context():
            app_module._set_setting(
                app_module._backups.LAST_AUTO_BACKUP_SETTING,
                "2026-01-01T00:00:00+00:00")
            app_module.db.session.commit()
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            response = self.client.get("/api/backups", headers=self._headers())
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["auto_backup_interval"], "daily")
        self.assertEqual(payload["auto_backup_interval_seconds"], 24 * 3600)
        next_dt = datetime.fromisoformat(payload["next_auto_backup_at"])
        self.assertEqual(
            (next_dt - datetime.fromisoformat("2026-01-01T00:00:00+00:00")).total_seconds(),
            24 * 3600)

    def test_default_interval_is_daily(self) -> None:
        with app_module.app.app_context():
            self.assertEqual(
                app_module._auto_backup_interval_seconds(), 24 * 3600)

    def test_auto_backup_interval_off_maps_to_none(self) -> None:
        with app_module.app.app_context():
            app_module._set_setting(
                app_module._backups.AUTO_BACKUP_INTERVAL_SETTING, "off")
            self.assertIsNone(app_module._auto_backup_interval_seconds())

    def test_auto_backup_interval_hourly_maps_to_3600(self) -> None:
        with app_module.app.app_context():
            app_module._set_setting(
                app_module._backups.AUTO_BACKUP_INTERVAL_SETTING, "hourly")
            self.assertEqual(
                app_module._auto_backup_interval_seconds(), 3600)

    def test_save_settings_persists_auto_backup_interval(self) -> None:
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            self.client.post('/save_settings', data={
                "auto_backup_interval": "hourly",
                "lan_enabled": "",
            }, headers=self._headers())
        with app_module.app.app_context():
            self.assertEqual(
                app_module._get_setting(
                    app_module._backups.AUTO_BACKUP_INTERVAL_SETTING),
                "hourly")

    def test_auto_backup_skipped_when_interval_off(self) -> None:
        with app_module.app.app_context():
            app_module._set_setting(
                app_module._backups.AUTO_BACKUP_INTERVAL_SETTING, "off")
            app_module.db.session.commit()
            with patch.object(app_module, "get_fernet",
                              return_value=self.fernet):
                info = app_module._create_rotating_backup(force=False)
        self.assertIsNone(info)

    def test_create_creates_managed_backup_and_sets_stamps(self) -> None:
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            response = self.client.post(
                "/api/backups/create", headers=self._headers())
        self.assertEqual(response.status_code, 200)
        backup = response.get_json()["backup"]
        self.assertTrue(backup["filename"].startswith("sifrekasam_otomatik_"))
        with app_module.app.app_context():
            last_auto = app_module._get_setting(
                app_module._backups.LAST_AUTO_BACKUP_SETTING)
            last = app_module._get_setting(app_module.LAST_BACKUP_SETTING)
        self.assertTrue(last_auto)
        self.assertEqual(last, last_auto)

    def test_create_returns_409_when_vault_locked(self) -> None:
        with patch.object(app_module, "get_fernet",
                          side_effect=RuntimeError("kilitli")):
            response = self.client.post(
                "/api/backups/create", headers=self._headers())
        self.assertEqual(response.status_code, 409)

    def test_restore_requires_confirmation(self) -> None:
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            created = self.client.post(
                "/api/backups/create", headers=self._headers()).get_json()
        filename = created["backup"]["filename"]
        response = self.client.post(
            "/api/backups/restore", json={"filename": filename},
            headers=self._headers())
        self.assertEqual(response.status_code, 400)

    def test_restore_replaces_all_records(self) -> None:
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            with app_module.app.app_context():
                a = self._fixture("rb-a", password=self.STRONG)
                b = self._fixture("rb-b", password=self.STRONG)
                app_module.db.session.add_all([a, b])
                app_module.db.session.commit()
            created = self.client.post(
                "/api/backups/create", headers=self._headers()).get_json()
            filename = created["backup"]["filename"]
            with app_module.app.app_context():
                # Yedek alındıktan sonra 1 kayıt daha eklenir → restore değiştirmeli
                app_module.db.session.add(
                    self._fixture("rb-c", password=self.STRONG))
                app_module.db.session.commit()
            response = self.client.post(
                "/api/backups/restore",
                json={"filename": filename, "confirm": True},
                headers=self._headers())
        self.assertEqual(response.status_code, 200)
        restored = response.get_json()["restored"]
        self.assertEqual(restored, 2)
        with app_module.app.app_context():
            count = app_module.Record.query.count()
            passwords = {
                app_module.safe_decrypt(self.fernet, r.encrypted_password)
                for r in app_module.Record.query.all()
            }
        self.assertEqual(count, 2)
        self.assertEqual(passwords, {self.STRONG})

    def test_restore_rejects_invalid_filename(self) -> None:
        response = self.client.post(
            "/api/backups/restore",
            json={"filename": "../diske.db", "confirm": True},
            headers=self._headers())
        self.assertEqual(response.status_code, 400)

    def test_delete_removes_managed_backup(self) -> None:
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            created = self.client.post(
                "/api/backups/create", headers=self._headers()).get_json()
            filename = created["backup"]["filename"]
            response = self.client.post(
                "/api/backups/delete",
                json={"filename": filename}, headers=self._headers())
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["deleted"], filename)
            with app_module.app.app_context():
                files = app_module._backups.list_backups(app_module.DATA_DIR)
            self.assertEqual(files, [])

    def test_delete_rejects_invalid_filename(self) -> None:
        response = self.client.post(
            "/api/backups/delete",
            json={"filename": "..\\diske.db"}, headers=self._headers())
        self.assertEqual(response.status_code, 400)

    def test_backup_endpoints_not_public_or_token(self) -> None:
        for endpoint in ("api_backups_list", "api_backups_create",
                         "api_backups_delete", "api_backups_restore"):
            self.assertNotIn(endpoint, app_module._PUBLIC_ENDPOINTS)
            self.assertNotIn(endpoint, app_module._TOKEN_ENDPOINTS)


class ReminderFrequencyTests(unittest.TestCase):
    """Hatırlatma frekansları: migrate, dönem-scoped ID ve API yansıması."""

    SETTING_KEYS = (
        app_module.BACKUP_REMINDER_FREQUENCY_SETTING,
        app_module.BREACH_REMINDER_FREQUENCY_SETTING,
        app_module.BACKUP_REMINDER_DAYS_SETTING,
        app_module.BREACH_REMINDER_DAYS_SETTING,
        app_module.LAST_BACKUP_SETTING,
        app_module.LAST_BREACH_SCAN_SETTING,
        app_module.NOTIFICATION_DISMISSED_SETTING,
    )

    def setUp(self) -> None:
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        self._cleanup()
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        with app_module.app.app_context():
            for key in self.SETTING_KEYS:
                app_module.Setting.query.filter_by(key=key).delete()
            app_module.db.session.commit()

    def _headers(self) -> dict:
        return {"X-App-Token": app_module.APP_TOKEN}

    def _write_settings(self, pairs: dict) -> None:
        with app_module.app.app_context():
            for key, value in pairs.items():
                app_module._set_setting(key, value)
            app_module.db.session.commit()

    def test_legacy_days_migrates_to_frequency(self) -> None:
        self._write_settings({app_module.BACKUP_REMINDER_DAYS_SETTING: "30"})
        with app_module.app.app_context():
            frequency = app_module._reminder_frequency(
                app_module.BACKUP_REMINDER_FREQUENCY_SETTING,
                app_module.BACKUP_REMINDER_DAYS_SETTING,
                app_module.DEFAULT_BACKUP_REMINDER_DAYS)
            self.assertEqual(frequency, "monthly")

    def test_writing_frequency_updates_legacy_days(self) -> None:
        with app_module.app.app_context():
            result = app_module._write_reminder_frequency(
                app_module.BACKUP_REMINDER_FREQUENCY_SETTING,
                app_module.BACKUP_REMINDER_DAYS_SETTING, "weekly")
            self.assertEqual(result, "weekly")
            app_module.db.session.commit()
            days = app_module._reminder_days(
                app_module.BACKUP_REMINDER_DAYS_SETTING,
                app_module.DEFAULT_BACKUP_REMINDER_DAYS)
        self.assertEqual(days, 7)

    def test_period_bucket_scopes_daily_weekly_monthly(self) -> None:
        now = datetime(2026, 9, 6, 15, 30,
                       tzinfo=UTC)  # Pazar → weekly pazartesi 2026-08-31'e bağlanır
        with app_module.app.app_context():
            daily = app_module._reminder_period_bucket("daily", now)
            weekly = app_module._reminder_period_bucket("weekly", now)
            monthly = app_module._reminder_period_bucket("monthly", now)
        self.assertEqual(daily, "2026-09-06")
        self.assertEqual(weekly, "2026-08-31")
        self.assertEqual(monthly, "2026-09-01")

    def test_reminder_ids_are_period_scoped(self) -> None:
        self._write_settings({
            app_module.BACKUP_REMINDER_DAYS_SETTING: "1",
        })
        response = self.client.post(
            "/api/notifications/dismiss-all", headers=self._headers())
        self.assertEqual(response.status_code, 200)
        dismissed = response.get_json()["dismissed"]
        period_id = [x for x in dismissed if x.startswith("backup-")]
        self.assertEqual(len(period_id), 1)
        self.assertRegex(period_id[0],
                         r"^backup-\d{4}-\d{2}-\d{2}$")

    def test_save_settings_persists_frequencies(self) -> None:
        headers = {
            "X-App-Token": app_module.APP_TOKEN,
            "X-Requested-With": "XMLHttpRequest",
        }
        response = self.client.post(
            "/save_settings",
            data={
                "backup_reminder_frequency": "daily",
                "breach_reminder_frequency": "monthly",
            },
            headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.get(
            "/api/notifications", headers=self._headers())
        payload = response.get_json()
        self.assertEqual(payload["backup_reminder_frequency"], "daily")
        self.assertEqual(payload["breach_reminder_frequency"], "monthly")
        self.assertEqual(payload["backup_reminder_days"], 1)
        self.assertEqual(payload["breach_reminder_days"], 30)

    def test_notifications_api_defaults_are_sane(self) -> None:
        response = self.client.get(
            "/api/notifications", headers=self._headers())
        payload = response.get_json()
        self.assertIn("backup_reminder_frequency", payload)
        self.assertIn("breach_reminder_frequency", payload)


if __name__ == "__main__":
    unittest.main()
