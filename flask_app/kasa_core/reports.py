"""Password-health and vault-statistics calculations."""

from datetime import timedelta
from typing import Any, Callable

from cryptography.fernet import Fernet

from kasa_core.crypto import decrypt_metadata, safe_decrypt
from kasa_core.hibp import cached_breach_status
from kasa_core.models import Record
from kasa_core.password_strength import ACCEPTABLE_PASSWORD_SCORE
from kasa_core.time_utils import utc_now_naive

# Yerel sızıntı taraması için derlenmiş liste: Büyük sızıntı veritabanlarında
# (ör. HaveIBeenPwned) en sık görülen yaygın şifreler. Tarama tamamen çevrim
# dışıdır; hiçbir şifre internete gönderilmez. Canlı HIBP taraması sonuçları
# ``cached_breach_status`` aracılığıyla yalnızca önbellekten (hiçbir ağ isteği
# tetiklemeden) bu tespitle birleşir.
BREACHED_COMMON_PASSWORDS = frozenset({
    "123456", "password", "12345678", "qwerty", "123456789", "12345",
    "1234", "111111", "1234567", "dragon", "123123", "baseball",
    "abc123", "football", "monkey", "letmein", "696969", "shadow",
    "master", "666666", "qwertyuiop", "123321", "mustang", "1234567890",
    "michael", "654321", "pussy", "superman", "1qaz2wsx", "7777777",
    "fuckyou", "121212", "000000", "qazwsx", "123qwe", "killer",
    "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter",
    "buster", "soccer", "harley", "batman", "andrew", "tigger",
    "sunshine", "iloveyou", "fuckme", "2000", "charlie", "robert",
    "thomas", "hockey", "ranger", "daniel", "starwars", "klaster",
    "112233", "george", "asshole", "computer", "michelle", "jessica",
    "pepper", "1111", "zxcvbn", "555555", "11111111", "131313",
    "freedom", "777777", "pass", "fuck", "maggie", "159753",
    "aaaaaa", "ginger", "princess", "joshua", "cheese", "amanda",
    "summer", "love", "ashley", "6969", "nicole", "chelsea",
    "biteme", "matthew", "access", "yankees", "987654321", "dallas",
    "austin", "thunder", "taylor", "matrix", "william",
    # Türkçe / yerel yaygınlar
    "sifre", "sifre123", "123456a", "123456789a", "qwerty123", "1q2w3e4r",
    "password123", "secret", "admin", "welcome", "welcome1", "login",
    "test123", "deneme", "deneme123", "parola", "parola123", "sifre1",
    "12345678910", "11223344", "147258369", "159357", "987654", "456789",
    "ankara", "istanbul", "galatasaray", "besiktas", "fenerbahce",
    "1903", "1907", "trabzon", "mersin", "kayseri", "aslan",
    "fazilet", "eleman", "ismail", "mehmet", "ahmet", "murat",
    "12345678900", "a1b2c3d4", "azerty", "qwerty12345", "monkey123",
})


