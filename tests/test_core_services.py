import json
import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FLASK_APP_DIR = PROJECT_ROOT / "flask_app"
if str(FLASK_APP_DIR) not in sys.path:
    sys.path.insert(0, str(FLASK_APP_DIR))

from kasa_core.import_export import (  # noqa: E402
    build_export_payload,
    parse_expiry,
    parse_import_payload,
)
from kasa_core.versioning import is_newer_version  # noqa: E402


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
        self.assertTrue(is_newer_version("v2.6.0", "2.5.9-beta.2"))
        self.assertFalse(is_newer_version("v2.5.9", "2.5.9-beta.2"))


if __name__ == "__main__":
    unittest.main()
