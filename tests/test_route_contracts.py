"""Route contract tests that protect URLs while app.py is modularized."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = Path(tempfile.mkdtemp(prefix="sifrekasam-route-tests-"))
os.environ.setdefault("APPDATA", str(RUNTIME_DIR))
os.environ.setdefault("XDG_CONFIG_HOME", str(RUNTIME_DIR))
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
    "api_stats": ("/api/stats", {"GET"}),
    "saglik_raporu": ("/saglik", {"GET"}),
    "save_settings": ("/save_settings", {"POST"}),
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

    def test_vault_pages_require_authentication(self) -> None:
        for path in ("/", "/api/stats", "/saglik"):
            with self.subTest(path=path):
                response = self.client.get(
                    path,
                    headers={"X-App-Token": app_module.APP_TOKEN},
                )
                self.assertEqual(response.status_code, 302)
                self.assertIn("/login", response.headers["Location"])


if __name__ == "__main__":
    unittest.main()