def build_vault_report_payloads(
    fernet: Fernet,
    score_password: Callable[[str, object], int],
) -> tuple[dict[str, int], dict[str, list]]:
    rows = Record.query.with_entities(
        Record.id,
        Record.title,
        Record.website_url,
        Record.login,
        Record.email,
        Record.category,
        Record.encrypted_password,
        Record.updated_at,
        Record.is_pinned,
        Record.expiry_date,
    ).all()

    now = utc_now_naive()
    six_months_ago = now - timedelta(days=180)
    pinned = weak = old = expired = breached = 0
    weak_records: list[dict[str, Any]] = []
    old_records: list[dict[str, Any]] = []
    expired_records: list[dict[str, Any]] = []
    breached_records: list[dict[str, Any]] = []
    password_map: dict[str, list[dict[str, Any]]] = {}
    skor_toplami = 0
    skorlu_kayitlar = 0

    for record in rows:
        if record.is_pinned:
            pinned += 1
        password = safe_decrypt(fernet, record.encrypted_password)
        if not password:
            continue

        title = decrypt_metadata(fernet, record.title)
        url = decrypt_metadata(fernet, record.website_url)
        login = decrypt_metadata(fernet, record.login)
        email = decrypt_metadata(fernet, record.email)
        kategori = decrypt_metadata(fernet, record.category)
        score = score_password(password, [title, url, login, email])
        skor_toplami += score
        skorlu_kayitlar += 1
        record_data: dict[str, Any] = {
            "id": record.id,
            "title": title,
            "url": url,
            "login": login,
            "email": email,
            "kategori": kategori,
            "updated_at": (
                record.updated_at.isoformat() if record.updated_at else None
            ),
            "skor": score,
        }
        if score < ACCEPTABLE_PASSWORD_SCORE:
            weak += 1
            weak_records.append(record_data)
        # Yerel yaygın liste VEYA (daha önce canlı taranmışsa) HIBP sonucu.
        hibp_breached = cached_breach_status(password) is True
        if password in BREACHED_COMMON_PASSWORDS or hibp_breached:
            breached += 1
            breached_records.append(record_data)
        password_map.setdefault(password, []).append(record_data)
        if record.updated_at and record.updated_at < six_months_ago:
            old += 1
            old_records.append(
                {**record_data, "days": (now - record.updated_at).days}
            )
        if record.expiry_date and record.expiry_date < now:
            expired += 1
            expired_records.append(record_data)

    stats = {
        "toplam": len(rows),
        "pinned": pinned,
        "zayif": weak,
        "eski": old,
        "expired": expired,
        "sizinti": breached,
        "zayif_ids": [r["id"] for r in weak_records],
        "eski_ids": [r["id"] for r in old_records],
        "expired_ids": [r["id"] for r in expired_records],
        "sizinti_ids": [r["id"] for r in breached_records],
    }
    avg_skor = (skor_toplami / skorlu_kayitlar) if skorlu_kayitlar else 0.0
    health = {
        "zayif": weak_records,
        "tekrar": [
            group for group in password_map.values() if len(group) > 1
        ],
        "eski": old_records,
        "expired": expired_records,
        "sizinti": breached_records,
        "avg_skor": round(avg_skor, 1),
        "health_score": 100 if not skorlu_kayitlar else max(8, min(100, round((skor_toplami / skorlu_kayitlar / 4.0) * 100))),
        # Donut dağılımı için çakışmasız kayıt sayıları (Zayıf/Tekrar/Eski/Güvenli)
        "dagitim": build_distribution_counts(
            len(rows), weak_records, password_map, old_records,
            expired_records, breached_records,
        ),
    }
    return stats, health


def build_distribution_counts(
    toplam: int,
    weak_records: list[dict[str, Any]],
    password_map: dict[str, list[dict[str, Any]]],
    old_records: list[dict[str, Any]],
    expired_records: list[dict[str, Any]],
    breached_records: list[dict[str, Any]],
) -> dict[str, int]:
    """Aynı kayıt birçok risk kategorisine girebileceğinden, dağılım sayılarını
    çakışmasız (union) hesaplar. ``guvenli`` = hiçbir risk kategorisinde yok."""
    risky: set[str] = {r["id"] for r in weak_records}
    risky |= {r["id"] for r in old_records}
    risky |= {r["id"] for r in expired_records}
    risky |= {r["id"] for r in breached_records}
    risky |= {
        item["id"]
        for group in password_map.values()
        if len(group) > 1
        for item in group
    }
    reused = {
        item["id"]
        for group in password_map.values()
        if len(group) > 1
        for item in group
    }
    return {
        "zayif": len({
            r["id"] for r in weak_records
        }),
        "tekrar": len(reused),
        "eski": len({r["id"] for r in old_records}),
        "guvenli": max(0, toplam - len(risky)),
    }
