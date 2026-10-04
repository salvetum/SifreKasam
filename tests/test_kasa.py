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
import logging
import os
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
import time
import unittest
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from flask import Flask, session

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FLASK_APP_DIR = PROJECT_ROOT / "flask_app"
# Gerçek kasa dizinini APPDATA'yı değiştirmeden ÖNCE kaydet: izolasyon
# denetiminde bununla karşılaştıracağız. Testler yanlışlıkla gerçek kasaya
# yazarsa (bir kez oldu) buradan tespit edilir.
REAL_VAULT_DIR = (
    Path(os.environ.get("APPDATA", "")).resolve() / ".SifrekasamV2"
    if os.name == "nt"
    else Path(
        os.environ.get("XDG_CONFIG_HOME",
                       Path.home() / ".config")
    ).resolve() / "sifrekasam"
)
RUNTIME_DIR = Path(tempfile.mkdtemp(prefix="sifrekasam-tests-"))
os.environ["APPDATA"] = str(RUNTIME_DIR)
os.environ["XDG_CONFIG_HOME"] = str(RUNTIME_DIR)
# Kasa ana şifresi hâlâ bu oturumda doğrulanabiliyor olsun diye APPDATA'yı
# değiştirdikten sonra kaydedilmiş kimlik bilgilerini de temizle. Aksi halde
# Flask oturum imzası eski APPDATA'dan gelen anahtarla üretilir, modül
# önbellekleri karışır.
for _stale in ("FLASK_SECRET_KEY", "SECRET_KEY", "APP_TOKEN"):
    os.environ.pop(_stale, None)
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
    decrypt_encrypted_records_report,
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


_REAL_TEST_CLIENT = app_module.app.test_client


class _BrowserLikeClient:
    """Gerçek bir tarayıcının gönderdiği kaynak başlıklarını taklit eder.

    `_same_origin_state_change()` artık **fail-closed**: durum değiştiren bir
    istekte `Origin`/`Referer` yoksa reddedilir. Werkzeug test istemcisi bu
    başlıkları göndermez (o bir tarayıcı değil), ama Chromium/Firefox/Safari
    her durum değiştiren istekte `Origin` ve `Sec-Fetch-Site` gönderir.

    Werkzeug'da istek başına verilen `environ_base` istemci seviyesindeki
    `environ_base`'i **değiştirir**; bu yüzden sarmalama her çağrıda birleştirme
    yapar. Kaynaklı ya da reddeden testler `headers=` (environ_overrides) ile
    başlıkları kendileri geçersiz kılmaya devam eder.
    """

    def __init__(self):
        self._client = _REAL_TEST_CLIENT()

    def open(self, *args, **kwargs):
        base = dict(kwargs.pop('environ_base', None) or {})
        base.setdefault('HTTP_ORIGIN', 'http://localhost')
        base.setdefault('HTTP_SEC_FETCH_SITE', 'same-origin')
        kwargs['environ_base'] = base
        return self._client.open(*args, **kwargs)

    # Werkzeug'un `get`/`post` kısayolları iç istemcinin `open`'una doğrudan
    # gider, sarmalayıcınınkine değil; bu yüzden hepsi tek tek açılmalı.
    def get(self, *args, **kwargs):
        return self.open(*args, method='GET', **kwargs)

    def post(self, *args, **kwargs):
        return self.open(*args, method='POST', **kwargs)

    def put(self, *args, **kwargs):
        return self.open(*args, method='PUT', **kwargs)

    def patch(self, *args, **kwargs):
        return self.open(*args, method='PATCH', **kwargs)

    def delete(self, *args, **kwargs):
        return self.open(*args, method='DELETE', **kwargs)

    def __getattr__(self, name):
        return getattr(self._client, name)


def _new_test_client():
    return _BrowserLikeClient()


_JS_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_JS_LINE_COMMENT = re.compile(r"(?<![:'\"])//[^\n]*")


def _strip_js_comments(source: str) -> str:
    """JS yorumlarını siler; sözleşme denetimlerinde kullanılır.

    Ana süreç dosyalarında geçmişi anlatan yorumlar (örn. "findFreePort HER ZAMAN
    127.0.0.1'e bağlanıyordu") kalıcı kod gibi görünmesin diye önce temizlenir.
    """
    cleaned = _JS_BLOCK_COMMENT.sub(" ", source)
    return _JS_LINE_COMMENT.sub(" ", cleaned)


