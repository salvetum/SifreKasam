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
import unittest
from datetime import UTC
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
from kasa_core import backgrounds as backgrounds_module  # noqa: E402
from kasa_core.import_export import (  # noqa: E402
    build_export_payload,
    parse_expiry,
    parse_import_payload,
)
from kasa_core.password_strength import (  # noqa: E402
    ACCEPTABLE_PASSWORD_SCORE,
    analyze_password,
    normalize_user_inputs,
    password_is_weak,
)
from kasa_core.reports import build_vault_report_payloads  # noqa: E402
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
        self.assertEqual(app_module._login_backoff_seconds(4), 0)
        self.assertEqual(app_module._login_backoff_seconds(5), 30)
        self.assertEqual(app_module._login_backoff_seconds(6), 60)
        self.assertEqual(app_module._login_backoff_seconds(10), 960)
        self.assertEqual(app_module._login_backoff_seconds(11), 1800)
        self.assertEqual(app_module._login_backoff_seconds(100), 1800)

    def test_data_directory_permissions_are_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "vault"
            app_module._ensure_private_data_dir(str(path))
            app_module._ensure_private_data_dir(str(path))

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
        img = Image.new('RGB', (4, 4), color=(128, 64, 32))
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

    def test_unauthorized_serve_without_token(self) -> None:
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.get('/api/background/current')
        self.assertEqual(response.status_code, 403)

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
        app_module._login_attempts.clear()
        self._reset_vault_state()

    def tearDown(self) -> None:
        app_module._login_attempts.clear()
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
        self.assertTrue(set(lan_password) <= set(app_module.LAN_PASSWORD_ALPHABET))

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


if __name__ == "__main__":
    unittest.main()
