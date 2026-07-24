"""Pure cryptographic primitives for vault data."""

import base64
import hashlib
import hmac
import os

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from werkzeug.security import check_password_hash, generate_password_hash

from kasa_core.constants import (
    PBKDF2_ITERATIONS,
    RECORD_METADATA_PREFIX,
)


def derive_key_with_salt(
    master_password: str,
    salt: bytes,
    iterations: int = PBKDF2_ITERATIONS,
) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=iterations,
    )
    return base64.urlsafe_b64encode(kdf.derive(master_password.encode()))


def decode_salt(value: str | None) -> bytes | None:
    try:
        salt = base64.b64decode(value or "", validate=True)
        return salt if len(salt) >= 16 else None
    except Exception:
        return None


def new_salt_b64() -> str:
    return base64.b64encode(os.urandom(16)).decode()


def safe_decrypt(fernet: Fernet, value: str) -> str:
    if not value:
        return ""
    try:
        return fernet.decrypt(value.encode()).decode()
    except Exception:
        return "[Şifre Çözülemedi]"


def safe_encrypt(fernet: Fernet, value: str) -> str:
    return fernet.encrypt(value.encode()).decode() if value else ""


def strict_decrypt(fernet: Fernet, value: str) -> str:
    return fernet.decrypt(value.encode()).decode() if value else ""


def encrypt_metadata(fernet: Fernet, value: str) -> str:
    return RECORD_METADATA_PREFIX + safe_encrypt(fernet, value) if value else ""


def decrypt_metadata(fernet: Fernet, value: str) -> str:
    if not value or not value.startswith(RECORD_METADATA_PREFIX):
        return value or ""
    return safe_decrypt(fernet, value[len(RECORD_METADATA_PREFIX):])


def strict_decrypt_metadata(fernet: Fernet, value: str) -> str:
    if not value or not value.startswith(RECORD_METADATA_PREFIX):
        return value or ""
    return strict_decrypt(fernet, value[len(RECORD_METADATA_PREFIX):])


def metadata_value_for_migration(
    fernet: Fernet,
    value: str,
) -> tuple[str, bool]:
    if not value or not value.startswith(RECORD_METADATA_PREFIX):
        return value or "", False
    try:
        return strict_decrypt_metadata(fernet, value), True
    except InvalidToken:
        return value, False


def is_legacy_master_hash(value: str) -> bool:
    return len(value or "") == 64 and all(
        character in "0123456789abcdef" for character in value.lower()
    )


def hash_master_password(master_password: str) -> str:
    return generate_password_hash(master_password)


def verify_master_password(stored_hash: str, master_password: str) -> bool:
    if not stored_hash:
        return False
    if is_legacy_master_hash(stored_hash):
        candidate = hashlib.sha256(master_password.encode()).hexdigest()
        return hmac.compare_digest(stored_hash, candidate)
    try:
        return check_password_hash(stored_hash, master_password)
    except Exception:
        return False
