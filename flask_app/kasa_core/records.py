"""Database operations shared by record routes."""

import logging

from cryptography.fernet import Fernet

from kasa_core.crypto import strict_decrypt
from kasa_core.extensions import db
from kasa_core.models import PasswordHistory, Record


log = logging.getLogger(__name__)


def delete_records_and_history(record_ids: list[str]) -> int:
    if not record_ids:
        return 0
    PasswordHistory.query.filter(
        PasswordHistory.record_id.in_(record_ids)
    ).delete(synchronize_session=False)
    return Record.query.filter(
        Record.id.in_(record_ids)
    ).delete(synchronize_session=False)


def append_password_history(
    record_id: str,
    encrypted_password: str,
    fernet: Fernet,
) -> bool:
    if not encrypted_password:
        return False
    try:
        password = strict_decrypt(fernet, encrypted_password)
    except Exception:
        log.warning("Çözülemeyen parola geçmişe eklenmedi: %s", record_id)
        return False

    latest = PasswordHistory.query.filter_by(record_id=record_id).order_by(
        PasswordHistory.created_at.desc(),
        PasswordHistory.id.desc(),
    ).first()
    if latest:
        try:
            latest_password = strict_decrypt(fernet, latest.encrypted_password)
        except Exception:
            latest_password = None
        if latest_password is not None and latest_password == password:
            return False

    db.session.add(
        PasswordHistory(
            record_id=record_id,
            encrypted_password=encrypted_password,
        )
    )
    return True
