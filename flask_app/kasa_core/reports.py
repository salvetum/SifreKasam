"""Password-health and vault-statistics calculations."""

from datetime import timedelta
from typing import Any, Callable

from cryptography.fernet import Fernet

from kasa_core.crypto import decrypt_metadata, safe_decrypt
from kasa_core.models import Record
from kasa_core.password_strength import ACCEPTABLE_PASSWORD_SCORE
from kasa_core.time_utils import utc_now_naive


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
        Record.encrypted_password,
        Record.updated_at,
        Record.is_pinned,
        Record.expiry_date,
    ).all()

    now = utc_now_naive()
    six_months_ago = now - timedelta(days=180)
    pinned = weak = old = expired = 0
    weak_records: list[dict[str, str]] = []
    old_records: list[dict[str, Any]] = []
    expired_records: list[dict[str, str]] = []
    password_map: dict[str, list[dict[str, str]]] = {}

    for record in rows:
        if record.is_pinned:
            pinned += 1
        password = safe_decrypt(fernet, record.encrypted_password)
        if not password:
            continue

        title = decrypt_metadata(fernet, record.title)
        record_data = {"id": record.id, "title": title}
        user_inputs = [
            title,
            decrypt_metadata(fernet, record.website_url),
            decrypt_metadata(fernet, record.login),
            decrypt_metadata(fernet, record.email),
        ]
        if score_password(password, user_inputs) < ACCEPTABLE_PASSWORD_SCORE:
            weak += 1
            weak_records.append(record_data)
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
    }
    health = {
        "zayif": weak_records,
        "tekrar": [
            group for group in password_map.values() if len(group) > 1
        ],
        "eski": old_records,
        "expired": expired_records,
    }
    return stats, health
