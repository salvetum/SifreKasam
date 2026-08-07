"""Route contract tests that protect URLs while app.py is modularized."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = Path(tempfile.mkdtemp(prefix="sifrekasam-route-tests-"))
os.environ["APPDATA"] = str(RUNTIME_DIR)
os.environ["XDG_CONFIG_HOME"] = str(RUNTIME_DIR)
sys.path.insert(0, str(ROOT / "flask_app"))

import app as app_module  # noqa: E402


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
        app_js = (ROOT / "flask_app" / "static" / "app.js").read_text(encoding="utf-8")
        appearance_js = (ROOT / "flask_app" / "static" / "appearance-settings.js").read_text(encoding="utf-8")

        self.assertNotIn("clearTimeout(appearanceSaveTimer)", app_js)
        self.assertIn("cancelPendingAppearanceSave", app_js)
        self.assertIn("cancelPendingAppearanceSave,", appearance_js)


if __name__ == "__main__":
    unittest.main()
