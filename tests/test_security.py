"""Security regression tests for vault storage and login throttling."""

from __future__ import annotations

import os
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


if __name__ == "__main__":
    unittest.main()