@contextmanager
def _silence_logs() -> None:
    """Beklenen hata yolu loglarının stderr'i kirletmesini engeller."""
    previous = logging.root.manager.disable
    try:
        logging.disable(logging.CRITICAL)
        yield
    finally:
        logging.disable(previous)

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

    def test_encrypted_import_respects_max_import_records(self) -> None:
        """DoS sınırı: şifreli içerik amplifikasyonu MAX_IMPORT_RECORDS ile kırpılır.

        MAX_CONTENT_LENGTH (64 MB) yalnızca ham gövde boyutunu sınırlar; JSON
        kayıt iç içe nesnelere dönüştüğünde liste ~10-20x büyür. Restore yolu
        bu çözülmüş listeyi `Record.query.delete()` SONRASINDA işlediği için
        sınırsız liste uygulamayı dondurabilir/çökertirdi.
        """
        from kasa_core.constants import MAX_IMPORT_RECORDS

        records = [
            {"type": "Website", "title": f"Kayit-{i}", "password": f"p{i}"}
            for i in range(MAX_IMPORT_RECORDS + 100)
        ]
        blob = build_encrypted_export_payload(records, self.PASSWORD)
        parsed = decrypt_encrypted_records(blob, self.PASSWORD)
        self.assertEqual(len(parsed), MAX_IMPORT_RECORDS)
        # Kırpma sessiz değil: ilk kayıtlar korunur, fazlası atlanır.
        self.assertEqual(parsed[0], records[0])
        self.assertEqual(parsed[-1], records[MAX_IMPORT_RECORDS - 1])

    def test_encrypted_import_at_limit_keeps_every_record(self) -> None:
        """Sınırın tam altındaki yedeklerde mevcut davranış değişmez (kırpma yok)."""
        from kasa_core.constants import MAX_IMPORT_RECORDS

        records = [{"type": "Website", "title": f"K{i}"} for i in range(5)]
        blob = build_encrypted_export_payload(records, self.PASSWORD)
        parsed = decrypt_encrypted_records(blob, self.PASSWORD)
        self.assertEqual(len(parsed), len(records))
        self.assertLess(len(records), MAX_IMPORT_RECORDS)
        self.assertEqual(parsed, records)

    def test_encrypted_import_report_exposes_dropped_count(self) -> None:
        """Raporlayan sürüm, atlanan kayıt sayısını çağırana verir.

        Çağıran (import/restore) bu sayıyı kullanıcıya gösterir; aksi halde
        sınır aşan bir yedek sessizce eksik yüklenmiş gibi görünür.
        """
        from kasa_core.constants import MAX_IMPORT_RECORDS

        records = [
            {"type": "Website", "title": f"Kayit-{i}", "password": f"p{i}"}
            for i in range(MAX_IMPORT_RECORDS + 100)
        ]
        blob = build_encrypted_export_payload(records, self.PASSWORD)
        parsed, dropped = decrypt_encrypted_records_report(blob, self.PASSWORD)
        self.assertEqual(len(parsed), MAX_IMPORT_RECORDS)
        self.assertEqual(dropped, 100)
        # Geriye dönük uyum: eski sadece-liste sürümü aynı listeyi döner.
        self.assertEqual(decrypt_encrypted_records(blob, self.PASSWORD), parsed)

    def test_encrypted_import_report_zero_dropped_within_limit(self) -> None:
        """Sınır altında atlanan kayıt yok (dropped == 0), arayüz uyarı göstermez."""
        records = [{"type": "Website", "title": f"K{i}"} for i in range(4)]
        blob = build_encrypted_export_payload(records, self.PASSWORD)
        parsed, dropped = decrypt_encrypted_records_report(blob, self.PASSWORD)
        self.assertEqual(dropped, 0)
        self.assertEqual(parsed, records)

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
        self.client = _new_test_client()

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

    def test_settings_onboarding_endpoint_persists_flag(self) -> None:
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True

        initial = self.client.get(
            '/settings/onboarding',
            headers={'X-App-Token': app_module.APP_TOKEN},
        )
        self.assertEqual(initial.status_code, 200)
        self.assertIn('done', initial.get_json())

        response = self.client.post(
            '/settings/onboarding',
            json={'done': True},
            headers={'X-App-Token': app_module.APP_TOKEN},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['done'])
        with app_module.app.app_context():
            self.assertEqual(app_module._get_setting('onboarding_done'), '1')

        after = self.client.get(
            '/settings/onboarding',
            headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        self.assertTrue(after['done'])

    def test_onboarding_marker_renders_only_for_empty_new_vault(self) -> None:
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True

        fake_query = type("FakeQuery", (), {
            "order_by": lambda self, *args, **kwargs: type(
                "FakeSelection", (), {"all": lambda self: []}
            )(),
        })()
        fernet = Fernet(Fernet.generate_key())

        with app_module.app.app_context():
            with patch.object(app_module, "get_fernet", return_value=fernet), \
                    patch.object(app_module.Record, "query", fake_query), \
                    patch.object(app_module, "_get_setting", return_value=None):
                page = self.client.get('/', headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'data-kasa-onboarding="true"', page.data)

        with app_module.app.app_context():
            with patch.object(app_module, "get_fernet", return_value=fernet), \
                    patch.object(app_module.Record, "query", fake_query), \
                    patch.object(app_module, "_get_setting", return_value="1"):
                page = self.client.get('/', headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'data-kasa-onboarding="false"', page.data)

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
        self.client = _new_test_client()

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

    def test_storage_status_detects_insufficient_free_space(self) -> None:
        import shutil
        from collections import namedtuple

        import kasa_core.paths as kasa_paths

        usage_type = namedtuple('usage', 'total used free')
        free = 1024
        total = 100 * 1024 * 1024 * 1024
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(
                shutil, "disk_usage", return_value=usage_type(total, total - free, free)
            ):
                status = kasa_paths.get_storage_status(temp_dir)
        self.assertTrue(status["space_known"])
        self.assertFalse(status["has_space"])
        self.assertTrue(status["low_space"])
        self.assertEqual(status["free_bytes"], free)

    def test_storage_status_marks_space_unknown_when_measurement_fails(self) -> None:
        import shutil

        import kasa_core.paths as kasa_paths

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(shutil, "disk_usage", side_effect=OSError("erişilemiyor")):
                status = kasa_paths.get_storage_status(temp_dir)
        # Alan ölçülemiyorsa yazma izni dışında engel üretilmemeli.
        self.assertFalse(status["space_known"])
        self.assertFalse(status["has_space"])
        self.assertTrue(status["writable"])

    def test_storage_status_detects_readonly_directory(self) -> None:
        import kasa_core.paths as kasa_paths

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(kasa_paths, "_probe_writable", return_value=(False, "permission")):
                status = kasa_paths.get_storage_status(temp_dir)
        self.assertFalse(status["writable"])
        self.assertEqual(status["error_kind"], "permission")


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
            with _silence_logs(), self.assertRaises(RuntimeError):
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
        self.client = _new_test_client()
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
            lan_client = _new_test_client()
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
            remote_client = _new_test_client()
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
        self.client = _new_test_client()

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

    def test_repeated_wrong_password_does_not_break_csrf(self) -> None:
        """Yanlış şifre 2. kez denendiğinde form kullanılamaz hale gelmemeli.

        Hatalı girişte çağrılan oturum temizliği CSRF belirtecini de siliyordu;
        bir sonraki deneme "Güvenlik doğrulaması başarısız" ile reddediliyor
        ve kullanıcı doğru şifreyi bile giremiyordu.
        """
        with app_module.app.app_context():
            app_module.db.session.add(app_module.Setting(
                key='master_hash', value=app_module.hash_master_password('Dogru-Sifre-123!')))
            app_module.db.session.add(app_module.Setting(
                key='pbkdf2_salt_b64', value=app_module._new_salt_b64()))
            app_module.db.session.add(app_module.Setting(
                key='vault_initialized', value='true'))
            app_module.db.session.commit()

        token = self._extract_csrf_token(
            self.client.get('/login').get_data(as_text=True)
        )
        # 429 (geçici kilit) veya 200 (hatalı şifre) kabul edilir; 400 ASLA olmamalı.
        for attempt in ('yanlis-sifre-1', 'yanlis-sifre-2', 'Dogru-Sifre-123!'):
            response = self.client.post('/login', data={
                'master_password': attempt, 'csrf_token': token,
            })
            self.assertNotEqual(
                response.status_code, 400,
                f'{attempt} denemesi CSRF hatasina dustu: '
                f'{response.get_data(as_text=True)[:120]}',
            )
            self.assertNotIn(
                'Güvenlik doğrulaması başarısız', response.get_data(as_text=True))

    # Kilit/CSRF dönüşümü testleri `SecurityHardeningTests` içinde yaşıyor:
    # `/lock` oturum açık değilken 403 döndürdüğü için (kilit hiç oluşmuyor)
    # buradaki sınıfta bu testler sessizce "geçiyor"du.

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

    def _first_setup_post(self, password: str, password2: str):
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False):
            token = self._extract_csrf_token(
                self.client.get('/login').get_data(as_text=True)
            )
            return self.client.post('/login', data={
                'master_password': password,
                'master_password_confirm': password2,
                'csrf_token': token,
            })

    @staticmethod
    def _storage_stub(**overrides):
        status = {
            'path': 'C:/kasa',
            'exists': True,
            'writable': True,
            'free_bytes': 5 * 1024 * 1024 * 1024,
            'total_bytes': 100 * 1024 * 1024 * 1024,
            'space_known': True,
            'has_space': True,
            'low_space': False,
            'error_kind': '',
        }
        status.update(overrides)
        return status

    def test_first_setup_blocked_when_storage_not_writable(self) -> None:
        with patch.object(
            app_module,
            "get_storage_status",
            return_value=self._storage_stub(writable=False, error_kind='permission'),
        ):
            response = self._first_setup_post('1234567890123456', '1234567890123456')
        self.assertEqual(response.status_code, 403)
        self.assertIn('yazma izni yok', response.get_data(as_text=True))

    def test_first_setup_blocked_when_free_space_insufficient(self) -> None:
        with patch.object(
            app_module,
            "get_storage_status",
            return_value=self._storage_stub(free_bytes=1024, has_space=False, low_space=True),
        ):
            response = self._first_setup_post('1234567890123456', '1234567890123456')
        self.assertEqual(response.status_code, 507)
        self.assertIn('Boş disk alanı yetersiz', response.get_data(as_text=True))

    def test_first_setup_not_blocked_when_space_cannot_be_measured(self) -> None:
        # disk_usage başarısızsa alan bilinmiyor demektir; ölçülemeyen bilgi
        # kurulumu engellememeli.
        with patch.object(
            app_module,
            "get_storage_status",
            return_value=self._storage_stub(space_known=False, has_space=False, free_bytes=0),
        ):
            response = self._first_setup_post('1234567890123457', '1234567890123457')
        self.assertEqual(response.status_code, 302)
        with app_module.app.app_context():
            app_module.Setting.query.filter_by(key='master_hash').delete()
            app_module.Setting.query.filter_by(key='pbkdf2_salt_b64').delete()
            app_module.Setting.query.filter_by(key='record_metadata_encryption_v1').delete()
            app_module.Setting.query.filter_by(key='vault_initialized').delete()
            app_module.db.session.commit()
        if os.path.exists(app_module.VAULT_INIT_FILE):
            os.remove(app_module.VAULT_INIT_FILE)

    def test_first_setup_page_shows_storage_information(self) -> None:
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False), \
                patch.object(
                    app_module,
                    "get_storage_status",
                    return_value=self._storage_stub(low_space=True),
                ):
            page = self.client.get('/login').get_data(as_text=True)
        self.assertIn('id="setup-storage-info"', page)
        self.assertIn('Kullanılacak klasör', page)
        self.assertIn('Boş alan', page)
        self.assertNotIn('Kurulumu başlatmak için önce', page)

    def test_first_setup_page_locks_button_when_blocked(self) -> None:
        with patch.object(app_module, "_vault_initialized", return_value=False), \
                patch.object(app_module, "_has_existing_vault_data", return_value=False), \
                patch.object(
                    app_module,
                    "get_storage_status",
                    return_value=self._storage_stub(free_bytes=1024, has_space=False, low_space=True),
                ):
            page = self.client.get('/login').get_data(as_text=True)
        self.assertIn('disabled aria-disabled="true"', page)
        self.assertIn('Kurulumu başlatmak için önce', page)

    def test_rollback_first_setup_removes_files_created_by_attempt(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            db_file = os.path.join(tmp, 'sifreler.db')
            init_file = os.path.join(tmp, 'vault.initialized')
            created_names = [
                db_file,
                db_file + '-journal',
                db_file + '-wal',
                db_file + '-shm',
                init_file,
                init_file + '.tmp',
            ]
            with patch.object(app_module, "DB_FILE", db_file), \
                    patch.object(app_module, "VAULT_INIT_FILE", init_file), \
                    app_module.app.app_context():
                app_module._rollback_first_setup(True)
                for name in created_names:
                    self.assertFalse(os.path.exists(name), name)
                for name in created_names:
                    with open(name, 'w', encoding='utf-8') as handle:
                        handle.write('x')
                # Mevcut kasa varsa dosyalar korunur.
                app_module._rollback_first_setup(False)
                for name in created_names:
                    self.assertTrue(os.path.exists(name), name)

    def test_setup_failure_message_explains_cause(self) -> None:
        permission_message = app_module._setup_failure_message(
            PermissionError('attempt to write a readonly database')
        )
        self.assertIn('izin', permission_message)
        space_message = app_module._setup_failure_message(OSError('database or disk is full'))
        self.assertIn('Disk alanı doldu', space_message)
        generic_message = app_module._setup_failure_message(RuntimeError('bilinmeyen'))
        self.assertIn('İlk kurulum tamamlanamadı', generic_message)

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
        self.client = _new_test_client()
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
        lan_client = _new_test_client()
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

        fresh = _new_test_client()
        data = fresh.get(
            '/api/lan-info', headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        self.assertTrue(data['lan_access_configured'])
        self.assertNotIn('lan_password', data)

    def test_lan_info_forbidden_from_remote(self) -> None:
        self._seed_vault()
        self._local_login()
        self._enable_lan()

        lan_password = self._lan_password()
        lan_client, _ = self._lan_login(lan_password, remote='192.168.1.70')

        response = lan_client.get(
            '/api/lan-info', environ_base={'REMOTE_ADDR': '192.168.1.70'},
        )
        self.assertEqual(response.status_code, 403)

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
            lan_client = _new_test_client()
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
            with _silence_logs():
                app_module._refresh_lan_access_bindings(old_key, new_key)
                self.assertEqual(app_module._unwrap_lan_vault_key(lan_password), new_key)
                self.assertIsNone(app_module._get_lan_access_password(old_key))
                self.assertEqual(
                    app_module._get_lan_access_password(new_key), lan_password,
                )


class BoundPortReportingTests(unittest.TestCase):
    """Port yarışı (TOCTOU) kapatıldı: port, dinleyiciyle birlikte doğar.

    Önceden ana süreç `findFreePort()` ile bir port seçip dinleyiciyi KAPATIYOR,
    sonra Flask o porta bağlanıyordu; aradaki boşlukta yerel bir süreç portu
    çalabiliyordu. Artık `FLASK_PORT=0` gönderilir, işletim sistemi boş portu
    seçer ve Flask `bind()`+`listen()` tamamlandıktan sonra gerçek portu
    stdout'a `KASA_PORT=<port>` satırı olarak bildirir.

    Bu sınıf üç şeyi doğrular:
      1. `_configured_port()` 0'ı kabul eder (ESKİDEN 1'e kırpılıyordu).
      2. `/api/lan-info` gerçek BAĞLANAN portu döndürür, 0'ı ASLA göstermez.
      3. Gerçek `app.py` süreci FLASK_PORT=0 ile başlatıldığında stdout'ta geçerli
         bir `KASA_PORT=<port>` satırı basar ve o port fiilen dinlemededir.
    """

    def setUp(self) -> None:
        self.client = _new_test_client()
        self._saved_bound_port = app_module._get_bound_port()

    def tearDown(self) -> None:
        app_module._bound_port = self._saved_bound_port

    def test_configured_port_accepts_zero(self) -> None:
        with patch.dict(os.environ, {'FLASK_PORT': '0'}, clear=False):
            os.environ.pop('PORT', None)
            self.assertEqual(app_module._configured_port(), 0)

    def test_configured_port_still_clamps_out_of_range(self) -> None:
        with patch.dict(os.environ, {'FLASK_PORT': '99999'}, clear=False):
            self.assertEqual(app_module._configured_port(), 65535)
        with patch.dict(os.environ, {'FLASK_PORT': 'abc'}, clear=False):
            self.assertEqual(app_module._configured_port(), 5000)

    def test_public_port_prefers_real_bound_port(self) -> None:
        with patch.dict(os.environ, {'FLASK_PORT': '0'}, clear=False):
            app_module._bound_port = 51234
            self.assertEqual(app_module._get_public_port(), 51234)

    def test_public_port_never_returns_zero(self) -> None:
        with patch.dict(os.environ, {'FLASK_PORT': '0'}, clear=False):
            app_module._bound_port = 0
            # Sunucu henüz bağlanmadıysa kullanıcıya 0 gösterilMEZ: 0
            # "belirlenmedi" anlamına gelir ve panoya kopyalanan LAN adresi
            # çalışmaz. Makul bir varsayılana düşülür.
            self.assertEqual(app_module._get_public_port(), 5000)

    def test_public_port_falls_back_to_configured_when_not_bound(self) -> None:
        with patch.dict(os.environ, {'FLASK_PORT': '5001'}, clear=False):
            app_module._bound_port = 0
            self.assertEqual(app_module._get_public_port(), 5001)

    def test_lan_info_reports_real_bound_port_not_zero(self) -> None:
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        with patch.dict(os.environ, {'FLASK_PORT': '0'}, clear=False):
            app_module._bound_port = 54321
            payload = self.client.get(
                '/api/lan-info', headers={'X-App-Token': app_module.APP_TOKEN},
            ).get_json()
        self.assertEqual(payload['port'], 54321)

    def test_lan_info_never_exposes_zero_port(self) -> None:
        with self.client.session_transaction() as session:
            session["_user_id"] = "admin"
            session["_fresh"] = True
        with patch.dict(os.environ, {'FLASK_PORT': '0'}, clear=False):
            app_module._bound_port = 0
            payload = self.client.get(
                '/api/lan-info', headers={'X-App-Token': app_module.APP_TOKEN},
            ).get_json()
        self.assertGreaterEqual(payload['port'], 1)
        self.assertLessEqual(payload['port'], 65535)

    def test_report_bound_port_writes_single_line_and_flushes(self) -> None:
        buffer = io.StringIO()
        app_module._bound_port = 0
        with patch('sys.stdout', buffer):
            app_module._report_bound_port(4711)
        self.assertEqual(app_module._get_bound_port(), 4711)
        self.assertEqual(buffer.getvalue().strip(), 'KASA_PORT=4711')
        # Ana sürecin ayrıştırdığı desene birebir uymalı.
        self.assertRegex(buffer.getvalue().strip(), r'^KASA_PORT=\d{1,5}$')

    def test_report_bound_port_rejects_invalid_values(self) -> None:
        buffer = io.StringIO()
        app_module._bound_port = 4711
        with patch('sys.stdout', buffer):
            app_module._report_bound_port(0)
            app_module._report_bound_port(70000)
            app_module._report_bound_port('port-boyle-bir-sayi')
            app_module._report_bound_port(None)
        self.assertEqual(app_module._get_bound_port(), 4711)
        self.assertEqual(buffer.getvalue(), '')

    def test_main_process_no_longer_selects_the_port(self) -> None:
        """Ana süreç port tahmin etmemeli: findFreePort geri kalmamalı."""
        main_js = _strip_js_comments((PROJECT_ROOT / "main.js").read_text(encoding="utf-8"))
        backend_process = _strip_js_comments(
            (PROJECT_ROOT / "src" / "main" / "backend-process.js").read_text(encoding="utf-8"))
        backend_net = _strip_js_comments(
            (PROJECT_ROOT / "src" / "main" / "backend-net.js").read_text(encoding="utf-8"))
        window_js = (PROJECT_ROOT / "src" / "main" / "window.js").read_text(encoding="utf-8")

        # findFreePort / isPortStillFree tamamen kalksın: port seçimi ve dinleyici
        # arasındaki ayrışma bu iki fonksiyonla mümkünydü. (Yorumlar temizlenir;
        # geçmişi anlatan yorum satırları kalıcı kod sanılmasın.)
        for source, label in ((main_js, 'main.js'),
                              (backend_process, 'backend-process.js'),
                              (backend_net, 'backend-net.js')):
            self.assertNotIn('findFreePort', source, f'{label} findFreePort icermemeli')
            self.assertNotIn('isPortStillFree', source, f'{label} isPortStillFree icermemeli')

        # Doğru sözleşme: 0 gönderilir, KASA_PORT satırı ayrıştırılır.
        self.assertIn("FLASK_PORT: '0'", backend_process)
        self.assertIn('KASA_PORT=', backend_process)
        self.assertIn('port-reported', backend_process)
        # Port bilinmeden hazır olma probu denenmemeli.
        self.assertIn('boundPortPromise', backend_process)

        # Pencere kancaları porta GÖMÜLMEZ (port başlangıçta bilinmiyor).
        self.assertNotIn('${rt.PORT}/settings/content-protection', window_js)

    def test_web_request_on_completed_registered_once(self) -> None:
        """Electron webRequest'te olay başına yalnızca SON dinleyici kullanılır.

        İki ayrı onCompleted kaydı, içerik koruması kancasının LAN mutabakatı
        kancasını SİLMESİNE yol açıyordu. Tek kayıt olmalı.
        """
        window_js = (PROJECT_ROOT / "src" / "main" / "window.js").read_text(encoding="utf-8")
        self.assertEqual(window_js.count('webRequest.onCompleted('), 1)
        # Her iki davranış da tek dinleyicide kalmalı.
        self.assertIn("endsWith('/save_settings')", window_js)
        self.assertIn("endsWith('/settings/content-protection')", window_js)

    def test_app_reports_ephemeral_port_on_real_process(self) -> None:
        """UÇTAN UCA: gerçek app.py süreci FLASK_PORT=0 ile KASA_PORT basar.

        Bu test olmadan "cheroot bind_addr gerçek portu verir" varsayımı
        doğrulanmamış kalırdı. Süreç ayrı bir ortamda açılır, stdout'tan port
        satırı okunur ve portun gerçekten bağlantı kabul ettiği ÖLÇÜLÜR
        (süreç hâlâ ayaktayken).
        """
        import socket
        import subprocess
        import threading

        # Süreç kendi kasa dizinini kullansın: ana test sürecinin DB/sertifika
        # dosyalarıyla paylaşmasın (SQLite kilidi, yeniden üretilen cert.pem).
        data_dir = Path(tempfile.mkdtemp(prefix='sifrekasam-porttest-'))
        env = dict(os.environ)
        env['FLASK_PORT'] = '0'
        env['PORT'] = '0'
        env['FLASK_HOST'] = '127.0.0.1'
        env['PYTHONIOENCODING'] = 'utf-8'
        env['PYTHONUNBUFFERED'] = '1'
        if os.name == 'nt':
            env['APPDATA'] = str(data_dir)
        else:
            env['XDG_CONFIG_HOME'] = str(data_dir)

        proc = subprocess.Popen(
            [sys.executable, str(FLASK_APP_DIR / 'app.py')],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, cwd=str(FLASK_APP_DIR), text=True, encoding='utf-8',
            errors='replace', bufsize=1,
        )
        reported_port = 0
        connection_ok = False
        try:
            def _read_port() -> None:
                nonlocal reported_port, connection_ok
                for line in proc.stdout:
                    match = re.match(r'^KASA_PORT=(\d{1,5})$', line.strip())
                    if not match:
                        continue
                    reported_port = int(match.group(1))
                    # 0 ASLA raporlanmaz: 0, "port henüz bilinmiyor" demektir ve
                    # ana süreç 0'a istek atamaz.
                    if not 1 <= reported_port <= 65535:
                        return
                    # Raporlanan port gerçekten bağlanmış olmalı (uydurma değil).
                    try:
                        with socket.create_connection(('127.0.0.1', reported_port), timeout=5):
                            connection_ok = True
                    except OSError:
                        connection_ok = False
                    return

            reader = threading.Thread(target=_read_port, daemon=True)
            reader.start()
            reader.join(timeout=60)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)
            shutil.rmtree(data_dir, ignore_errors=True)

        self.assertTrue(
            1 <= reported_port <= 65535,
            f'KASA_PORT satiri gelmedi (raporlanan: {reported_port!r})',
        )
        self.assertTrue(
            connection_ok,
            f'raporlanan port {reported_port} baglantı kabul etmiyor',
        )


class HardwareAccelerationSettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = _new_test_client()
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
        self.client = _new_test_client()
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


class SettingsDependencyLockTests(unittest.TestCase):
    """Bağımlı ayar kilitleri (settings-dependencies.js) — 2026-10.

    İki kural bu sınıfın varlık sebebi:
      1. Kilit uygulanırken **devre dışı seçeneklerin değerleri korunmalı.**
         Ayar formu GERÇEK bir HTML formu; `disabled` input'lar GÖNDERİLMEZ.
         Backend'de select/number alanlar `if 'x' in request.form:` ile
         yazıldığı için eksik gönderim değeri korur, ama checkbox'lar
         `_save_flag()` ile yazılıyor ve yerel oturumda `full_form` olduğu
         için eksik gönderim `'false'` YAZAR. Yani bağımlı bir toggle'a
         `disabled` koymak kullanıcının tercihini SİLER.
      2. Bağımlılık tablosundaki her seçici gerçekten şablonda var olmalı;
         yoksa kilit sessizce hiçbir şey yapmaz (kullanıcı bozuk UI görür).
    """

    STATIC = FLASK_APP_DIR / "static"
    SETTINGS_PARTIALS = FLASK_APP_DIR / "templates" / "partials" / "settings"

    def _read(self, name: str) -> str:
        return (self.SETTINGS_PARTIALS / name).read_text(encoding="utf-8")

    def _module(self) -> str:
        return (self.STATIC / "settings-dependencies.js").read_text(encoding="utf-8")

    def _all_settings_html(self) -> str:
        return "\n".join(
            p.read_text(encoding="utf-8") for p in sorted(self.SETTINGS_PARTIALS.glob("*.html"))
        )

    def test_toggles_never_get_the_disabled_attribute(self) -> None:
        """Değer koruma tuzağı: checkbox/radio için `disabled` YASAK."""
        module = self._module()
        self.assertIn("field.type === 'checkbox' || field.type === 'radio'", module)
        # Toggle dalında `.disabled =` YAZILMAMALI olmalı; `field.disabled`
        # yalnız select/number dalında geçmeli.
        toggle_branch = module.split("field.type === 'checkbox' || field.type === 'radio'", 1)[1]
        other_branch = toggle_branch.split("} else {", 1)[1]
        self.assertNotIn("field.disabled", toggle_branch.split("} else {", 1)[0])
        self.assertIn("field.disabled = locked", other_branch)

    def test_dependent_select_fields_are_not_disabled_in_template(self) -> None:
        """Sunucu ilk render'da da kilitlemez; kilit JS'in işidir (aksi halde
        JS yüklenmeden önce değer kaybolurdu)."""
        appearance = self._read("panel-appearance.html")
        for field in ("glass_quality", "glass_frost", "chroma_accent_speed"):
            line_start = appearance.find(f'name="{field}"')
            self.assertNotEqual(line_start, -1, f"{field} alanı bulunamadı")
            tag_end = appearance.find(">", line_start)
            tag = appearance[line_start:tag_end]
            self.assertNotIn("disabled", tag, f"{field} sunucuda disabled edilmemeli")

    def test_every_dependency_selector_exists_in_templates(self) -> None:
        """Tablodaki her parent/dependent seçici gerçekten bir elemana
        oturmalı; aksi halde kilit sessizce çalışmaz."""
        module = self._module()
        html = self._all_settings_html()
        parents = re.findall(r"parent:\s*'([^']+)'", module)
        cards = re.findall(r"card:\s*'([^']+)'", module)
        self.assertGreaterEqual(len(parents), 5)
        self.assertGreaterEqual(len(cards), 8)
        for selector in parents + cards:
            self.assertTrue(
                selector.startswith("#"), f"seçici id ile başlamalı: {selector}")
            element_id = selector[1:]
            found = any(
                f'id="{element_id}"' in (self.SETTINGS_PARTIALS / p.name).read_text(encoding="utf-8")
                for p in sorted(self.SETTINGS_PARTIALS.glob("*.html"))
            )
            self.assertTrue(found, f"şablonda yok: {selector}")

    def test_lockable_cards_have_note_slot(self) -> None:
        """Her kilitlenebilir kartın açıklama yuvası olmalı."""
        html = self._all_settings_html()
        self.assertEqual(html.count("data-lockable"), html.count("data-lock-note"))

    def test_collapse_behaviour_removed_from_glass_and_chroma(self) -> None:
        """2026-10: cam/chroma kartları artık GİZLENMİYOR, griye boyanıyor."""
        for name in ("panel-appearance.html", "panel-access.html",
                     "panel-behavior.html"):
            self.assertNotIn("is-collapsed", self._read(name), name)
        module_src = (self.STATIC / "appearance-settings.js").read_text(encoding="utf-8")
        self.assertNotIn("is-collapsed", module_src)
        self.assertNotIn("glassQualitySelect.disabled", module_src)
        self.assertNotIn("glassFrostSelect.disabled", module_src)
        self.assertNotIn("chromaSpeedSelect.disabled", module_src)
        # Tek doğruluk kaynağı kalsın.
        self.assertIn("is-locked", (self.STATIC / "settings-modal.css").read_text(encoding="utf-8"))

    def test_settings_dependency_text_is_localised(self) -> None:
        for lang in ("tr", "en"):
            data = json.loads(
                (FLASK_APP_DIR / "translations" / f"{lang}.json").read_text(encoding="utf-8")
            )
            self.assertIn("Kilitli", data, f"{lang}.json missing 'Kilitli'")
            self.assertTrue(data["Kilitli"].strip(), f"{lang}.json empty 'Kilitli'")

    def test_new_module_is_wired_everywhere(self) -> None:
        app_js = (self.STATIC / "app.js").read_text(encoding="utf-8")
        self.assertIn("from './settings-dependencies.js?v=1'", app_js)
        self.assertIn("initSettingsDependencies()", app_js)
        # Modül app.js tarafından import edilir (base.html'de <script> değil),
        # bu yüzden varlığı static/ altında doğrulanır. sw.js ASSETS listesi
        # yalnız SÜRÜMSÜZ isteklenen dosyaları içerir (bkz. ServiceWorkerCacheTests).
        self.assertTrue((self.STATIC / "settings-dependencies.js").exists())

    def test_animated_background_lock_has_explanation(self) -> None:
        """Özel arka plan etkinken "Hareketli Arkaplan" kilitlenir ve neden
        YAZILIR. 2026-10 öncesi: `disabled` + başlıkta soluk nokta — ne açıklama
        vardı ne de değer koruması (`_save_flag` tercihi sıfırlıyordu)."""
        appearance = self._read("panel-appearance.html")
        self.assertIn('id="animated-background-card"', appearance)
        # Kart gövdesinin tamamı (h4'ün `id="…"`si dilimi erken kesmesin diye
        # sabit pencere kullanılıyor).
        card_start = appearance.find('id="animated-background-card"')
        card = appearance[card_start:card_start + 1200]
        self.assertIn("data-lockable", card)
        self.assertIn("data-lock-note", card)

        module = self._module()
        self.assertIn("#animated-background-card", module)
        # Koşul tabanlı kural `when` predicate'i kullanır (üst ayar toggle değil).
        self.assertIn("when:", module)
        # Eski `disabled` yaklaşımı TAMAMEN kalktı.
        self.assertNotIn("motionToggle.disabled", module)
        self.assertNotIn("is-bg-locked", module)
        app_module_src = (self.STATIC / "appearance-settings.js").read_text(encoding="utf-8")
        self.assertNotIn("motionToggle.disabled", app_module_src)
        self.assertNotIn("is-bg-locked", app_module_src)
        self.assertIn("refreshSettingsDependencies()", app_module_src)

    def test_lock_icons_use_real_fontawesome_elements(self) -> None:
        """İkon `content` + sabit font-family ile DEĞİL, gerçek
        `<i class="fa-solid fa-lock">` ile basılmalı. Yerel all.min.css
        Font Awesome **7**; sabit sürüm yazılırsa ikon sessizce BOŞ görünür
        (AGENTS.md tuzağı). Yorumlarda geçen açıklama metni kural değildir,
        bu yüzden KURAL (`.settings-lock-note::before`) aranıyor."""
        css = (self.STATIC / "settings-modal.css").read_text(encoding="utf-8")
        self.assertNotIn('font-family: "Font Awesome', css)
        self.assertNotIn("Font Awesome 6 Free", css)
        self.assertNotIn(".settings-lock-note::before", css)
        # Buna karşılık gerçek eleman kuralı DURMALI.
        self.assertIn(".settings-lock-note > i", css)
        module = self._module()
        self.assertIn("fa-solid fa-lock", module)
        # Kilit notu ikonu gerçek eleman olarak basılıyor (innerHTML değil —
        # CSP `script-src-attr 'none'` altında innerHTML de riskli).
        self.assertNotIn("innerHTML", module)
        self.assertIn("createElement('i')", module)

    def test_lock_icon_exists_in_local_fontawesome(self) -> None:
        """Kullandığımız ikon yerel all.min.css'te GERÇEKTEN var mı?"""
        fa = (self.STATIC / "all.min.css").read_text(encoding="utf-8", errors="replace")
        self.assertRegex(fa, r"\.fa-lock[\s,{]")
        self.assertIn('--fa: "\\f023"', fa)

    def test_dead_bg_lock_css_removed(self) -> None:
        utilities = (self.STATIC / "utilities.css").read_text(encoding="utf-8")
        # Kural (`.` ile başlayan seçici) kalkmalı; yorumda geçen kelime değil.
        self.assertNotIn(".is-bg-locked", utilities)
        self.assertNotIn("is-bg-locked .settings-card-head", utilities)

    def test_partial_save_preserves_dependent_select_values(self) -> None:
        """Sunucu tarafı: bağımlı select gönderilmezse mevcut değer KORUNUR.
        (JS `disabled` bu yüzden güvenli; checkbox'ta güvenli değil.)"""
        self.assertIn("if 'glass_quality' in request.form:",
                      (FLASK_APP_DIR / "app.py").read_text(encoding="utf-8"))
        app_src = (FLASK_APP_DIR / "app.py").read_text(encoding="utf-8")
        for field in ("glass_quality", "glass_blur", "glass_veil", "glass_frost",
                      "chroma_accent_speed", "auto_lock_timeout"):
            self.assertIn(f"if '{field}' in request.form:", app_src)


class GlassOffSurfaceTests(unittest.TestCase):
    """Cam KAPALI iken yüzeylerin saydam kalmasını engeller (2026-10).

    DESEN: Çoğu yüzeyin opak görünmesi `backdrop-filter`'dan gelir; arka planı
    çok düşük opaklıklıdır (`rgba(255,255,255,0.045)`). Cam kapanınca
    `--glass-blur: none` olur → blur gider, saydam tabaka kalır. Ölçülen
    minimum opaklık: `.filter-empty-state` 0.028, form panelleri 0.032.

    Beklenen: `backdrop-filter: var(--glass-blur)` kullanan her yüzey ya
    `.glass` sınıfını taşır, ya da `data-glass-effects="off"` altında opak
    (alpha >= 0.90) bir tabaka alır.
    """

    STATIC = FLASK_APP_DIR / "static"

    # Bu yüzeyler zaten opak; `data-glass-effects="off"` kuralı gereksiz.
    ALREADY_OPAQUE = {
        ".kasa-modal .modal-content",   # modals.css: 0.88 koyu tabaka
        ".swal2-popup.kasa-swal-popup",  # modals.css: 0.88
        ".page-loading-overlay",         # modals.css: 0.72 tam kaplama
        ".kasa-dropdown-menu",           # misc.css: rgba(12,14,28,0.82)
        ".vault-card-shell",             # cards.css: 14 ayrı varyant
        ".kasa-notif-menu",              # glass.css bölüm 6
        ".lan-warning-card",             # glass.css:307
        ".glass",                        # glass.css:307
        "html[data-bs-theme=\"light\"] .kasa-navbar-inner",  # misc.css: 0.92
        # İÇ İÇE kontroller: kendi başlarına saydam kalmaları sorun DEĞİL,
        # çünkü artık opak bir kapsayıcının ÜZERİNDE duruyorlar. Saydamlık
        # kapsayıcının arkasında kalmaz, üstte yalnız ince bir vurgu katmanı
        # olur (düğme/kenar görünürlüğü için gerekli).
        ".card-page-btn",                # cards.css — .card-pagination içinde
        ".card-page-jump-input",         # cards.css — .card-pagination içinde
        ".kasa-navbar-right .kasa-btn-muted",   # glass.css — navbar içinde
        ".kasa-navbar .kasa-dropdown-trigger",  # glass.css — navbar içinde
    }

    def _css_files(self) -> dict[str, str]:
        return {p.name: p.read_text(encoding="utf-8", errors="replace")
                for p in sorted(self.STATIC.glob("*.css"))
                if p.name != "all.min.css"}

    @staticmethod
    def _strip_comments(src: str) -> str:
        return re.sub(r"/\*.*?\*/", "", src, flags=re.S)

    def _selectors_using_glass_blur(self) -> dict[str, str]:
        found: dict[str, str] = {}
        for name, src in self._css_files().items():
            for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", self._strip_comments(src)):
                sel, body = m.group(1), m.group(2)
                if "backdrop-filter" not in body or "var(--glass-blur" not in body:
                    continue
                for part in sel.split(","):
                    s = re.sub(r"\s+", " ", part.strip().replace("\n", " "))
                    if s and not s.startswith("@"):
                        found.setdefault(s, name)
        return found

    def test_every_blurred_surface_has_opaque_fallback_when_glass_off(self) -> None:
        selectors = self._selectors_using_glass_blur()
        self.assertGreater(len(selectors), 8, "denetim boş döndü — CSS ayrıştırma bozuk")
        all_css = "\n".join(self._css_files().values())
        clean = self._strip_comments(all_css)

        problems = []
        for sel, defined_in in sorted(selectors.items()):
            if sel in self.ALREADY_OPAQUE:
                continue
            base = re.split(r"[:>\s~+,]", sel)[0].strip()
            if base in (".glass", ".settings-card", ".filter-btn",
                        ".kasa-btn", ".kasa-dropdown-trigger", "#search-input",
                        ".bulk-select-all-control", ".background-choice-grid",
                        ".accent-preset-row", ".generator-output-card",
                        ".generator-options-card", ".generator-history-card",
                        ".generator-strength-card", ".settings-action-card",
                        ".kasa-custom-select", ".kasa-input"):
                continue
            # Birden fazla glass-off kuralı olabilir (farklı dosyalarda, amaçları
            # farklı: custom-select.css'teki katman/z-index, glass.css'teki
            # opak zemin). Doğrusu: OPAK OLAN BİR KURALIN VARLIĞI.
            bodies = re.findall(
                r'data-glass-effects="off"\]\s*' + re.escape(base) + r"\b[^{}]*\{([^{}]*)\}",
                clean)
            if not bodies:
                problems.append(f"{sel} ({defined_in}): glass-off kurali YOK")
                continue
            best = 0.0
            for body in bodies:
                alphas = [float(a) for a in
                          re.findall(r"rgba\([^)]*?,\s*(0?\.\d+|1)\s*\)", body)]
                for hexa in re.findall(r"#([0-9a-fA-F]{8})\b", body):
                    alphas.append(int(hexa[6:8], 16) / 255)
                best = max([best] + alphas)
            if best < 0.90:
                problems.append(
                    f"{sel} ({defined_in}): glass-off zemini saydam "
                    f"(max_alpha={best:.2f})")

        self.assertEqual(problems, [], "\n".join(problems))

    def test_pagination_surface_is_opaque_when_glass_off(self) -> None:
        """Kullanıcı raporu: anasayfa pagination kapsayıcısı saydam görünüyordu."""
        cards = self._css_files()["cards.css"]
        clean = self._strip_comments(cards)
        match = re.search(
            r'data-glass-effects="off"\]\s*\.card-pagination[^{}]*\{([^{}]*)\}', clean)
        self.assertIsNotNone(match, "cards.css'te card-pagination glass-off kurali yok")
        body = match.group(1)
        self.assertIn("0.97", body, "pagination zemini opak olmali (0.97)")
        self.assertNotIn("rgba(var(--accent-rgb), 0.07)", body)

    def test_vault_form_panels_are_opaque_when_glass_off(self) -> None:
        """Kullanıcı raporu: kayit ekle/düzenle 'tarih/kaydet' bolgesi
        karemsi/saydam gorunuyordu."""
        glass = self._css_files()["glass.css"]
        clean = self._strip_comments(glass)
        match = re.search(
            r'data-glass-effects="off"\]\s*\.vault-form-panel[^{}]*\{([^{}]*)\}', clean)
        self.assertIsNotNone(match, "glass.css'te vault-form-panel glass-off kurali yok")
        self.assertIn("0.97", match.group(1))
        for sel in (".vault-form-actions", ".vault-form-side", ".kasa-panel",
                    ".vault-generator-panel", ".filter-empty-state",
                    ".kasa-navbar-inner", ".kasa-field"):
            self.assertRegex(
                clean, re.escape(f'data-glass-effects="off"]') + r"[^\n]*" + re.escape(sel),
                f"{sel} icin glass-off kurali yok")

    def test_asset_versions_bumped_for_glass_fixes(self) -> None:
        base = (FLASK_APP_DIR / "templates" / "base.html").read_text(encoding="utf-8")
        self.assertIn("cards.css') }}?v=81", base)
        self.assertIn("glass.css') }}?v=89", base)
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
        self.assertIn("cards.css') }}?v=81", base)
        self.assertIn("theme-states.css') }}?v=74", base)
        self.assertIn("utilities.css') }}?v=76", base)
        self.assertIn("app.js') }}?v=9.50", base)
        sw = (FLASK_APP_DIR / "templates" / "sw.js").read_text(encoding="utf-8")
        self.assertIn("assets-v209", sw)
        self.assertIn("assets-v209", self._read("scripts/sw-register.html"))
        self.assertIn("entry-shell.css') }}?v=1", base)

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
        self.client = _new_test_client()
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
        response = _new_test_client().get(
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

        # Yerel tam form davranışı korunur: onay kutusu gönderilmediyse kapalı
        # yazılır, böylece kullanıcı ayarı kapatabilir.
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
        self.client = _new_test_client()
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
        anonymous = _new_test_client()
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
        self.client = _new_test_client()
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
        response = _new_test_client().get(
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
        self.client = _new_test_client()
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
        anonymous = _new_test_client()
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

    def test_delete_backup_rejects_traversal(self) -> None:
        """Savunma derinliği: _is_managed ön eki tek başına yetmez.

        `sifrekasam_otomatik_/../../kanari.kasaenc` ön eki/uzantı kontrolünden
        geçer; ancak çözümlenen yol yedek klasörünün dışına düşer. HTTP
        katmanı zaten 400 döndürdüğü için bu dışarıdan sömürülemez, fakat
        çekirdek katmanı da (read_backup ile aynı desen) reddetmelidir.
        """
        with app_module.app.app_context():
            canary = Path(self.tmpdir) / "kanari.kasaenc"
            canary.write_text("silinmemeli")
            with self.assertRaises(ValueError):
                app_module._backups.delete_backup(
                    self.tmpdir, "sifrekasam_otomatik_/../../kanari.kasaenc")
            self.assertTrue(canary.exists(), "Klasör dışı dosya silinmemeli")
            canary.unlink()


class AutomaticBackupApiTests(unittest.TestCase):
    """Otomatik yedek API yüzeyleri: list/create/delete/restore + güvenlik."""

    STRONG = "Xk9$vT2!mQ8@wL4#"

    def setUp(self) -> None:
        self.client = _new_test_client()
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
        anonymous = _new_test_client()
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

    def test_restore_reports_truncated_record_count(self) -> None:
        """Sınır aşan yedekte atlanan kayıt sayısı arayüze bildirilir.

        Arayüz (data-panel.js) `truncated` alanını görüp uyarı toast'u gösterir;
        alan yoksa kullanıcı sessizce eksik yükleme yaptığını sanar.
        """
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            with app_module.app.app_context():
                app_module.db.session.add(
                    self._fixture("tr-a", password=self.STRONG))
                app_module.db.session.commit()
            created = self.client.post(
                "/api/backups/create", headers=self._headers()).get_json()
            filename = created["backup"]["filename"]
            with patch.object(app_module, "_decrypt_encrypted_records_report",
                              return_value=([{"type": "Website",
                                               "title": "tr-b",
                                               "password": self.STRONG}], 7)):
                response = self.client.post(
                    "/api/backups/restore",
                    json={"filename": filename, "confirm": True},
                    headers=self._headers())
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["restored"], 1)
        self.assertEqual(body["truncated"], 7)

    def test_restore_reports_zero_truncated_for_normal_backup(self) -> None:
        """Sınır altındaki yedekte `truncated` 0 olur → arayüz uyarı göstermez."""
        with patch.object(app_module, "get_fernet",
                          return_value=self.fernet):
            with app_module.app.app_context():
                app_module.db.session.add(
                    self._fixture("tr-c", password=self.STRONG))
                app_module.db.session.commit()
            created = self.client.post(
                "/api/backups/create", headers=self._headers()).get_json()
            filename = created["backup"]["filename"]
            response = self.client.post(
                "/api/backups/restore",
                json={"filename": filename, "confirm": True},
                headers=self._headers())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["truncated"], 0)

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
        self.client = _new_test_client()
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


class SecurityHardeningTests(unittest.TestCase):
    """Güvenlik sertleştirmesi regresyon testleri (beta4 güvenlik turu)."""

    MASTER = 'test-master-password'
    NEW_MASTER = 'test-master-password-new'

    def setUp(self) -> None:
        self.client = _new_test_client()
        login_lockout._login_attempts.clear()
        self._reset_vault_state()

    def tearDown(self) -> None:
        login_lockout._login_attempts.clear()
        self._reset_vault_state()

    @classmethod
    def _reset_vault_state(cls) -> None:
        with app_module.app.app_context():
            # Ağ/kilit/yedek damgası ayarları da temizlenir: bu sınıftaki testler
            # bunları seed ediyor veya gerçekten yazıyor, sızarsa sonraki testin
            # kararını değiştirir (sızıntı, üretim hatası değil test izolasyonu
            # hatasıdır).
            for key in ('master_hash', 'pbkdf2_salt_b64', 'vault_initialized',
                        'lan_enabled', 'lan_full_access_enabled',
                        'lan_reveal_passwords_enabled',
                        'auto_lock_enabled', 'auto_lock_timeout',
                        # 2026-10: bu anahtar SIFIRLANMADIĞI için sürecin ilk
                        # girişinde `migrate_plaintext_record_metadata` tüm
                        # metadata'yı ana şifreden türetilen Fernet ile
                        # şifreliyor ve testin `encrypt_metadata` ile yazdığı
                        # `card_holder` çözülemez hale geliyordu → kart-ismi
                        # sızıntı assertion'ı koşul bağımsız olmaktan çıkıp
                        # BOŞ (vacuous) kalıyordu. Aynı sınıftan bir izolasyon
                        # hatasının yeni örneği (bkz. SECURITY.md).
                        app_module.RECORD_METADATA_SETTING,
                        app_module.LAST_BACKUP_SETTING,
                        app_module._backups.LAST_AUTO_BACKUP_SETTING):
                app_module.Setting.query.filter_by(key=key).delete()
            # Kayıt tabloları da temizlenir. Bu sınıftaki testler kasa ANAHTARI
            # ile şifreli kayıt bırakıyor; sızarsa sonraki testin şifre
            # değiştirme (_reencrypt_task) işlemi TÜM kayıtları gezdiği için
            # Fernet InvalidToken ile çöküyordu. Sızma bir hata üretmiyor, ANCAK
            # yanlış test sırasına yol açıyordu (izole GEÇEN, tam koşuda FAIL).
            app_module.Record.query.delete()
            app_module.PasswordHistory.query.delete()
            app_module.db.session.commit()
            with app_module._vault_keys_lock:
                app_module._vault_keys.clear()
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
    def _csrf(html: str) -> str:
        match = re.search(r'name="csrf_token" value="([^"]+)"', html)
        assert match is not None
        return match.group(1)

    def _login(self) -> str:
        token = self._csrf(self.client.get('/login').get_data(as_text=True))
        response = self.client.post('/login', data={
            'master_password': self.MASTER, 'csrf_token': token,
        })
        self.assertEqual(response.status_code, 302)
        return self.client.get('/login').headers.get('Set-Cookie') or ''

    def _session_csrf(self) -> str:
        page = self.client.get('/').get_data(as_text=True)
        match = re.search(r'window\.KASA_CSRF_TOKEN\s*=\s*"([^"]+)"', page)
        assert match is not None, 'csrf token sayfada bulunamadı'
        return match.group(1)

    # ── Kilit: CSRF belirteci korunmaz, yenilenir ──────────────────────────
    #
    # Önceki sürümde burada `test_lock_preserves_csrf_token` vardı ve
    # oturumsuz sınıfta çalışıyordu: `/lock` 403 döndürdüğü için kilit hiç
    # oluşmuyor, belirteç de zaten değişmiyordu → test yanlış sebeple geçiyordu.
    # Artık oturum açık, belirteç gönderiliyor ve kilidin GERÇEKTEN oluştuğu
    # doğrulanıyor.

    def test_lock_rotates_csrf_token(self) -> None:
        """Kasa kilitlenirken CSRF belirteci yenilenir (ayrıcalık değişti)."""
        self._seed_vault()
        self._login()
        token = self._session_csrf()
        response = self.client.post(
            '/lock', data={'csrf_token': token},
            headers={'X-CSRF-Token': token})
        self.assertIn(response.status_code, (200, 302),
                      msg=f'kilit gerçekleşmedi: {response.status_code}')
        with self.client.session_transaction() as sess:
            rotated = sess.get('csrf_token')
        self.assertTrue(rotated)
        self.assertNotEqual(rotated, token)

    def test_lock_without_csrf_token_is_rejected(self) -> None:
        """Oturumlu olsa bile belirteç olmadan /lock reddedilir."""
        self._seed_vault()
        self._login()
        token = self._session_csrf()
        response = self.client.post('/lock')
        self.assertEqual(response.status_code, 400)
        with self.client.session_transaction() as sess:
            self.assertEqual(sess.get('csrf_token'), token)

    # ── Oturum çerezinin SameSite=Strict olduğu için yalnızca GET/HEAD dışı
    # isteklerde Origin zorunluluğu ölçülür.

    # ── Otomatik kilit (sunucu tarafı hareketsizlik)
    # Renderer çökerse/kaparsa anahtar _VAULT_KEY_TTL (60 dk) boyunca bellekte
    # kalırdı; bu yüzden hareketsizlik sunucu tarafında da ölçülür.

    def _set_auto_lock(self, enabled: str, minutes: int) -> None:
        with app_module.app.app_context():
            app_module.Setting.query.filter(
                app_module.Setting.key.in_(('auto_lock_enabled',
                                             'auto_lock_timeout'))).delete()
            app_module.db.session.add(app_module.Setting(
                key='auto_lock_enabled', value=enabled))
            app_module.db.session.add(app_module.Setting(
                key='auto_lock_timeout', value=str(minutes)))
            app_module.db.session.commit()

    def _set_idle(self, seconds_ago: float) -> None:
        with self.client.session_transaction() as sess:
            sess[app_module._IDLE_SESSION_KEY] = time.time() - seconds_ago

    def test_idle_session_is_locked_server_side(self) -> None:
        """Eşik aşılmış hareketsiz oturum sunucu tarafında kilitlenir."""
        self._seed_vault()
        self._set_auto_lock('true', 5)
        self._login()
        self.assertEqual(self.client.get('/').status_code, 200)
        with self.client.session_transaction() as sess:
            sid = sess['vault_session_id']
        with app_module.app.app_context():
            self.assertIsNotNone(
                app_module._get_vault_key_for(sid),
                'oturum açıkken anahtar bellekte olmalı')

        self._set_idle(5 * 60 + 30)          # 5 dk eşiğini aştı
        response = self.client.get('/')
        self.assertEqual(response.status_code, 302)
        self.assertIn('/login', response.headers.get('Location', ''))
        with app_module.app.app_context():
            self.assertIsNone(app_module._get_vault_key_for(sid),
                              'kilitlenince bellekte anahtar kalmamalı')

    def test_active_session_stays_unlocked(self) -> None:
        """Son etkinlik eşiğin içindeyse oturum açık kalır (sunucu renderer'dan
        da gevşek olmalı: bir HTTP isteği kullanıcı girdisi sayılmaz)."""
        self._seed_vault()
        self._set_auto_lock('true', 5)
        self._login()
        self._set_idle(5 * 60 - 30)          # eşiğin hemen içinde
        self.assertEqual(self.client.get('/').status_code, 200)

    def test_heartbeat_does_not_refresh_idle_timer(self) -> None:
        """Heartbeat bir canlılık sinyalidir, kullanıcı etkinliği DEĞİLDİR.

        Sayılırsa otomatik kilit hiç tetiklenmezdi (kullanıcı hiçbir şey
        yapmasa bile 15 sn'de bir yenilenir) — en tehlikeli regresyon.

        Doğrulama iki aşamalı: (1) heartbeat oturumu KİLİTLEMEMELİ (anahtar
        bellekte kalmalı), (2) sonraki gerçek kullanıcı isteği kilitlemeli.
        Tek başına "sonuç 302" demek yeterli değil: mutasyonda heartbeat'in
        kendisi oturumu sıfırladığı için test yanlış sebeple geçerdi.
        """
        self._seed_vault()
        self._set_auto_lock('true', 5)
        self._login()
        with self.client.session_transaction() as sess:
            sid = sess['vault_session_id']
        self._set_idle(5 * 60 + 30)          # eşik aşıldı

        for _ in range(3):
            self.client.post('/heartbeat', headers={
                'X-App-Token': app_module.APP_TOKEN})

        with app_module.app.app_context():
            self.assertIsNotNone(
                app_module._get_vault_key_for(sid),
                'heartbeat oturumu kilitlememeli (canlılık sinyali != etkinlik)')
        # Gerçek kullanıcı isteği gelince hareketsizlik uygulanmalı.
        self.assertEqual(self.client.get('/').status_code, 302)

    def test_idle_lock_respects_disabled_setting(self) -> None:
        """Otomatik kilit kapalıyken sunucu tarafı kilitlemez."""
        self._seed_vault()
        self._set_auto_lock('false', 5)
        self._login()
        self._set_idle(5 * 60 + 30)
        self.assertEqual(self.client.get('/').status_code, 200)

    def test_lock_endpoint_is_exempt_from_idle_check(self) -> None:
        """/lock kendisi idle kontrolünden muaf: renderer'ın manuel kilidi,
        kontrolü tetikleyen istek olduğu için reddedilmemeli."""
        self._seed_vault()
        self._set_auto_lock('true', 5)
        self._login()
        csrf = self._session_csrf()          # eşiği aşmadan token al
        self._set_idle(5 * 60 + 30)
        response = self.client.post('/lock', headers={'X-CSRF-Token': csrf})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['status'], 'locked')

    def test_settings_tray_post_requires_csrf_token(self) -> None:
        self._seed_vault()
        self._login()
        response = self.client.post('/settings/tray', json={'minimize_to_tray': True})
        self.assertEqual(response.status_code, 400)

    def test_settings_tray_is_not_csrf_exempt(self) -> None:
        self.assertNotIn('settings_tray', app_module._TOKEN_ENDPOINTS)
        self.assertIn('settings_tray', app_module._TOKEN_READ_ENDPOINTS)

    def test_settings_tray_readable_with_app_token(self) -> None:
        response = self.client.get(
            '/settings/tray', headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(response.status_code, 200)
        self.assertIn('minimize_to_tray', response.get_json())

    def test_content_protection_readable_with_app_token(self) -> None:
        # Önceden ana süreç bu uçta 302 alıyordu ve özellik sessizce ölüydü.
        response = self.client.get(
            '/settings/content-protection',
            headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(response.status_code, 200)
        self.assertIn('content_protection_enabled', response.get_json())

    def test_content_protection_post_requires_session(self) -> None:
        response = self.client.post(
            '/settings/content-protection',
            json={'content_protection_enabled': True},
            headers={'X-App-Token': app_module.APP_TOKEN})
        self.assertEqual(response.status_code, 302)

    def test_settings_language_rejected_for_anonymous_remote(self) -> None:
        response = self.client.post(
            '/settings/language', json={'language': 'en'},
            environ_base={'REMOTE_ADDR': '192.168.1.77'})
        self.assertEqual(response.status_code, 403)

    def test_settings_language_allowed_locally_without_session(self) -> None:
        # Dil seçici giriş/kilit/yükleme ekranlarında oturumsuz da çalışmalı.
        response = self.client.post('/settings/language', json={'language': 'en'})
        self.assertEqual(response.status_code, 200)

    def test_legacy_vault_login_migrates_to_per_install_salt(self) -> None:
        """Legacy (sabit salt) kasa girişte per-install salt'a taşınır.

        `derive_key` legacy salt'a düşse bile bu kasa legacy salt ile
        kullanılmaz: login sırasında `migrate_legacy_pbkdf2_salt` çalışır.
        """
        legacy_fernet = Fernet(app_module._derive_key_with_salt(
            self.MASTER,
            app_module.LEGACY_PBKDF2_SALT,
            app_module.LEGACY_PBKDF2_ITERATIONS,
        ))
        with app_module.app.app_context():
            # Per-install salt YOK (eski kasa) + legacy salt ile şifrelenmiş kayıt
            app_module.db.session.add(app_module.Setting(
                key='master_hash',
                value=app_module.hash_master_password(self.MASTER),
            ))
            app_module.db.session.add(app_module.Record(
                id="legacy-login-record",
                type="Website",
                category="Genel",
                title="Legacy",
                encrypted_password=app_module.safe_encrypt(legacy_fernet, "eski-sifre"),
                encrypted_comment=app_module.safe_encrypt(legacy_fernet, "eski-not"),
            ))
            app_module.db.session.commit()
            try:
                with patch.object(app_module, "backup_database"), \
                     patch.object(app_module, "_refresh_database_backup"):
                    token = self._csrf(self.client.get('/login').get_data(as_text=True))
                    response = self.client.post('/login', data={
                        'master_password': self.MASTER, 'csrf_token': token,
                    })
                self.assertEqual(response.status_code, 302)
                # Salt artık kayıtlı (rastgele) ve kayıt yeni anahtarla çözülüyor.
                saved_salt = app_module._get_saved_pbkdf2_salt()
                self.assertIsNotNone(saved_salt)
                self.assertNotEqual(saved_salt, app_module.LEGACY_PBKDF2_SALT)
                app_module.db.session.expire_all()
                migrated = app_module.db.session.get(app_module.Record, "legacy-login-record")
                new_fernet = Fernet(app_module.derive_key(self.MASTER))
                self.assertEqual(
                    app_module.safe_decrypt(new_fernet, migrated.encrypted_password),
                    "eski-sifre")
            finally:
                # Kaydı bırakma: sonraki testler `_reencrypt_task` ile TÜM kayıtları
                # geziyor; yarım kalan şifreli bir satır onları kırabilir.
                app_module.db.session.rollback()
                app_module.Record.query.filter_by(id="legacy-login-record").delete()
                app_module.db.session.commit()

    def test_login_blocked_when_legacy_salt_migration_fails(self) -> None:
        """Migration başarısızsa giriş DURDURULUR (sessizce legacy salt'ta devam yok).

        Sabit salt ile devam etmek, kaynak kodda bulunan salt'la açılabilen bir
        kasa bırakır; bu yüzden hata halinde giriş reddedilir.
        """
        with app_module.app.app_context():
            app_module.db.session.add(app_module.Setting(
                key='master_hash',
                value=app_module.hash_master_password(self.MASTER),
            ))
            app_module.db.session.commit()
            with patch.object(app_module, "migrate_legacy_pbkdf2_salt",
                              side_effect=RuntimeError("simulated migration failure")):
                token = self._csrf(self.client.get('/login').get_data(as_text=True))
                response = self.client.post('/login', data={
                    'master_password': self.MASTER, 'csrf_token': token,
                })
        self.assertEqual(response.status_code, 500)
        self.assertIn("giriş durduruldu",
                      response.get_data(as_text=True))
        # Salt yazılmadı: kasa legacy modda açılmadı.
        with app_module.app.app_context():
            self.assertIsNone(app_module._get_saved_pbkdf2_salt())

    def test_state_change_from_foreign_origin_rejected(self) -> None:
        response = self.client.post(
            '/settings/language', json={'language': 'en'},
            headers={'Origin': 'https://evil.example'})
        self.assertEqual(response.status_code, 403)

    def test_state_change_rejected_when_browser_signalled_without_origin(self) -> None:
        response = self.client.post(
            '/settings/language', json={'language': 'en'},
            headers={'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(response.status_code, 403)

    def test_state_change_with_same_origin_allowed(self) -> None:
        response = self.client.post(
            '/settings/language', json={'language': 'en'},
            headers={'Origin': 'http://localhost'})
        self.assertEqual(response.status_code, 200)

    def test_remote_client_cannot_change_critical_settings(self) -> None:
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module.db.session.commit()
        for field in ('auto_lock_enabled', 'lan_enabled', 'internet_kill_switch'):
            with self.subTest(field=field):
                response = self.client.post(
                    '/save_settings', data={field: '1'},
                    headers={'X-CSRF-Token': self._session_csrf()},
                    environ_base={'REMOTE_ADDR': '192.168.1.77'})
                self.assertEqual(response.status_code, 403)

    def test_remote_partial_form_does_not_reset_flags(self) -> None:
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            # Uzak istemci yalnızca LAN açıkken erişebilir. Kısmi form
            # davranışı salt okunur moddan BAĞIMSIZ olduğu için (ve bu test
            # o kuralı sınamak için) burada tam yetki açılır.
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module._set_setting('power_save_enabled', 'true')
            app_module._set_setting('card_sheen_enabled', 'true')
            app_module.db.session.commit()
        # Kısmi form gönderilen alan dışındaki bayrakları SİLMEZ. Gönderilen
        # alan `auto_lock_timeout` değil `accent_color`: timeout 2026-10'da
        # yerel-only yapıldı, uzak istemci artık onu yazamaz.
        response = self.client.post(
            '/save_settings', data={'accent_color': '#4f91ff'},
            headers={'X-CSRF-Token': self._session_csrf()},
            environ_base={'REMOTE_ADDR': '192.168.1.77'})
        self.assertEqual(response.status_code, 302)
        with app_module.app.app_context():
            self.assertEqual(app_module.get_power_save_enabled(), True)
            self.assertEqual(app_module.get_card_sheen_enabled(), True)

    def test_local_form_can_still_turn_flags_off(self) -> None:
        # Onay kutusu gönderilmediyse ayar "kapalı" yazılır (UI davranışı korunur).
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module.save_power_save('true')
            app_module.db.session.commit()
        response = self.client.post(
            '/save_settings', data={'auto_lock_timeout': '5'},
            headers={'X-CSRF-Token': self._session_csrf()})
        self.assertEqual(response.status_code, 302)
        with app_module.app.app_context():
            self.assertEqual(app_module.get_power_save_enabled(), False)

    def test_password_change_invalidates_other_sessions(self) -> None:
        # Ana şifre değişince tetikleyen dışındaki oturumların anahtarı düşer;
        # aksi halde eski anahtarla yazılan kayıt kalıcı çözülemez.
        self._seed_vault()
        with app_module.app.app_context():
            old_key = app_module.derive_key(self.MASTER)
            new_key = app_module.derive_key(self.NEW_MASTER)
        with app_module.app.test_request_context('/'):
            app_module._set_vault_key_bytes(old_key)
            session_a = session['vault_session_id']
        with app_module.app.test_request_context('/'):
            app_module._set_vault_key_bytes(old_key)
            session_b = session['vault_session_id']
        with app_module.app.app_context():
            self.assertIsNotNone(app_module._get_vault_key_for(session_b))
            app_module._reencrypt_task(
                'test-task', old_key, new_key,
                app_module.hash_master_password(self.NEW_MASTER), session_a)
        with app_module.app.app_context():
            self.assertIsNone(app_module._get_vault_key_for(session_b),
                             'Eski oturum anahtarı düşürülmeliydi.')
            self.assertEqual(app_module._get_vault_key_for(session_a), new_key)
            self.assertIsNotNone(app_module._get_vault_key_for(session_a))

    def test_import_internal_error_returns_500(self) -> None:
        self._seed_vault()
        self._login()
        with patch.object(app_module.db.session, 'commit',
                          side_effect=sqlite3.OperationalError('database is locked')):
            response = self.client.post(
                '/import',
                data={'file': (io.BytesIO(
                    json.dumps([{'title': 'T', 'password': 'p',
                                 'type': 'Website'}]).encode()), 'x.json')},
                headers={'X-CSRF-Token': self._session_csrf()},
                content_type='multipart/form-data')
        self.assertEqual(response.status_code, 500)

    def test_lan_session_is_read_only_by_default(self) -> None:
        # LAN erişimi açıkken uzak oturum kasayı OKUYABİLİR ama yazamaz.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module.db.session.commit()
        # Okuma çalışır.
        self.assertEqual(
            self.client.get('/api/stats', environ_base={'REMOTE_ADDR': '192.168.1.80'}).status_code,
            200)
        # Yazma reddedilir: hem kasa kaydı hem de durum değiştiren uçlar.
        for path, payload in (
            ('/save_settings', {'auto_lock_timeout': '9'}),
            ('/api/notifications/dismiss', {'id': 'backup-2026-01-01'}),
        ):
            with self.subTest(path=path):
                response = self.client.post(
                    path, data=payload,
                    headers={'X-CSRF-Token': self._session_csrf()},
                    environ_base={'REMOTE_ADDR': '192.168.1.80'})
                self.assertEqual(response.status_code, 403)
                self.assertIn('salt okunur',
                              response.get_json().get('error', ''))

    def test_lan_full_access_opt_in_restores_write(self) -> None:
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(
                lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module.db.session.commit()
        # NOT: `auto_lock_timeout` artık yerel-only (2026-10) ve burada kullanılamaz;
        # "uzak tam yetki yazabiliyor" sözleşmesini uzaktan değiştirilebilen
        # GERÇEK bir görünüm ayarı kanıtlamak daha doğru olurdu, ama bu testin
        # amacı yalnızca yazma iznidir.
        response = self.client.post(
            '/save_settings', data={'accent_color': '#4f91ff'},
            headers={'X-CSRF-Token': self._session_csrf()},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 302)

    def test_lan_read_only_allows_lock_but_not_machine_preferences(self) -> None:
        # Salt okunur mod oturum uçlarını kapatmamalı: kullanıcı telefonunu
        # kilitleyebilmeli. Ancak MAKİNEye ait tercihler (tepsiye, arayüz dili)
        # artık uzak istemciden değiştirilemez — bunlar kasa verisi değil ama
        # uzak bir cihazın uygulamanın davranışını değiştirmemesi gerekir.
        # NOT: dil seçicinin oturum AÇIKken çalışması gerekmez; giriş/kilit
        # ekranındaki seçici kimlik doğrulanmamışken çalışır ve bu kontrol
        # yalnızca oturum açıkken devrededir.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module.db.session.commit()
        lock = self.client.post(
            '/lock', headers={'X-CSRF-Token': self._session_csrf()},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(lock.status_code, 200)
        self._login()
        lang = self.client.post(
            '/settings/language', data={'language': 'en'},
            headers={'X-CSRF-Token': self._session_csrf()},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(lang.status_code, 403)
        with app_module.app.app_context():
            self.assertNotEqual(app_module.get_saved_language(), 'en')

    def test_language_change_rejected_for_anonymous_remote_client(self) -> None:
        # Önceden onaylanmış davranış (M-D düzeltmesi): dil değişimi uzak
        # ANONİM istemciden yapılamaz. Yani uzak bir cihazda dil seçici zaten
        # çalışmıyordu; salt okunur muafiyetinden `settings_language`'ı
        # çıkarmak hiçbir işlevsellik kaybettirmedi.
        self._seed_vault()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module.db.session.commit()
        response = self.client.post(
            '/settings/language', data={'language': 'en'},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 403)
        with app_module.app.app_context():
            self.assertNotEqual(app_module.get_saved_language(), 'en')

    def test_language_change_still_works_locally_without_session(self) -> None:
        # Bu bilgisayarda oturumsuz da değiştirilebilir (giriş ekranı seçicisi).
        self._seed_vault()
        response = self.client.post(
            '/settings/language', data={'language': 'en'})
        self.assertEqual(response.status_code, 200)

    def test_local_session_never_blocked_by_lan_read_only(self) -> None:
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module.db.session.commit()
        response = self.client.post(
            '/save_settings', data={'auto_lock_timeout': '9'},
            headers={'X-CSRF-Token': self._session_csrf()})
        self.assertEqual(response.status_code, 302)

    def test_lan_full_access_setting_cannot_be_changed_remotely(self) -> None:
        # Tam yetki açmak da yalnızca bu bilgisayardan mümkün olmalı; aksi halde
        # uzak istemci önce salt okunur kısıtını kaldırıp sonra yazabilirdi.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(
                lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module.db.session.commit()
        response = self.client.post(
            '/save_settings', data={'lan_full_access_enabled': '1'},
            headers={'X-CSRF-Token': self._session_csrf()},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 403)

    # ── LAN: aktarım uçları tam yetkiden BAĞIMSIZ olarak kapalı ──────────────
    #
    # "LAN oturumlarına tam yetki" kayıt düzenleme yetkisidir. Kasayı bir
    # dosyaya dökmek (veya içeriden geri yüklemek) bambaşka bir yetenek; şifre
    # yöneticisinde asıl tehlike odur. Bu yüzden dışa/içe aktarma ve yedekleme
    # uçları, tam yetki anahtarı AÇIK olsa bile uzak LAN oturumuna reddedilir.

    _LAN_TRANSFER_DENIED_PATHS = (
        ('get', '/export', None),
        ('get', '/api/backups', None),
        ('get', '/api/health/export', None),
        ('post', '/api/export/encrypted', {}),
        ('post', '/api/backups/create', {}),
        ('post', '/api/backups/delete', {'filename': 'x.kasaenc'}),
        ('post', '/api/backups/restore', {'filename': 'x.kasaenc', 'confirm': True}),
        ('post', '/api/health/backup', {}),
        ('post', '/api/bulk/export', {'ids': ['1']}),
    )

    def test_lan_cannot_export_or_backup_even_with_full_access(self) -> None:
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(
                lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module.db.session.commit()
        csrf = self._session_csrf()
        for method, path, payload in self._LAN_TRANSFER_DENIED_PATHS:
            with self.subTest(path=path):
                response = self.client.open(
                    path, method=method.upper(), json=payload,
                    headers={'X-CSRF-Token': csrf},
                    environ_base={'REMOTE_ADDR': '192.168.1.80'})
                self.assertEqual(response.status_code, 403)
                self.assertIn('dışa aktarılamaz',
                              response.get_json().get('error', ''))

    def test_lan_import_is_blocked(self) -> None:
        # /import multipart olduğu için ayrı test: yanıt yine 403 olmalı ve
        # hiçbir kayıt eklenmemeli.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(
                lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module.db.session.commit()
        response = self.client.post(
            '/import',
            data={'file': (__import__('io').BytesIO(
                json.dumps([{'title': 'LAN', 'password': 'p',
                             'type': 'Website'}]).encode()), 'x.json')},
            headers={'X-CSRF-Token': self._session_csrf()},
            content_type='multipart/form-data',
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 403)
        with app_module.app.app_context():
            self.assertEqual(
                app_module.Record.query.filter_by(title='LAN').count(), 0)

    def test_local_can_export_and_backup_normally(self) -> None:
        # Aynı uçlar bu bilgisayardan çalışmaya devam etmeli.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(
                lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module.db.session.commit()
        csrf = self._session_csrf()
        self.assertEqual(
            self.client.get('/api/backups').status_code, 200)
        self.assertEqual(
            self.client.post('/api/health/backup', json={},
                             headers={'X-CSRF-Token': csrf}).status_code, 200)
        self.assertEqual(
            self.client.post('/api/backups/create', json={},
                             headers={'X-CSRF-Token': csrf}).status_code, 200)

    def test_transfer_block_requires_lan_enabled(self) -> None:
        # LAN kapalıyken uzak istemci zaten oturum alamıyor; kural tetiklenmemeli.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'false')
            app_module.db.session.commit()
        response = self.client.get(
            '/api/backups', environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertIn(response.status_code, (302, 403))

    # ── LAN: açık metin şifre gösterme varsayılan KAPALI ───────────────────
    #
    # Salt okunur mod "ağdaki cihaz kasanı görebilir" demekti; bu yüzden şifre
    # gizlemeyi kapatmak bir ayrı anahtar olarak eklendi (varsayılan kapalı).
    # Tam yetkiden BAĞIMSIZ: tam yetki = kayıt düzenleme, şifre gösterme değil.

    def _seed_encrypted_record(self) -> tuple[str, Fernet]:
        """Sabit bir Fernet ile şifreli kayıt oluşturur.

        Kayıt yazma ve şifre okuma tarafları aynı `get_fernet()` çağrısını
        paylaştığı için ikisi de bu yardımcının döndürdüğü Fernet'e bağlanır
        (paketin mevcut deseniyle aynı).
        """
        fernet = Fernet(Fernet.generate_key())
        with app_module.app.app_context():
            record = app_module.Record(
                id=f'reveal-{os.urandom(6).hex()}',
                type='Website', category='Genel', title='GizliKayit',
                login='kullanici',
                encrypted_password=app_module.safe_encrypt(fernet, 'Gizli-Sifre-1!'))
            app_module.db.session.add(record)
            app_module.db.session.commit()
            return record.id, fernet

    def test_lan_password_reveal_is_hidden_by_default(self) -> None:
        self._seed_vault()
        self._login()
        record_id, fernet = self._seed_encrypted_record()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(
                lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module.db.session.commit()
        remote = {'REMOTE_ADDR': '192.168.1.80'}
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.get(
                f'/api/record/{record_id}/password', environ_base=remote)
            self.assertEqual(response.status_code, 403)
            self.assertIn('gizleniyor', response.get_json().get('error', ''))
            # Şifre hiçbir şekilde sızmamalı.
            self.assertNotIn('Gizli-Sifre', response.get_data(as_text=True))
            self.assertEqual(
                self.client.get(f'/gecmis/{record_id}',
                                environ_base=remote).status_code, 403)

    def test_lan_reveal_opt_in_restores_password_access(self) -> None:
        self._seed_vault()
        self._login()
        record_id, fernet = self._seed_encrypted_record()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(
                lan_access_module.LAN_REVEAL_PASSWORDS_SETTING, 'true')
            app_module.db.session.commit()
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.get(
                f'/api/record/{record_id}/password',
                environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json().get('password'), 'Gizli-Sifre-1!')

    def test_local_reveal_always_allowed(self) -> None:
        # Bu bilgisayarda şifre gizleme ayarı ne olursa olsun çalışmaz.
        self._seed_vault()
        self._login()
        record_id, fernet = self._seed_encrypted_record()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module.db.session.commit()
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.get(f'/api/record/{record_id}/password')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json().get('password'), 'Gizli-Sifre-1!')

    def test_reveal_setting_cannot_be_changed_remotely(self) -> None:
        # Anahtarı uzak istemci açamaz; aksi halde önce kuralı kaldırıp
        # sonra şifre okuyabilirdi.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            # Tam yetki AÇIK: reddedilme nedeni salt-okunur kuralı DEĞİL,
            # "bu ayar yalnızca yerel değiştirilebilir" kuralı olmalı.
            app_module._set_setting(
                lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module.db.session.commit()
        response = self.client.post(
            '/save_settings', data={'lan_reveal_passwords_enabled': '1'},
            headers={'X-CSRF-Token': self._session_csrf()},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 403)
        with app_module.app.app_context():
            self.assertNotEqual(
                app_module._get_setting(
                    lan_access_module.LAN_REVEAL_PASSWORDS_SETTING), 'true')

    # ── LAN: kart no / kart üstü isim / not da SIRR'dır (2026-10 turu) ──────
    #
    # Bulgu: `_LAN_REVEAL_ENDPOINTS` yalnız iki API ucunu kapsıyordu ve
    # `_enforce_lan_read_only` yalnız POST/PUT/PATCH/DELETE'ye bakıyordu. Bu
    # yüzden "LAN'da şifreleri göster" KAPALIyken:
    #   - `GET /duzenle/<id>` düz metin şifreyi forma basıyordu (200),
    #   - `GET /` (ana ızgara, LAN'ın ASIL görünümü) tam kart numarasını, kart
    #     üzerindeki ismi ve not/SecureNote metnini düz metin basıyordu.
    # `Şifre`/`CVV` zaten `SECRET_PLACEHOLDER` ile maskeliydi; bu satırlar
    # maskeye değil, hiç oluşturulmamaya bağlandı (sır şablona hiç girmesin).

    _CARD_NUMBER = '4111111111111111'
    _CARD_HOLDER = 'Kart Sahibi Ad Soyad'
    _COMMENT = 'Not metni siri'
    _NOTE_BODY = 'Guvenli notun tam icerigi'

    def _seed_secret_carrier_records(self) -> Fernet:
        """Kart no / kart ismi / not / SecureNote taşıyan kayıtları ekler."""
        fernet = Fernet(Fernet.generate_key())
        with app_module.app.app_context():
            app_module.db.session.add_all([
                app_module.Record(
                    id=f'grid-web-{os.urandom(6).hex()}',
                    type='Website', category='Genel', title='IzgaraWeb',
                    login='kullanici',
                    encrypted_password=app_module.safe_encrypt(
                        fernet, 'Gizli-Sifre-1!'),
                    encrypted_comment=app_module.safe_encrypt(
                        fernet, self._COMMENT),
                ),
                app_module.Record(
                    id=f'grid-card-{os.urandom(6).hex()}',
                    type='CreditCard', category='Genel', title='IzgaraKart',
                    # Kart numarası CreditCard kaydında `login` alanında tutulur.
                    login=self._CARD_NUMBER,
                    card_holder=app_module.encrypt_metadata(
                        fernet, self._CARD_HOLDER),
                    encrypted_password=app_module.safe_encrypt(
                        fernet, '123'),
                ),
                app_module.Record(
                    id=f'grid-note-{os.urandom(6).hex()}',
                    type='SecureNote', category='Genel', title='IzgaraNot',
                    encrypted_comment=app_module.safe_encrypt(
                        fernet, self._NOTE_BODY),
                ),
            ])
            app_module.db.session.commit()
        return fernet

    def _enable_lan_from_remote_view(self) -> Fernet:
        """LAN açık + şifre gösterimi KAPALI (güvenli varsayılan) ve sır
        taşıyan kayıtlar eklenmiş durumda. Seed edilen Fernet'i döndürür.

        Kayıtlar `_login()`'den SONRA eklenir: `login` sırasında çalışan
        `migrate_plaintext_record_metadata` düz metin metadata'yı şifreliyor,
        yani önce eklenen kayıtların `encrypt_metadata` ile yazılmış alanları
        çözülemez hale gelirdi (2026-10'da ölçüldü). Tek kaynaklıdır: testler
        ayrıca `_seed_secret_carrier_records()` çağırmamalıdır, yoksa kayıtlar
        iki kez eklenir.
        """
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            app_module._set_setting('lan_enabled', 'true')
            app_module._set_setting(
                lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
            app_module.db.session.commit()
        return self._seed_secret_carrier_records()

    def test_lan_grid_does_not_leak_card_number_holder_or_notes(self) -> None:
        """Ana ızgara uzak LAN oturumuna sır basmamalı (başlık/ kullanıcı adı
        dışında). Regresyon: kart no, kart ismi, not ve SecureNote metni."""
        fernet = self._enable_lan_from_remote_view()
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.get(
                '/', environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        for secret in (self._CARD_NUMBER, self._CARD_HOLDER,
                       self._COMMENT, self._NOTE_BODY, 'Gizli-Sifre-1!'):
            self.assertNotIn(secret, body)
        # Kasanın LAN'daki amacı bozulmamalı: başlıklar görünür.
        self.assertIn('IzgaraKart', body)
        self.assertIn('IzgaraNot', body)

    def test_lan_grid_still_shows_secrets_to_local_user(self) -> None:
        """Gizleme YALNIZCA uzak oturuma uygulanır; yerel kullanıcı her şeyi
        görmeye devam eder."""
        fernet = self._enable_lan_from_remote_view()
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.get(
                '/', environ_base={'REMOTE_ADDR': '127.0.0.1'})
        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        for secret in (self._CARD_NUMBER, self._CARD_HOLDER,
                       self._COMMENT, self._NOTE_BODY):
            self.assertIn(secret, body)

    def test_lan_edit_form_get_is_blocked_when_reveal_disabled(self) -> None:
        """`/duzenle/<id>` formu sırları düz metin basar; uzak oturum açamamalı."""
        fernet = self._enable_lan_from_remote_view()
        with app_module.app.app_context():
            record_id = app_module.Record.query.filter_by(
                title='IzgaraKart').first().id
        remote = {'REMOTE_ADDR': '192.168.1.80'}
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            blocked = self.client.get(f'/duzenle/{record_id}',
                                      environ_base=remote)
            self.assertEqual(blocked.status_code, 403)
            body = blocked.get_data(as_text=True)
            for secret in (self._CARD_NUMBER, self._CARD_HOLDER, '123'):
                self.assertNotIn(secret, body)
            # Yerel kullanıcı formu açabilmeli.
            local = self.client.get(f'/duzenle/{record_id}',
                                    environ_base={'REMOTE_ADDR': '127.0.0.1'})
            self.assertEqual(local.status_code, 200)
            self.assertIn(self._CARD_NUMBER, local.get_data(as_text=True))

    def test_lan_edit_form_available_when_reveal_opted_in(self) -> None:
        """Reveal açıkken uzak tam-yetkili istemci formu görebilmeli."""
        fernet = self._enable_lan_from_remote_view()
        with app_module.app.app_context():
            app_module._set_setting(
                lan_access_module.LAN_REVEAL_PASSWORDS_SETTING, 'true')
            record_id = app_module.Record.query.filter_by(
                title='IzgaraKart').first().id
            app_module.db.session.commit()
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.get(
                f'/duzenle/{record_id}',
                environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 200)
        self.assertIn(self._CARD_NUMBER, response.get_data(as_text=True))

    # ── LAN: savunma ayarlarını uzak istemci zayıflatamaz (2026-10 turu) ───
    #
    # Bulgu: `_LOCAL_ONLY_SETTING_FIELDS` `auto_lock_enabled` içeriyordu ama
    # `auto_lock_timeout` İÇERMİYORDU. `save_settings` timeout'u koşulsuz
    # yazdığı için uzak "tam yetkili" oturum 5 dakikalık otomatik kilidi
    # 240 dakikaya çekebiliyordu. Aynı sınıfta `content_protection_enabled`
    # (ekran yakalama engeli) ve `auto_backup_interval` de açıktı; ilki ayrı
    # bir JSON ucu üzerinden yazıldığı için form kontrolü onu hiç görmüyordu.

    def test_remote_cannot_weaken_auto_lock_timeout(self) -> None:
        fernet = self._enable_lan_from_remote_view()
        csrf = self._session_csrf()
        with app_module.app.app_context():
            app_module._set_setting('auto_lock_enabled', 'true')
            app_module._set_setting('auto_lock_timeout', '5')
            app_module.db.session.commit()
        response = self.client.post(
            '/save_settings', data={'auto_lock_timeout': '240'},
            headers={'X-CSRF-Token': csrf},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 403)
        with app_module.app.app_context():
            self.assertEqual(app_module._get_setting('auto_lock_timeout'), '5')
        # Yerel kullanıcı ayarlayabilmeli.
        self.assertIn(
            self.client.post('/save_settings', data={'auto_lock_timeout': '30'},
                             headers={'X-CSRF-Token': csrf}).status_code,
            (200, 302))
        with app_module.app.app_context():
            self.assertEqual(app_module._get_setting('auto_lock_timeout'), '30')

    def test_remote_cannot_disable_content_protection(self) -> None:
        """Ekran yakalama engeli ayrı bir JSON ucundan yazılıyordu; form
        denetimi oraya hiç uzanmıyordu."""
        fernet = self._enable_lan_from_remote_view()
        csrf = self._session_csrf()
        with app_module.app.app_context():
            app_module._set_setting('content_protection_enabled', 'true')
            app_module.db.session.commit()
        response = self.client.post(
            '/settings/content-protection',
            json={'content_protection_enabled': False},
            headers={'X-CSRF-Token': csrf},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 403)
        with app_module.app.app_context():
            self.assertEqual(
                app_module._get_setting('content_protection_enabled'), 'true')

    def test_remote_cannot_change_hardware_acceleration(self) -> None:
        fernet = self._enable_lan_from_remote_view()
        csrf = self._session_csrf()
        response = self.client.post(
            '/settings/hardware-acceleration',
            json={'hardware_acceleration_enabled': False},
            headers={'X-CSRF-Token': csrf},
            environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 403)

    # ── Boş/formsız gövde savunma ayarını sıfırlıyordu (2026-10, 2. tur) ───
    #
    # Bulgu: `_reject_remote_critical_settings` "anahtar gönderildi mi" diye
    # bakıyordu ama YAZMA koşulsuzdu. `str(None).lower()` == 'none' ve okuma
    # tarafı `value == 'true'` olduğu için `{}` gövdesi ekran yakalama
    # engelini sessizce kapatıyordu. `test_remote_cannot_disable_content_protection`
    # yalnız anahtarı gönderdiği için bu yolu göremiyordu.

    def test_empty_body_cannot_disable_content_protection(self) -> None:
        for body, kwargs in (({}, {'json': {}}),
                             (None, {'data': {}}),
                             ({}, {'data': {'csrf_token': ''}})):
            with self.subTest(body=body):
                # Her alt-varyant arası kasa durumu TEMİZLENİR: aksi halde
                # ikinci `_seed_vault()` aynı settings satırını ikinci kez
                # ekleyip UNIQUE constraint'e takılıyor.
                self._reset_vault_state()
                self._seed_vault()
                self._login()
                with app_module.app.app_context():
                    app_module._set_setting('lan_enabled', 'true')
                    app_module._set_setting(
                        lan_access_module.LAN_FULL_ACCESS_SETTING, 'true')
                    app_module._set_setting('content_protection_enabled', 'true')
                    app_module.db.session.commit()
                headers = {'X-CSRF-Token': self._session_csrf()}
                response = self.client.post(
                    '/settings/content-protection', headers=headers,
                    environ_base={'REMOTE_ADDR': '192.168.1.80'}, **kwargs)
                self.assertIn(response.status_code, (400, 403))
                with app_module.app.app_context():
                    self.assertEqual(
                        app_module._get_setting('content_protection_enabled'),
                        'true')

    def test_content_protection_accepts_explicit_boolean(self) -> None:
        # Yazma hâlâ çalışıyor: `false` gönderilince 'false' yazılmalı,
        # 'none' gibi bir bozuk değer DEĞİL.
        self._seed_vault()
        self._login()
        response = self.client.post(
            '/settings/content-protection',
            json={'content_protection_enabled': False},
            headers={'X-CSRF-Token': self._session_csrf()})
        self.assertEqual(response.status_code, 200)
        with app_module.app.app_context():
            self.assertEqual(
                app_module._get_setting('content_protection_enabled'), 'false')

    # ── `/saglik` kart numarası sızdırıyordu (2026-10, 2. tur) ────────────
    #
    # `index()` kart numarasını gizliyordu ama sağlık raporu ikinci bir render
    # yoluydu: `reports.py` çözülmüş `login`'i `record_data` içine koyuyor,
    # `saglik.html` bunu `data-pop-login` olarak basıyordu. `lan_full_access`
    # gerekmiyordu — salt okunur LAN oturumu yeterliydi.

    def test_lan_health_report_hides_card_number(self) -> None:
        fernet = self._enable_lan_from_remote_view()
        # Zayıf/eski/süresi dolu listelerinden birine girmesi için kasıtlı
        # olarak zayıf bir kart şifresi kullanıldı (123).
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.get(
                '/saglik', environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(self._CARD_NUMBER, response.get_data(as_text=True))

    def test_local_health_report_still_shows_card_number(self) -> None:
        fernet = self._enable_lan_from_remote_view()
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.get(
                '/saglik', environ_base={'REMOTE_ADDR': '127.0.0.1'})
        self.assertEqual(response.status_code, 200)
        self.assertIn(self._CARD_NUMBER, response.get_data(as_text=True))

    # ── Kısmi düzenleme formu kaydı silmiyor (2026-10, 2. tur) ───────────
    #
    # D1 `/duzenle` GET'ini uzak oturuma kapattı ama POST'u açık bıraktı.
    # `_record_from_form` her alan için `request.form.get(...)` kullanıyordu;
    # alan yoksa `''` yazılıyordu. Yani yalnız CSRF gönderen bir uzak istek
    # kaydın 10 alanının tamamını sessizce sıfırlıyor, PasswordHistory de
    # yazılmıyordu (geri dönüş yolu yok).

    def test_partial_edit_form_preserves_existing_secrets(self) -> None:
        fernet = self._enable_lan_from_remote_view()
        with app_module.app.app_context():
            record_id = app_module.Record.query.filter_by(
                title='IzgaraKart').first().id
        csrf = self._session_csrf()
        # Yalnız yorum değişiyor; diğer alanlar formda YOK.
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.post(
                f'/duzenle/{record_id}',
                data={'comment': 'Guncel Not', 'csrf_token': csrf},
                headers={'X-CSRF-Token': csrf},
                environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 302)
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            body = self.client.get(
                f'/duzenle/{record_id}',
                environ_base={'REMOTE_ADDR': '192.168.1.80'}).get_data(
                    as_text=True)
        # Sır alanları korunmuş olmalı (form yine 403 döner, o yüzden
        # doğrulama doğrudan DB üzerinden yapılır).
        with app_module.app.app_context():
            record = app_module.db.session.get(app_module.Record, record_id)
            self.assertEqual(
                app_module.decrypt_metadata(fernet, record.login),
                self._CARD_NUMBER)
            self.assertEqual(
                app_module.decrypt_metadata(fernet, record.card_holder),
                self._CARD_HOLDER)
            self.assertEqual(
                app_module.safe_decrypt(fernet, record.encrypted_password),
                '123')
            self.assertEqual(
                app_module.decrypt_metadata(fernet, record.title),
                'IzgaraKart')
            self.assertEqual(
                app_module.safe_decrypt(fernet, record.encrypted_comment),
                'Guncel Not')
        del body

    def test_full_edit_form_still_overwrites_every_field(self) -> None:
        """Kısmi koruma, tam formun çalışmasını bozmamalı."""
        fernet = self._enable_lan_from_remote_view()
        with app_module.app.app_context():
            record_id = app_module.Record.query.filter_by(
                title='IzgaraKart').first().id
        csrf = self._session_csrf()
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            self.client.post(
                f'/duzenle/{record_id}',
                data={
                    'kayit_tipi': 'Website', 'kategori': 'Is', 'isim': 'YeniBaslik',
                    'website_url': 'https://example.com', 'login': 'yeni-kullanici',
                    'email': 'yeni@example.com', 'password': 'Yeni-Sifre-9!',
                    'comment': 'Yeni Not', 'card_holder': '', 'expiry_date': '',
                    'csrf_token': csrf,
                },
                headers={'X-CSRF-Token': csrf})
        with app_module.app.app_context():
            record = app_module.db.session.get(app_module.Record, record_id)
            self.assertEqual(record.type, 'Website')
            self.assertEqual(
                app_module.decrypt_metadata(fernet, record.title), 'YeniBaslik')
            self.assertEqual(
                app_module.safe_decrypt(fernet, record.encrypted_password),
                'Yeni-Sifre-9!')
            self.assertEqual(record.card_holder, '')

    def test_remote_post_to_edit_is_still_allowed(self) -> None:
        """D1'in bilinçli kararı: gösterim kapalıyken bile LAN 'tam yetki'
        düzenlemeye izinlidir. Bu ayrım mutasyonla kırılabilir olduğu için
        testiyle korunuyor."""
        fernet = self._enable_lan_from_remote_view()
        with app_module.app.app_context():
            record_id = app_module.Record.query.filter_by(
                title='IzgaraWeb').first().id
        csrf = self._session_csrf()
        with patch.object(app_module, 'get_fernet', return_value=fernet):
            response = self.client.post(
                f'/duzenle/{record_id}',
                data={'isim': 'UzaktanGuncellendi', 'csrf_token': csrf},
                headers={'X-CSRF-Token': csrf},
                environ_base={'REMOTE_ADDR': '192.168.1.80'})
        self.assertEqual(response.status_code, 302)
        with app_module.app.app_context():
            self.assertEqual(
                app_module.decrypt_metadata(
                    fernet, app_module.db.session.get(
                        app_module.Record, record_id).title),
                'UzaktanGuncellendi')

    def test_resource_isolation_headers(self) -> None:
        # Aynı kökenden beslenen bir kasa uygulaması için kaynak kökeni
        # yalıtımı: yanlış kaynaktan gömülemez (no-cors) ve pencere paylaşımı
        # kesilir. COEP require-corp BİLİNÇLİ OLARAK EKLENMEDİ — cam dokusu
        # data: URI kullandığı için görsel kırılma yaratırdı.
        response = self.client.get('/login')
        self.assertEqual(response.headers.get('Cross-Origin-Opener-Policy'),
                         'same-origin')
        self.assertEqual(response.headers.get('Cross-Origin-Resource-Policy'),
                         'same-origin')
        self.assertEqual(response.headers.get('X-Permitted-Cross-Domain-Policies'),
                         'none')
        # HSTS yok: sertifika kendinden imzalı, tarayıcı bypass edemez.
        self.assertIsNone(response.headers.get('Strict-Transport-Security'))
        # Mevcut başlıklar bozulmamalı.
        self.assertEqual(response.headers.get('X-Frame-Options'), 'DENY')
        self.assertEqual(response.headers.get('Referrer-Policy'), 'same-origin')

    def test_export_does_not_mark_last_backup(self) -> None:
        # Dışa aktarma kasaya yedek YAZMAZ; damgaya dokunursa "yedek alınmadı"
        # hatırlatması hiç gerçek yedek alınmadan susuyordu.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            before = app_module._get_setting(app_module.LAST_BACKUP_SETTING)
            response = self.client.get('/export')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                app_module._get_setting(app_module.LAST_BACKUP_SETTING), before)

    def test_encrypted_export_does_not_mark_last_backup(self) -> None:
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            before = app_module._get_setting(app_module.LAST_BACKUP_SETTING)
            response = self.client.post(
                '/api/export/encrypted',
                data={'csrf_token': self._session_csrf()},
                headers={'X-CSRF-Token': self._session_csrf()})
            self.assertIn(response.status_code, (200, 302))
            self.assertEqual(
                app_module._get_setting(app_module.LAST_BACKUP_SETTING), before)

    def test_real_backup_still_marks_last_backup(self) -> None:
        # Ters yön garantisi: gerçek yedek damgayı güncellemeye DEVAM eder.
        self._seed_vault()
        self._login()
        with app_module.app.app_context():
            self.assertIsNone(app_module._get_setting(app_module.LAST_BACKUP_SETTING))
            response = self.client.post(
                '/api/health/backup',
                data={'csrf_token': self._session_csrf()},
                headers={'X-CSRF-Token': self._session_csrf()})
            self.assertEqual(response.status_code, 200)
            self.assertIsNotNone(
                app_module._get_setting(app_module.LAST_BACKUP_SETTING))


class AuditLogTests(unittest.TestCase):
    """Güvenlik olay günlüğü: yazım, sır reddi, maskeleme, log enjeksiyonu.

    Her test kendi geçici günlük dizinini açar ve ``tearDown`` ile modülü
    uygulamanın gerçek LOGS_DIR'ine geri bağlar; testler birbirinin günlüğüne
    yazmaz.
    """

    MASTER = 'test-master-password'

    def setUp(self) -> None:
        from kasa_core import audit as audit_module

        self.audit_module = audit_module
        self.logs_dir = tempfile.mkdtemp(prefix="sifrekasam-audit-")
        self.addCleanup(shutil.rmtree, self.logs_dir, True)
        self.addCleanup(audit_module.set_audit_log_dir, app_module.LOGS_DIR)
        self.assertTrue(audit_module.set_audit_log_dir(self.logs_dir))
        self.log_path = Path(self.logs_dir) / audit_module.AUDIT_FILE_NAME

    def _raw_lines(self) -> list[str]:
        if not self.log_path.exists():
            return []
        return [
            line for line in
            self.log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def _events(self) -> list[str]:
        return [entry["event"] for entry in self.audit_module.read_audit_log()]

    # ── Temel yazma ──────────────────────────────────────────────────────────

    def test_writes_single_json_line_with_tag(self) -> None:
        self.assertTrue(self.audit_module.audit("test_olay", adet=1))

        lines = self._raw_lines()
        self.assertEqual(len(lines), 1)
        self.assertIn(self.audit_module.AUDIT_TAG, lines[0])
        payload = json.loads(lines[0][len(self.audit_module.AUDIT_TAG):].strip())
        self.assertEqual(payload["event"], "test_olay")
        self.assertEqual(payload["adet"], 1)
        self.assertIn("ts", payload)

    def test_file_name_and_rotation_match_backend_log(self) -> None:
        self.assertEqual(self.audit_module.AUDIT_FILE_NAME, "guvenlik-olaylari.log")
        self.assertEqual(self.audit_module.AUDIT_MAX_BYTES, 1024 * 1024)
        self.assertEqual(self.audit_module.AUDIT_BACKUP_COUNT, 3)

    def test_set_log_dir_is_idempotent(self) -> None:
        self.audit_module.audit("ilk")
        # Aynı dizinle tekrar çağrı: mevcut dosya kaybolmamalı.
        self.assertTrue(self.audit_module.set_audit_log_dir(self.logs_dir))
        self.audit_module.audit("ikinci")
        self.assertEqual(self._events(), ["ilk", "ikinci"])

    def test_console_line_carries_security_tag(self) -> None:
        with self.assertLogs("kasa_core.audit", level="INFO") as captured:
            self.audit_module.audit("konsol_olayi")
        self.assertTrue(
            any(self.audit_module.AUDIT_TAG in line and "konsol_olayi" in line
                for line in captured.output),
            captured.output,
        )

    # ── Sır reddi ────────────────────────────────────────────────────────────

    def test_secret_field_rejects_whole_event(self) -> None:
        self.assertFalse(self.audit_module.audit("sirli", password="gizli"))

        raw = self.log_path.read_text(encoding="utf-8") if self.log_path.exists() else ""
        self.assertNotIn("gizli", raw)
        # Olay hiç yazılmamış olmalı: yalnızca değer değil, olay da düşer.
        self.assertEqual(self._raw_lines(), [])

    def test_allowlist_names_are_stored_normalized(self) -> None:
        # Alan adları `_normalize_field_name()` ile karşılaştırılır ve o
        # fonksiyon alfasayı olmayan karakterleri (alt çizgi dahil) atar.
        # İzin listesine alt çizgili hâliyle yazılan bir ad HİÇBİR ZAMAN
        # eşleşmez ve her olay sessizce düşer — bu hataya karşı düzeltildi
        # (kayit_sayisi / uzaktan_mi bu yüzden kaydırıldı).
        normalize = self.audit_module._normalize_field_name
        unnormalized = sorted(
            name for name in self.audit_module.ALLOWED_FIELD_NAMES
            if normalize(name) != name
        )
        self.assertEqual(unnormalized, [])

    def test_unknown_field_name_rejects_whole_event(self) -> None:
        # Red listesi TEK BAŞINA yeterli değildi: `icerik` / `kullanici`
        # gibi listede olmayan adlar geçer sayılıp içlerine ne konursa
        # konsunsun düz yazılıyordu (ölçüldü: parola sızdı). Varsayılan-red
        # (allowlist) olmadan "kasa verisi asla yazılmaz" garantisi yoktur.
        for name in ("icerik", "kullanici", "baslik", "gizli", "kayit"):
            with self.subTest(field=name):
                self.assertFalse(
                    self.audit_module.audit("sizinti", **{name: "Gizli-Sifre-42!"}))
        raw = self.log_path.read_text(encoding="utf-8") if self.log_path.exists() else ""
        self.assertNotIn("Gizli-Sifre-42!", raw)
        self.assertEqual(self._raw_lines(), [])

    def test_allowlist_covers_every_field_used_by_call_sites(self) -> None:
        # app.py'deki gerçek çağrı noktalarının alan adları izin listesinde
        # olmalı; değilse olaylar sessizce kaybolur ve günlük boş görünür.
        import re
        source = app_module.__file__
        with open(source, encoding="utf-8") as handle:
            body = handle.read()
        used = set()
        for match in re.finditer(r"_audit\('[^']+'([^)]*)\)", body):
            for field in re.findall(r"(\w+)\s*=", match.group(1)):
                used.add(field)
        missing = sorted(
            name for name in used
            if not self.audit_module._is_allowed_field(name)
        )
        self.assertEqual(missing, [], f"İzin listesinde olmayan çağrı alanları: {missing}")

    def test_every_documented_secret_name_is_rejected(self) -> None:
        for name in ("master_password", "new_password", "token", "secret",
                     "ciphertext", "hash", "salt", "title", "username"):
            with self.subTest(field=name):
                self.assertFalse(
                    self.audit_module.audit("sirli", **{name: "deger"}))
        self.assertEqual(self._raw_lines(), [])

    def test_nested_denied_field_rejects_event(self) -> None:
        # Üst anahtar izinli görünse de iç içe parola taşımamalı.
        self.assertFalse(
            self.audit_module.audit("sirli", sebep={"password": "gizli"}))
        self.assertEqual(self._raw_lines(), [])

    def test_fernet_like_values_are_masked(self) -> None:
        # Hem Fernet BELİRTECİ (şifreli metin) hem Fernet ANAHTARI maskelenir.
        #
        # 🔴 "Anahtar 'g' ile başlamaz" bir ÖZELLİK DEĞİL, rastgelelik eseridir:
        # ölçüldü (20.000 üretimde %1.61'i 'g' ile başlıyor → assert ~1/64 ihtimalle
        # kırılıyordu). Maskeleyicinin ayırt edicisi ÖN EK DEĞİL, biçimdir
        # (audit.py: _FERNET_KEY_RE = 43 karakter + '='). Bu yüzden anahtarı
        # belirli olarak 'g' ile başlamayan bir değere sabitliyoruz; test artık
        # deterministik ve maskeleme davranışını aynı güçte sınıyor.
        token = Fernet(Fernet.generate_key()).encrypt(b"kayit").decode()
        key = "z" + Fernet.generate_key().decode()[1:]
        self.assertTrue(token.startswith("g"))
        self.assertFalse(key.startswith("g"))
        self.assertEqual(len(key), 44)

        for ad, value in (("belirtec", token), ("anahtar", key)):
            with self.subTest(deger=ad):
                self.assertTrue(self.audit_module.audit("maskeli", sebep=value))
                entry = self.audit_module.read_audit_log()[-1]
                self.assertEqual(entry["sebep"], self.audit_module.AUDIT_MASKED)

        raw = self.log_path.read_text(encoding="utf-8")
        self.assertNotIn(token, raw)
        self.assertNotIn(key, raw)

    def test_long_value_is_truncated(self) -> None:
        self.audit_module.audit("uzun", sebep="x" * 500)
        entry = self.audit_module.read_audit_log()[-1]
        self.assertEqual(len(entry["sebep"]),
                         self.audit_module.AUDIT_MAX_VALUE_CHARS)

    def test_log_injection_cannot_forge_extra_line(self) -> None:
        self.audit_module.audit(
            "enjeksiyon",
            sebep='ilk\n[GUVENLIK] {"event": "sahte_olay", "ts": "2000-01-01"}',
        )

        # Asıl güvenlik özelliği: gömülü satır sonu TEMİZLENİR, dolayısıyla
        # dosyada tek satır vardır ve sahte olay ayrı bir olay olarak
        # AYRIŞTIRILAMAZ. (Değerin JSON kaçışları içinde metin olarak kalması
        # bir sızıntı değildir; sahte günlük satırı oluşturmaz.)
        raw = self.log_path.read_text(encoding="utf-8")
        self.assertEqual(len(self._raw_lines()), 1)
        self.assertEqual(self._events(), ["enjeksiyon"])
        self.assertNotIn('"event": "sahte_olay"', raw)

    # ── Okuma ────────────────────────────────────────────────────────────────

    def test_read_returns_latest_in_chronological_order(self) -> None:
        for index in range(5):
            self.audit_module.audit(f"olay_{index}")

        events = [entry["event"] for entry in self.audit_module.read_audit_log(3)]
        self.assertEqual(events, ["olay_2", "olay_3", "olay_4"])

    def test_read_skips_corrupt_lines(self) -> None:
        self.audit_module.audit("iyi_1")
        with open(self.log_path, "a", encoding="utf-8") as handle:
            handle.write("{bu json degil}\n")
        self.audit_module.audit("iyi_2")

        self.assertEqual(self._events(), ["iyi_1", "iyi_2"])

    def test_read_before_first_write_returns_empty(self) -> None:
        # set_audit_log_dir dizini oluşturur ama dosya ilk yazımda açılır.
        fresh = Path(tempfile.mkdtemp(prefix="sifrekasam-audit-yok-"))
        self.addCleanup(shutil.rmtree, fresh, True)
        self.assertTrue(self.audit_module.set_audit_log_dir(str(fresh)))
        self.assertEqual(self.audit_module.read_audit_log(), [])

    def test_read_with_zero_or_negative_limit_returns_empty(self) -> None:
        self.audit_module.audit("olay")
        self.assertEqual(self.audit_module.read_audit_log(0), [])
        self.assertEqual(self.audit_module.read_audit_log(-5), [])

    # ── Hata toleransı ───────────────────────────────────────────────────────

    def test_write_failure_does_not_raise(self) -> None:
        # Altındaki dosya akışı dışarıdan kapatılırsa emit hata fırlatır;
        # audit() bunu yutmalı, uygulamayı düşürmemeli.
        self.audit_module.audit("once")
        handler = self.audit_module._handler
        self.assertIsNotNone(handler)
        handler.stream.close()

        with self.assertLogs("kasa_core.audit", level="INFO"):
            # İstisna YÜKSELTMEMELİ; başarısızlık False ile bildirilir.
            self.assertFalse(self.audit_module.audit("yazilamadi"))

    def test_unwritable_log_dir_does_not_break_startup(self) -> None:
        blocker = Path(self.logs_dir) / "dosya"
        blocker.write_text("bir dosya", encoding="utf-8")
        # Dizin olması gereken yerde dosya var: makedirs başarısız olur.
        self.assertFalse(
            self.audit_module.set_audit_log_dir(str(blocker / "logs")))
        with self.assertLogs("kasa_core.audit", level="INFO"):
            self.assertFalse(self.audit_module.audit("yazilamadi"))

    def test_audit_never_raises_on_hostile_input(self) -> None:
        class _Explosive:
            def __str__(self) -> str:
                raise RuntimeError("değer üretilemiyor")

        with self.assertLogs("kasa_core.audit", level="INFO"):
            # Geçersiz olay adı: yazılmaz, istisna yok.
            self.assertFalse(self.audit_module.audit(None))
            self.assertFalse(self.audit_module.audit("   "))
            self.assertFalse(self.audit_module.audit(123))
            # __str__ hata fırlatan değer: yutulur, istisna YÜKSELMEZ.
            self.assertFalse(self.audit_module.audit("ok", sebep=_Explosive()))
            # Sayı/bool JSON için yerinde kalır.
            self.assertTrue(self.audit_module.audit("ok", adet=5, toplam=1))
        # Patlayan değerden hiçbir iz kalmadı; yalnızca geçerli olay yazıldı.
        self.assertEqual(self._events(), ["ok"])


class AuditLogIntegrationTests(unittest.TestCase):
    """Uç tetiklendiğinde olayın dosyada GERÇEKTEN bulunduğu."""

    MASTER = 'test-master-password'

    def setUp(self) -> None:
        from kasa_core import audit as audit_module

        self.audit_module = audit_module
        self.logs_dir = tempfile.mkdtemp(prefix="sifrekasam-audit-int-")
        self.addCleanup(shutil.rmtree, self.logs_dir, True)
        self.addCleanup(audit_module.set_audit_log_dir, app_module.LOGS_DIR)
        self.assertTrue(audit_module.set_audit_log_dir(self.logs_dir))
        self.log_path = Path(self.logs_dir) / audit_module.AUDIT_FILE_NAME

        self.client = _new_test_client()
        login_lockout._login_attempts.clear()
        self._reset_vault_state()
        self._seed_vault()

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
                value=app_module.hash_master_password(cls.MASTER)))
            app_module.db.session.add(app_module.Setting(
                key='pbkdf2_salt_b64', value=app_module._new_salt_b64()))
            app_module.db.session.add(app_module.Setting(
                key='vault_initialized', value='true'))
            app_module.db.session.commit()

    @staticmethod
    def _extract_csrf(html: str) -> str:
        match = re.search(r'name="csrf_token" value="([^"]+)"', html)
        assert match is not None, "CSRF token bulunamadı"
        return match.group(1)

    def _local_login(self) -> None:
        token = self._extract_csrf(
            self.client.get('/login').get_data(as_text=True))
        response = self.client.post('/login', data={
            'master_password': self.MASTER, 'csrf_token': token,
        })
        self.assertEqual(response.status_code, 302)

    def _session_csrf(self) -> str:
        with self.client.session_transaction() as flask_session:
            return flask_session["csrf_token"]

    def _enable_lan(self) -> None:
        response = self.client.post(
            '/save_settings', data={'lan_enabled': '1'},
            headers={
                'X-App-Token': app_module.APP_TOKEN,
                'X-Requested-With': 'XMLHttpRequest',
            },
        )
        self.assertEqual(response.status_code, 200)

    def _lan_login(self, remote: str = '192.168.1.50'):
        """LAN oturumu açar. LAN istemcileri ana şifreyle GİREMEZ; ayrı üretilen
        LAN erişim şifresiyle girerler (bkz. app.py login())."""
        lan_client = _new_test_client()
        token = self._extract_csrf(lan_client.get(
            '/login', environ_base={'REMOTE_ADDR': remote}).get_data(as_text=True))
        response = lan_client.post(
            '/login',
            data={'master_password': self._lan_password(), 'csrf_token': token},
            environ_base={'REMOTE_ADDR': remote},
        )
        self.assertEqual(response.status_code, 302)
        return lan_client

    def _lan_password(self) -> str:
        data = self.client.get(
            '/api/lan-info', headers={'X-App-Token': app_module.APP_TOKEN},
        ).get_json()
        return data['lan_password']

    def _events(self) -> list[str]:
        return [entry["event"] for entry in self.audit_module.read_audit_log()]

    def _raw(self) -> str:
        return (self.log_path.read_text(encoding="utf-8")
                if self.log_path.exists() else "")

    def test_lan_export_attempt_is_audited_on_403(self) -> None:
        self._local_login()
        self._enable_lan()
        lan_client = self._lan_login()

        response = lan_client.get(
            '/export', environ_base={'REMOTE_ADDR': '192.168.1.50'})
        self.assertEqual(response.status_code, 403)

        entries = self.audit_module.read_audit_log()
        blocked = [e for e in entries if e['event'] == 'lan_aktarim_reddedildi']
        self.assertTrue(blocked, f"olay günlükte yok: {entries}")
        self.assertEqual(blocked[-1]['uc'], 'export_data')

    def test_failed_local_login_is_audited_without_password(self) -> None:
        token = self._extract_csrf(
            self.client.get('/login').get_data(as_text=True))
        wrong = 'yanlis-ana-sifre-1234'
        with _silence_logs():
            response = self.client.post('/login', data={
                'master_password': wrong,
                'csrf_token': token,
            })
        # Yerel hatalı giriş, hata mesajıyla login sayfasını 200 ile döndürür
        # (429 yalnızca kilit oluştuğunda). Önemli olan: oturum AÇILMAMIŞ olması.
        self.assertEqual(response.status_code, 200)
        self.assertIn('data-retry-after="0"', response.get_data(as_text=True))

        entries = self.audit_module.read_audit_log()
        failed = [e for e in entries if e['event'] == 'giris_basarisiz']
        self.assertTrue(failed, f"olay günlükte yok: {entries}")
        self.assertEqual(failed[-1]['kanal'], 'yerel')
        self.assertNotIn(wrong, self._raw())
        self.assertNotIn(self.MASTER, self._raw())

    def test_failed_lan_login_is_audited(self) -> None:
        self._local_login()
        self._enable_lan()
        lan_client = _new_test_client()
        remote = '192.168.1.55'
        token = self._extract_csrf(lan_client.get(
            '/login', environ_base={'REMOTE_ADDR': remote}).get_data(as_text=True))
        with _silence_logs():
            response = lan_client.post('/login', data={
                'master_password': 'lan-yanlis-sifre', 'csrf_token': token,
            }, environ_base={'REMOTE_ADDR': remote})
        self.assertEqual(response.status_code, 401)

        failed = [e for e in self.audit_module.read_audit_log()
                  if e['event'] == 'giris_basarisiz']
        self.assertTrue(failed)
        self.assertEqual(failed[-1]['kanal'], 'lan')
        self.assertNotIn('lan-yanlis-sifre', self._raw())

    def test_lock_and_logout_are_audited(self) -> None:
        self._local_login()
        self.assertEqual(self.client.post('/lock', headers={
            'X-CSRF-Token': self._session_csrf()}).status_code, 200)
        self.assertIn('kasa_kilitlendi', self._events())

        self._local_login()
        self.assertEqual(self.client.get('/logout').status_code, 302)
        self.assertIn('cikis', self._events())

    def test_successful_login_is_not_audited_with_password(self) -> None:
        self._local_login()
        raw = self._raw()
        self.assertNotIn(self.MASTER, raw)

    def test_scope_audit_record_content_never_reaches_the_log(self) -> None:
        """Kapsam denetimi: kayıt başlığı ve şifresi günlüğe GİRMEZ."""
        self._local_login()
        fernet = Fernet(Fernet.generate_key())
        title = 'KISISIL-BASLIK-1234'
        password = 'KISISIL-SIFRE-9876'
        with patch.object(app_module, "get_fernet", return_value=fernet), \
                patch.object(app_module, "backup_database"), \
                patch.object(app_module, "invalidate_vault_report_cache"):
            response = self.client.post('/ekle', data={
                'kayit_tipi': 'Website',
                'kategori': 'Genel',
                'isim': title,
                'website_url': 'https://kisisil-ornek.example',
                'login': 'kisisil-kullanici',
                'email': 'kisisil@ornek.example',
                'password': password,
                'comment': 'kisisil-not',
                'expiry_date': '',
            }, headers={
                'X-App-Token': app_module.APP_TOKEN,
                'X-CSRF-Token': self._session_csrf(),
            })
        self.assertEqual(response.status_code, 302)

        raw = self._raw()
        # Olay YAZILDI (akış denetimi anlamlı olsun) ama içerik sızmadı.
        self.assertIn('kayit_olusturuldu', self._events())
        for secret in (title, password, 'kisisil-kullanici',
                       'kisisil@ornek.example', 'kisisil-not',
                       'kisisil-ornek.example'):
            self.assertNotIn(secret, raw, f"günlüğe sızdı: {secret}")


class VaultIsolationGuardTests(unittest.TestCase):
    """Test paketi ASLA gerçek kasa dizinine dokunmamalı.

    Bu koruma bir hatadan sonra eklendi: teşhis için yazılan geçici bir script
    gerçek APPDATA'yı kullanarak kasanın ayarlarını sildi ve master_hash'i
    değiştirdi. Testler kendi geçici dizinlerini kullansa da, aynı modülü
    elle içe aktaran bir betik aynı hatayı tekrarlayabilir. Bu yüzden
    doğrulama burada yapılır: modülün gördüğü kasa yolu geçici dizin değilse
    test paketi daha başlamadan hata verir.
    """

    def test_module_uses_temporary_data_dir(self) -> None:
        from kasa_core.paths import get_data_dir

        data_dir = Path(get_data_dir()).resolve()
        runtime = RUNTIME_DIR.resolve()
        # Kasa dizini geçici dizinin ALTINDA olmalı (get_data_dir sonuna
        # '.SifrekasamV2' ekler). Üstünde veya dışında olması sızıntı demek.
        self.assertEqual(
            data_dir.parent, runtime,
            f"Testler gerçek kasa dizinini kullanıyor: {data_dir}. "
            f"Beklenen: {runtime}. Bu, gerçek kasanın bozulmasına yol açar.",
        )
        # Gerçek kasa dizinini kullanıcı adına bakmadan tespit et: gerçek
        # APPDATA yolu, bu dosyada APPDATA'yı geçici dizine çevirmeden ÖNCE
        # kaydedilmiş olmalı.
        self.assertNotEqual(
            data_dir, REAL_VAULT_DIR,
            f"Testler gerçek kasa dizinini kullanıyor: {data_dir}. "
            f"Gerçek kasa: {REAL_VAULT_DIR}",
        )

    def test_real_vault_files_untouched(self) -> None:
        """Geçici dizinin dışında kasa veritabanı oluşmuşsa hata ver."""
        runtime = RUNTIME_DIR.resolve()
        leaked = [
            str(p) for p in RUNTIME_DIR.glob('**/sifreler.db')
            if not str(p.resolve()).startswith(str(runtime))
        ]
        self.assertEqual(leaked, [], f"Test içinde kasa dosyası oluştu: {leaked}")


class EntryShellTests(unittest.TestCase):
    """Giriş kabuğu: login.html + loading.html ortak kabuğu (2026-10).

    İki ekran aynı kabuğu kullanır; kabuk `static/entry-shell.css` içinde tek
    yerde tanımlıdır. Ayrıca loading.html `file://` üzerinden düz metin
    açıldığı için İÇİNDE Jinja bulunmamalıdır — bulunduğunda ilk <script>
    bloğu bir JS sözdizimi hatasına dönüşür ve temanın/camın/metin çevirisinin
    tamamı ölür (yaşanan buydu).
    """

    TEMPLATES = FLASK_APP_DIR / "templates"
    STATIC = FLASK_APP_DIR / "static"

    def _read_template(self, name: str) -> str:
        return (self.TEMPLATES / name).read_text(encoding="utf-8")

    @staticmethod
    def _without_html_comments(html: str) -> str:
        """Yorumlar içindeki örnek kod taramayı bozuyor (aynı hata security_lint'i de
        yakalıyordu: yorum içindeki bir `<script>` etiketi nonce'suz sayılıyor)."""
        return re.sub(r"<!--.*?-->", "", html, flags=re.S)

    def _script_blocks(self, name: str) -> str:
        html = self._without_html_comments(self._read_template(name))
        return "\n".join(re.findall(r"<script\b[^>]*>(.*?)</script>", html, flags=re.S))

    def test_shell_css_exists_and_is_wired(self) -> None:
        self.assertTrue((self.STATIC / "entry-shell.css").exists())
        base = self._read_template("base.html")
        self.assertIn("entry-shell.css') }}?v=1", base)
        # glass.css cascade'de en üstte → kabuk ondan ÖNCE yüklenmeli.
        self.assertLess(base.index("entry-shell.css"), base.index("filename='glass.css'"))
        # Kabuk yalnız login.html/loading.html'de kullanılır; SW precache'i
        # yalnız sürümsüz isteklenen dosyaları içerir (sürümlü CSS/JS ilk
        # kullanımda ağdan gelip cache'a yazılır) → burada ARANMAMALIDIR.
        self.assertNotIn('filename="entry-shell.css"', self._read_template("sw.js"))

    def test_loading_html_has_no_jinja_inside_script(self) -> None:
        """file:// yolunda Jinja çalışmaz → literal ifade tüm bloğu öldürür."""
        scripts = self._script_blocks("loading.html")
        self.assertTrue(scripts.strip(), "loading.html script bulunamadı — ayrıştırma bozuk")
        for marker in ("{{", "{%"):
            self.assertNotIn(
                marker, scripts,
                f"loading.html script içinde {marker} var; file:// yolunda "
                "sözdizimi hatası olur ve script tamamen çalışmaz.")

    def test_loading_html_has_no_jinja_url_helper(self) -> None:
        """url_for yalnız Flask render'ında çalışır; file:// yolunda literal kalır."""
        clean = self._without_html_comments(self._read_template("loading.html"))
        self.assertNotIn("url_for(", clean)

    def test_loading_html_asset_paths_are_relative(self) -> None:
        """../static/ her iki bağlamda da çözülür (file:// ve GET /loading)."""
        html = self._read_template("loading.html")
        self.assertIn('href="../static/entry-shell.css?v=1"', html)
        self.assertIn('src="../static/liquid-glass.js?v=5"', html)

    def test_loading_html_keeps_token_out_of_script(self) -> None:
        html = self._read_template("loading.html")
        self.assertIn('data-csrf-token="{{ csrf_token', html)
        self.assertIn("document.body.dataset.csrfToken", self._script_blocks("loading.html"))

    def test_shell_css_is_single_source_for_both_screens(self) -> None:
        """Eski entry-login-* kabuğu iki şablonda iki kez tanımlıydı ve kaymıştı."""
        for name in ("login.html", "loading.html"):
            html = self._read_template(name)
            self.assertNotIn(
                "entry-login-", html,
                f"{name} hâlâ eski kabuk sınıflarını kullanıyor; CSS tek yerde.")
            self.assertIn("entry-shell-wrap", html)

    def test_login_html_has_no_inline_style_block(self) -> None:
        """Kabuk CSS'i entry-shell.css'e taşındı; satır içi CSS kalması kaymaya yol açar."""
        html = self._read_template("login.html")
        self.assertNotIn("<style", html)
        self.assertIn('class="entry-shell-wrap"', html)
        self.assertIn("entry-shell-facts", html)

    def test_login_facts_replace_marketing_copy(self) -> None:
        """Reklam metni yerine işe yarayan bilgi: sürüm / son yedek / LAN.

        2026-10 ikinci turunda "Veri klasörü" ve "Boş alan" satırları KALDIRILDI
        (kullanıcı kararı): mutlak yol kullanıcı adını öne çıkarıyordu, disk
        alanı ise kullanıcıya bir şey söylemiyordu. Alt bilgi artık üç satır.
        Boş alan bilgisi İLK KURULUM rehberinde yaşıyor (orada gerçekten
        karar verdirir: kurulumu engeller)."""
        html = self._read_template("login.html")
        self.assertNotIn("kapı açılana kadar", html)
        self.assertNotIn("entry-login-title", html)

        footer = html[html.find('<footer class="entry-shell-meta">'):]
        self.assertGreater(len(footer), 200, "alt bilgi bloğu bulunamadı")
        for key in ("Sürüm", "Son Yedek", "LAN bağlantısı"):
            self.assertIn(f"_('{key}')", footer, f"alt bilgi satırı eksik: {key}")
        # Kaldırılan satırlar alt bilgide olmamalı.
        self.assertNotIn("_('Veri klasörü')", footer)
        self.assertNotIn("_('Boş alan')", footer)
        self.assertNotIn("facts.data_dir", footer)
        self.assertNotIn("facts.free_gb", footer)
        # …ama ilk kurulum rehberinde boş alan + klasör bilgisi KORUNUR.
        guide = html[: html.find('<footer class="entry-shell-meta">')]
        self.assertIn("_('Boş alan')", guide)
        self.assertIn("setup_info.path", guide)

        self.assertIn("v{{ APP_VERSION }}", html)
        self.assertIn("{% set facts = entry_facts() %}", html)
        # Hissedilen satır TEK yerel bayrağıyla toplanır: LAN istemciye basılmaz.
        self.assertIn("{% if facts.is_local %}", footer)
        # "Henüz yedek alınmadı" dalı: yedek yoksa satır gizlenmez, uyarılır.
        self.assertIn("_('Henüz yedek alınmadı')", html)
        self.assertIn("facts.backup_stale", html)
        self.assertNotIn("Veri konumu", html)

    def test_login_preserves_required_functionality(self) -> None:
        html = self._read_template("login.html")
        for marker in (
            'id="login-language-select"',
            'id="login-error-alert"',
            'data-retry-template=',
            'id="first-setup-guidance"',
            'id="master-password"',
            'id="master-password-confirm"',
            'id="password-match-feedback"',
            'data-loading-form',
            "setup_blocked",
            "lan_client",
        ):
            self.assertIn(marker, html, f"login.html işlevi kayboldu: {marker}")

    def test_entry_shell_is_opaque_when_glass_off(self) -> None:
        css = (self.STATIC / "entry-shell.css").read_text(encoding="utf-8")
        clean = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        match = re.search(
            r'data-glass-effects="off"\]\s*\.entry-shell\b[^{}]*\{([^{}]*)\}', clean)
        self.assertIsNotNone(match, "entry-shell.css'te entry-shell glass-off kurali yok")
        self.assertIn("0.96", match.group(1))
        self.assertIn("rgba(255, 255, 255, 0.96)", clean)

    def test_entry_facts_hide_everything_from_lan_clients(self) -> None:
        """Alt bilgi YALNIZCA yerel: mutlak yol kullanıcı adını içerir, yedek
        tarihi ve disk alanı ise kasa kullanımını ele verir.

        🔴 Şema SABİT OLMALI. Uzak istekte `{}` dönmek Jinja'da `Undefined`
        üretir ve `{% if x is not none %}` denetimini YANLIŞLIKLA geçirip
        500'e düşürür (yaşanan buydu). Bu yüzden uzakta da tüm anahtarlar
        bulunur, yalnız değerler boştur."""
        source = (FLASK_APP_DIR / "app.py").read_text(encoding="utf-8")
        body = self._entry_facts_body(source)
        self.assertIn("has_request_context() or not _is_local_request()", body)
        self.assertIn("'is_local': False", body)
        for key in ("is_local", "backup_age_days", "backup_date", "backup_stale"):
            self.assertIn(f"'{key}':", body, f"uzak semasında eksik anahtar: {key}")
        # Kaldırılan alanlar bir daha üretilmemeli (sızıntı yüzeyi genişlemesin).
        for gone in ("data_dir", "data_dir_short", "free_gb"):
            self.assertNotIn(f"'{gone}':", body, f"kaldırılan alan geri geldi: {gone}")
        self.assertIn("'entry_facts':", source)
        self.assertNotIn("_entry_data_dir", source)
        self.assertNotIn("_short_data_dir", source)
        # Şablon yalnız is_local bayrağına güveniyor.
        html = self._read_template("login.html")
        self.assertNotIn("facts.data_dir", html)
        self.assertNotIn("facts.free_gb", html)
        self.assertIn("{% if facts.is_local %}", html)

    def test_entry_facts_is_read_only(self) -> None:
        """Giriş ekranı OKUMALIDIR. get_storage_status() içindeki
        _probe_writable() her çağrıda veri klasörüne geçici dosya yazıp siler;
        entry_facts() onu kullanmamalı. backups/ dizini de YOKSA klasör
        yaratılmamalı (mkdir yan etkisi) — bu yüzden os.path.isdir kontrolü
        önce gelir ve listdir yalnız mevcutsa çağrılır."""
        source = (FLASK_APP_DIR / "app.py").read_text(encoding="utf-8")
        body = self._entry_facts_body(source)
        self.assertNotIn("_probe_writable", body)
        self.assertNotIn("get_storage_status", body)
        self.assertIn("os.path.isdir(backup_dir)", body)
        self.assertIn("os.listdir(backup_dir)", body)
        self.assertIn(".kasaenc", body)
        self.assertNotIn("mkdir", body)
        # Disk kullanımı ölçülmüyor: satır kaldırıldı, syscall de kalktı.
        self.assertNotIn("disk_usage", body)
        # backups_dir() yerine doğrudan yol birleştirme (o fonksiyon mkdir yapar).
        self.assertNotIn("backups_dir(", body)

    @staticmethod
    def _entry_facts_body(source: str) -> str:
        """entry_facts() gövdesi; docstring ve yorumlar ayıklanır.

        Docstring bu fonksiyonda `_probe_writable` ve `get_storage_status`
        adlarını ANLATMAK için geçiyor — yorumları ayıklamazsak 'kullanılmıyor'
        denetimi yanlış pozitif verir.
        """
        start = source.find("def entry_facts()")
        end = source.find("\ndef ", start + 10)
        body = source[start:end if end > 0 else len(source)]
        return re.sub(r'""".*?"""', "", body, flags=re.S)


class GeneratorWiringTests(unittest.TestCase):
    """Şifre üreticinin "ürettiği şifreyi nereye yazıyor" bağlantısı (2026-10).

    `setupPasswordGenerator(containerId, prefixId)` hedef alanı
    `container.dataset.targetInput`'tan okur. Bu öznitelik yoksa `targetInput`
    null'a düşer, `commit()` ilk satırda `if (targetInput)` ile sessizce
    geçer ve şifre HİÇBİR YERE yazılmaz — kullanıcı "Üret"e basar, hiçbir şey
    olmaz. Ölçülen hata buydu: modal (`#passwordGeneratorModal`) yalnız
    index.html'de bulunur, index'de `#page-password` yoktur ve eski kod
    sessiz `'page-password'` fallback'ine düşüyordu.
    """

    TEMPLATES = FLASK_APP_DIR / "templates"
    STATIC = FLASK_APP_DIR / "static"
    GENERATOR_JS = STATIC / "password-generator.js"

    def _js(self) -> str:
        return self.GENERATOR_JS.read_text(encoding="utf-8")

    def _containers(self) -> list[str]:
        js = self._js()
        found = re.findall(r"setupPasswordGenerator\(\s*'([^']+)'\s*,", js)
        self.assertGreaterEqual(len(found), 2, "setupPasswordGenerator cagrisi bulunamadi")
        return found

    def test_generator_js_has_no_silent_fallback(self) -> None:
        js = self._js()
        self.assertNotIn(
            "container.dataset.targetInput || 'page-password'", js,
            "sessiz fallback geri geldi: data-target-input yoksa hatayi gizle")
        self.assertIn("generatorMiswired", js,
                      "kablolama hatasi isaretlenmiyor")

    def test_every_generator_container_declares_target_input(self) -> None:
        templates = "\n".join(
            p.read_text(encoding="utf-8")
            for p in self.TEMPLATES.rglob("*.html")
        )
        for container_id in self._containers():
            pattern = re.compile(
                r'id="' + re.escape(container_id) + r'"[^>]*data-target-input="([^"]+)"')
            match = pattern.search(templates)
            self.assertIsNotNone(
                match,
                f'"{container_id}" konteynerinde data-target-input yok -> '
                "uretilen sifre hicbir alana yazilmaz")
            target = match.group(1)
            self.assertIn(
                f'id="{target}"', templates,
                f'"{container_id}" data-target-input="{target}" ama bu id yok')

    def test_generator_prefix_ids_exist(self) -> None:
        """$('x') → '{prefix}x' ile türetilen id'ler şablonda olmalı.

        Uzunluk kontrolü HER iki konteynerde de zorunlu (init'te
        `syncLengthControl()` okur). "Üret" butonu yalnız modalda vardır: satır içi
        panelde üretim şifre alanındaki `#page-regenerate-btn` ile tetiklenir,
        bu yüzden `generateBtn?.` null-safe yazılmıştır. Entropi/kırılma
        süresi göstergeleri de yalnız modalda vardır (`updateEntropyUI` null-safe).
        """
        js = self._js()
        templates = "\n".join(
            p.read_text(encoding="utf-8")
            for p in self.TEMPLATES.rglob("*.html")
        )
        for container_id, prefix in re.findall(
                r"setupPasswordGenerator\(\s*'([^']+)'\s*,\s*'([^']*)'", js):
            self.assertGreaterEqual(len(container_id), 1)
            for suffix in ("length", "length-display"):
                self.assertIn(
                    f'id="{prefix}{suffix}"', templates,
                    f"{container_id}: uzunluk kontrolu eksik -> {prefix}{suffix}")
            if container_id == 'passwordGeneratorModal':
                for suffix in ("gen-now", "entropy-bits", "crack-time"):
                    self.assertIn(
                        f'id="modal-{suffix}"', templates,
                        f"modal icin eksik id: modal-{suffix}")
            else:
                self.assertNotIn(
                    f'id="{prefix}gen-now"', templates,
                    f"{container_id} icin 'Uret' butonu olmamali; "
                    "uretim #page-regenerate-btn ile tetiklenir")

    def test_modal_generator_targets_its_own_display(self) -> None:
        modal = (self.TEMPLATES / "partials" / "modals" / "generator.html").read_text(
            encoding="utf-8")
        self.assertIn('data-target-input="modal-generated-password-display"', modal)
        self.assertIn('id="modal-generated-password-display"', modal)

    def test_inline_generator_targets_password_field(self) -> None:
        panel = (self.TEMPLATES / "partials" / "form" / "panel-access.html").read_text(
            encoding="utf-8")
        self.assertIn('id="pageGenerator"', panel)
        self.assertIn('data-target-input="page-password"', panel)
        self.assertIn('id="page-password"', panel)


class ServiceWorkerCacheTests(unittest.TestCase):
    """Service worker'ın statik varlık stratejisi (2026-10).

    Ölçülen sorun: `GET /login?entry=loading` sunucuda **14 ms** sürüyordu; asıl
    maliyet 21 render-blocking stylesheet (~617 KB). SW bu dosyalar için
    NETWORK-FIRST kullanıyordu → her açılışta 21 istek ağdan geliyor, ve
    loading.html → /login belge değişimi sırasında yeni belge ilk boyasını
    yapana kadar pencere boş zemin gösteriyordu.

    Beklenen sözleşme:
      * `/static/*` → stale-while-revalidate (cache'ten anında dön)
      * cache anahtarı **yol** (sorgu dizesi `?v=` HARİÇ) — ASSETS listesi
        `?v=`'siz precache'liyor, sayfa `?v=`'li istek atıyor; tam URL
        anahtarı ikisini asla eşleştiremezdi
      * HTML gezinmeleri + /api/ + /settings/ ASLA cache'lenmez (gövdede CSRF
        belirteci ve nonce'lu CSP var)
      * /api/background/ görselleri SW cache'ine girmez
    """

    SW = FLASK_APP_DIR / "templates" / "sw.js"

    def _sw(self) -> str:
        return self.SW.read_text(encoding="utf-8")

    def test_static_assets_are_stale_while_revalidate(self) -> None:
        sw = self._sw()
        self.assertIn("function staleWhileRevalidate(request)", sw)
        # Ağ kritik yolda OLMAMALI: cache'te varsa hemen dön.
        self.assertIn("if (cached) return cached;", sw)
        self.assertIn("url.pathname.startsWith('/static/')", sw)

    def test_no_network_first_for_static(self) -> None:
        sw = self._sw()
        self.assertNotIn(
            "url.pathname.endsWith('.css') || url.pathname.endsWith('.js')",
            sw,
            "network-first static dala donuldu — her acilista 21 istek aga gider")

    def test_cache_key_keeps_version_query(self) -> None:
        """`?v=` bir sürüm imzasıdır: cache anahtarı bunu KORUMALI (düz yola
        indirgemek `?v=` artırmayı etkisizleştirir ve kullanıcıya bayat dosya
        servis eder)."""
        sw = self._sw()
        self.assertIn("function cacheKeyFor(url)", sw)
        self.assertIn("return new Request(url);", sw)
        self.assertNotIn("new URL(url).pathname", sw,
                         "cache anahtari yola indirgenmis: ?v= etkisiz")
        self.assertIn("cache.match(key, { ignoreVary: true })", sw)
        self.assertIn("cache.put(key, res.clone())", sw)
        self.assertNotIn("cache.put(req", sw, "cache anahtari normalize degil")
        self.assertNotIn("cache.put(request", sw, "cache anahtari normalize degil")

    def test_precache_contains_only_unversioned_assets(self) -> None:
        """Install precache yalnizca surumsuz isteklenen dosyalari icermeli.

        Surumlu CSS/JS ilk kullanimda agdan gelir; cache anahtari surum
        sorgusunu korudugu icin surumsuz bir precache kaydi asla eslesmezdi.
        """
        sw = self._sw()
        self.assertIn("const PRECACHE = [", sw)
        self.assertNotIn("const ASSETS = [", sw)
        self.assertNotRegex(sw, r'filename="[^"]+\?v=')
        block = sw[sw.find("const PRECACHE = ["):sw.find("];", sw.find("const PRECACHE = ["))]
        for asset in ("all.min.css", "fonts/sora.woff2", "icons/icon-512.svg"):
            self.assertIn(asset, block)
        # Sürümlü dosyalar precache'te OLMAMALI (ölü 800 KB).
        for asset in ("tokens.css", "app.js", "glass.css", "entry-shell.css"):
            self.assertNotIn(asset, block, f"{asset} surumlu; precache'te olamaz")

    def test_html_and_api_are_never_cached(self) -> None:
        sw = self._sw()
        for marker in ("req.mode === 'navigate'",
                       "url.pathname.startsWith('/api/')",
                       "url.pathname.startsWith('/settings/')"):
            self.assertIn(marker, sw)
        # Bu dallar staleWhileRevalidate kullanmamalı.
        handler = sw[sw.find("self.addEventListener('fetch'"):]
        blocked = handler[:handler.find("url.pathname.startsWith('/static/')")]
        self.assertNotIn("staleWhileRevalidate", blocked)

    def test_background_images_bypass_cache(self) -> None:
        sw = self._sw()
        self.assertIn("BG_URL_PREFIX", sw)
        handler = sw[sw.find("self.addEventListener('fetch'"):]
        self.assertIn("url.pathname.startsWith(BG_URL_PREFIX)", handler)

    def test_cache_name_and_precache_list(self) -> None:
        sw = self._sw()
        self.assertIn("assets-v209", sw)
        block = sw[sw.find("const PRECACHE = ["):sw.find("];", sw.find("const PRECACHE = ["))]
        for asset in ("all.min.css", "sweetalert2.min.css", "toastify.min.css",
                      "sweetalert2.all.min.js", "toastify.min.js",
                      "fonts/sora.woff2", "fonts/jetbrains-mono.woff2"):
            self.assertIn(asset, block)


class TooltipAnchorTests(unittest.TestCase):
    """Tasarım tooltip balonu: hizalama ve "asılı kalmama" (2026-10).

    Kullanıcı raporları:
      * Anasayfa butonlarında balon ORTASINDAN değil, hafif SAĞINDAN çıkıyordu.
        Sebep: konum her zaman metin çapasına göre hesaplanıyordu; ikonu solda
        olan bir butonda ("<i>…</i>Yenile") metin kutu sağa kaydığı için
        balon butonun ortasından kayıyordu.
      * Bildirim düğmesine gelince panel açılıyor ama tooltip GÖRÜNMEYE DEVAM
        EDİYORDU. `mouseout` tetiklenmiyor (imleç düğmenin üstünde kalıyor) ve
        balonu yalnızca mouseout/focusout/scroll kapatıyordu.
    """

    STATIC = FLASK_APP_DIR / "static"
    APP_JS = STATIC / "app.js"

    def _js(self) -> str:
        return self.APP_JS.read_text(encoding="utf-8")

    def test_controls_anchor_to_box_center(self) -> None:
        js = self._js()
        self.assertIn(
            "const anchorX = (el) => {", js,
            "ayri bir kontrol/metin capa ayrimi yok")
        self.assertIn("if (isControl(el)) return rect.left + rect.width / 2;", js,
                      "denetimlerde balon kutu ortasina hizalanmali")
        self.assertIn("anchorX(target) - w / 2", js,
                      "position() hala textAnchorX kullaniyor")

    def test_panel_open_hides_tooltip(self) -> None:
        js = self._js()
        # Dropdown tetikleyicisi (bildirim + ayarlar menüsü) ve modal açılışı.
        self.assertIn("let hideTooltip = () => {};", js)
        self.assertIn("hideTooltip = hide;", js, "hideTooltip geri cagrilabilir degil")
        trigger = js[js.find("trigger.addEventListener('click'"):]
        trigger = trigger[:trigger.find("});", trigger.find("stopPropagation()"))]
        self.assertIn("hideTooltip();", trigger,
                      "dropdown acilinda balon kapatilmiyor")

    def test_modal_open_hides_tooltip(self) -> None:
        js = self._js()
        block = js[js.find("kasa:modal-opened"):]
        block = block[:block.find("});")]
        self.assertIn("hideTooltip();", block, "modal acilinda balon kapatilmiyor")

    def test_tooltip_self_heals_when_pointer_leaves(self) -> None:
        """Portal menü açılması gibi mouseout ÜRETMEYEN durumlarda balon
        ekranda asılı kalıyordu; pointer konumu her frame doğrulanıyor."""
        js = self._js()
        self.assertIn("document.addEventListener('mousemove'", js)
        self.assertIn("document.elementFromPoint(", js)
        self.assertIn("node.contains(el) || el.contains(node)", js)
        self.assertIn("if (_ttPending) { _ttPending = null;", js)


class CardFilterRevealTests(unittest.TestCase):
    """Arama sonrasi kartlarin "once camsiz, sonra camli" belirtisi (2026-10).

    OLCULEN KOK NEDEN: sayfa-1 disindaki kartlar sablonda `hidden` dogar
    (card-grid.html: `{% if loop.index0 >= card_page_size %}hidden{% endif %}`) —
    yani `display:none`. Arama onlari gorunur yaptiginda display:none -> block
    gecisi olur; Chromium backdrop-filter katmanini yeniden kurar ve ilk karede
    ornekleme yapmadan boyar. `.vault-card-shell` cami SAF CSS'ten alir
    (`backdrop-filter: var(--glass-blur)`) ve `.glass` sinifi tasimaz, yani
    liquid-glass.js bu yolda devrede degildir.

    COZUM: gorunurluk ANINDA acilir (eski `requestAnimationFrame(() => hidden =
    false)` bir kare daha camsiz ekran uretiyordu) ve opaklik 0'dan baslayan
    180ms'lik giris animasyonuyla oynatilir. Bulaniklasma 1-2 karede (~32 ms)
    tamamlandigi icin kart belirgin hale gelmeden cam hazir olur.

    NOT: `card-animated` (cardSlideIn) YALNIZCA ilk yuklemede oynatilir
    (vault-index.js `finishInitialReveal`, 650ms sonra sinif kaldirilir) ve
    transform icerdigi icin ayni Chromium sorununu yaratirdi; arama yolunda
    zaten oynamiyordu.
    """

    STATIC = FLASK_APP_DIR / "static"
    PARTIALS = FLASK_APP_DIR / "templates" / "partials"

    def _cards_css(self) -> str:
        return (self.STATIC / "cards.css").read_text(encoding="utf-8")

    def _index_js(self) -> str:
        return (self.STATIC / "vault-index.js").read_text(encoding="utf-8")

    def _set_card_visible(self) -> str:
        js = self._index_js()
        start = js.find("const setCardVisible = (wrapper, visible")
        self.assertGreater(start, -1, "setCardVisible bulunamadi")
        end = js.find("\n    };", start)
        return js[start:end]

    def test_cards_start_hidden_beyond_first_page(self) -> None:
        grid = (self.PARTIALS / "card-grid.html").read_text(encoding="utf-8")
        self.assertIn("{% if loop.index0 >= card_page_size %}hidden{% endif %}", grid)

    def test_card_shell_blur_comes_from_css_not_js(self) -> None:
        """Kart cami saf CSS; JS yolu devrede degil (aksi halde tani degisir)."""
        css = self._cards_css()
        shell = list(re.finditer(r"\.vault-card-shell[^{}]*\{([^{}]*)\}", css))
        self.assertTrue(shell, ".vault-card-shell kurali yok")
        self.assertTrue(
            any("backdrop-filter" in m.group(1) and "var(--glass-blur" in m.group(1)
                for m in shell),
            ".vault-card-shell backdrop-filter almiyor")
        liquid = (self.STATIC / "liquid-glass.js").read_text(encoding="utf-8")
        self.assertIn(".glass:not(.vault-card-shell)", liquid)

    def test_filter_reveal_css_exists(self) -> None:
        """Sinif JS tarafinda zaten kullaniliyordu ama CSS'i HIC YOKTI (oldu kod)."""
        css = self._cards_css()
        self.assertIn(".card-wrapper.filter-reveal", css)
        self.assertIn("@keyframes cardFilterReveal", css)
        self.assertIn("opacity: 0", css)
        self.assertIn("cardFilterReveal 180ms", css)
        self.assertIn('html[data-kasa-animations="off"] .card-wrapper.filter-reveal', css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)

    def test_visibility_opens_synchronously(self) -> None:
        """rAF gecikmesi bir kare daha camsiz ekran uretiyordu."""
        js = self._index_js()
        self.assertNotIn(
            "requestAnimationFrame(() => { wrapper.hidden = false; })", js,
            "gorunurluk yine rAF icinde aciliyor — bir kare camsiz ekran kalir")
        body = self._set_card_visible()
        self.assertIn("wrapper.hidden = false;", body)
        # hidden=false, sinif eklemeden ONCE gelmeli.
        self.assertLess(
            body.index("wrapper.hidden = false;"),
            body.index("wrapper.classList.add('filter-reveal')"),
            "once sinif, sonra gorunurluk: yanlis sira")

    def test_filter_reveal_class_is_cleared_after_animation(self) -> None:
        """Sinif kalirsa yeniden aramada animasyon tetiklenmez (yeniden oynatmama)."""
        js = self._index_js()
        self.assertIn("addEventListener('animationend'", js)
        self.assertIn("wrapper.classList.remove('filter-reveal')", js)
        self.assertIn("void wrapper.offsetWidth;", js)

    def test_animation_respects_reduce_motion(self) -> None:
        js = self._index_js()
        self.assertIn("const reduceMotion = () =>", js)
        self.assertIn("if (!animate || reduceMotion()) return;", js)
        # shadowing olmamali: filterCards icinde ikinci bir const olmamali.
        self.assertEqual(js.count("const reduceMotion ="), 1)


if __name__ == "__main__":
    unittest.main()
