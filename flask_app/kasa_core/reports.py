"""Password-health and vault-statistics calculations."""

from datetime import datetime, timedelta
from typing import Any, Callable

from cryptography.fernet import Fernet

from kasa_core.crypto import decrypt_metadata, safe_decrypt
from kasa_core.models import Record


def build_vault_report_payloads(
    fernet: Fernet,
    score_password: Callable[[str], int],
) -> tuple[dict[str, int], dict[str, list]]:
    rows = Record.query.with_entities(
        Record.id,
        Record.title,
        Record.encrypted_password,
        Record.updated_at,
        Record.is_pinned,
        Record.expiry_date,
    ).all()

    now = datetime.utcnow()
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

        record_data = {
            "id": record.id,
            "title": decrypt_metadata(fernet, record.title),
        }
        if score_password(password) < 4:
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
