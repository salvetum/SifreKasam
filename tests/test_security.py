"""Security regression tests for vault storage and login throttling."""

from __future__ import annotations

import io
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = Path(tempfile.mkdtemp(prefix="sifrekasam-security-tests-"))
os.environ["APPDATA"] = str(RUNTIME_DIR)
os.environ["XDG_CONFIG_HOME"] = str(RUNTIME_DIR)
sys.path.insert(0, str(ROOT / "flask_app"))

import app as app_module  # noqa: E402
from kasa_core.reports import build_vault_report_payloads  # noqa: E402


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


class StylesheetDependencyTests(unittest.TestCase):
    def test_bootstrap_stylesheet_is_not_bundled_or_referenced(self) -> None:
        self.assertFalse((ROOT / "flask_app" / "static" / "bootstrap.min.css").exists())

        template_text = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (ROOT / "flask_app" / "templates").glob("*")
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
        oversized = self._make_png(size_bytes=11 * 1024 * 1024)
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(oversized), 'big.png'),
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
        response = self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'test.png'),
        }, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 403)

    def test_unauthorized_delete_without_token(self) -> None:
        response = self.client.delete('/api/background')
        self.assertEqual(response.status_code, 403)

    def test_unauthorized_serve_without_token(self) -> None:
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
        self.assertNotIn('serve_custom_background', public)

    def test_custom_background_endpoints_not_in_token_endpoints(self) -> None:
        token_eps = app_module._TOKEN_ENDPOINTS
        self.assertNotIn('upload_custom_background', token_eps)
        self.assertNotIn('delete_custom_background', token_eps)
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
        bg_dir = app_module.BACKGROUND_DIR
        root_files = [f for f in os.listdir(bg_dir) if os.path.isfile(os.path.join(bg_dir, f))]
        self.assertEqual(len(root_files), 1)
        response = self.client.get('/api/background/history', headers=self._token)
        self.assertEqual(response.status_code, 200)
        entries = response.get_json()['entries']
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['id'], first_id)

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
        self.assertEqual(entries, [])
        self.assertEqual(self._current_background_id(), second_id)

    def test_delete_background_clears_history_too(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'first.png'),
        }, content_type='multipart/form-data', headers=self._token)
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'second.png'),
        }, content_type='multipart/form-data', headers=self._token)

        response = self.client.delete('/api/background', headers=self._token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.client.get('/api/background/current', headers=self._token).status_code,
            404,
        )
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(entries, [])
        self.assertEqual(app_module.get_saved_background_style(), 'aurora')

    def test_history_reports_gif_flag(self) -> None:
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_gif()), 'anim.gif'),
        }, content_type='multipart/form-data', headers=self._token)
        self.client.post('/api/background/upload', data={
            'file': (io.BytesIO(self._make_png()), 'photo.png'),
        }, content_type='multipart/form-data', headers=self._token)
        entries = self.client.get('/api/background/history', headers=self._token).get_json()['entries']
        self.assertEqual(len(entries), 1)
        self.assertTrue(entries[0]['is_gif'])


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

    def test_first_setup_rejects_weak_master_password(self) -> None:
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
        self.assertIn('çok zayıf', response.get_data(as_text=True))

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


if __name__ == "__main__":
    unittest.main()
