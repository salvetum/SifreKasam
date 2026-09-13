"""Sağlık sayfası hızlı eylemleri için saf (pure) yardımcılar."""

import secrets
import string
from datetime import datetime

from cryptography.fernet import Fernet

from kasa_core.crypto import decrypt_metadata, safe_decrypt
from kasa_core.password_strength import ACCEPTABLE_PASSWORD_SCORE

# safe_decrypt başarısız olduğunda bu yer tutucuyu döndürür; gerçek şifre değildir.
_DECRYPT_PLACEHOLDER = "[Şifre Çözülemedi]"

# Çift eşitliği karşılaştırması için temizlenip çözülen metadata alanları.
_CLEAN_FIELDS = ("title", "website_url", "login", "email", "category")

_AMBIGUOUS_CHARS = "Il1O0o"
_SYMBOLS = "!@#$%^&*()-_=+[]{};:,.<>?/"


def generate_strong_password(length: int = 24) -> str:
    """Her karakter sınıfından en az bir tane içeren rastgele güçlü şifre üretir.

    Belirsiz karakterlerle (I/l/1/O/0/o) karışıklığı önler; ``secrets``
    tabanlıdır ve tahmin edilebilir kalıplar içermez.
    """
    pools = [
        [ch for ch in string.ascii_uppercase if ch not in "IO"],
        [ch for ch in string.ascii_lowercase if ch not in "lo"],
        [ch for ch in string.digits if ch not in "01"],
        list(_SYMBOLS),
    ]
    size = max(4, int(length))
    characters = [secrets.choice(pool) for pool in pools]
    all_chars = [ch for pool in pools for ch in pool]
    characters.extend(secrets.choice(all_chars) for _ in range(size - len(characters)))
    secrets.SystemRandom().shuffle(characters)
    return "".join(characters)


def _duplicate_key(fernet: Fernet, record) -> tuple | None:
    """Kaydın düz metin 'kimliğini' üretir; çözülemiyorsa None döner."""
    password = safe_decrypt(fernet, record.encrypted_password)
    if not password or password == _DECRYPT_PLACEHOLDER:
        return None
    fields = [
        str(decrypt_metadata(fernet, getattr(record, field) or "")).strip().casefold()
        for field in _CLEAN_FIELDS
    ]
    comment = str(
        decrypt_metadata(fernet, record.encrypted_comment or "")
    ).strip().casefold()
    expiry = record.expiry_date.isoformat() if record.expiry_date else "none"
    return tuple([*fields, password, comment, expiry])


def find_duplicate_groups(records, fernet: Fernet) -> list[dict]:
    """Tüm alanları birebir aynı olan kayıt gruplarını bulur.

    Hayatta kalan (survivor): önce sabitlenmiş (pinned), sonra en güncel
    ``updated_at``, bağlarsa en yüksek id. Dönen grup, silinecek üyeleri içerir.
    """
    groups: dict[tuple, list] = {}
    for record in records:
        key = _duplicate_key(fernet, record)
        if key is None:
            continue
        groups.setdefault(key, []).append(record)

    result: list[dict] = []
    for members in groups.values():
        if len(members) < 2:
            continue
        survivor = max(
            members,
            key=lambda item: (
                int(getattr(item, "is_pinned", 0) or 0),
                item.updated_at or datetime.min,
                item.id,
            ),
        )
        result.append({
            "survivor_id": survivor.id,
            "title": decrypt_metadata(fernet, survivor.title),
            "url": decrypt_metadata(fernet, survivor.website_url),
            "count": len(members),
            "member_ids": [
                item.id for item in members if item.id != survivor.id
            ],
        })

    result.sort(key=lambda group: (str(group["title"]).casefold(), group["survivor_id"]))
    return result


def weak_record_problems(
    records,
    fernet: Fernet,
    score_password,
) -> list[tuple]:
    """Kabul edilebilir eşiğin altındaki kayıtları ``(record, password)`` döndürür."""
    problems: list[tuple] = []
    for record in records:
        password = safe_decrypt(fernet, record.encrypted_password)
        if not password or password == _DECRYPT_PLACEHOLDER:
            continue
        user_inputs = [
            decrypt_metadata(fernet, record.title or ""),
            decrypt_metadata(fernet, record.website_url or ""),
            decrypt_metadata(fernet, record.login or ""),
            decrypt_metadata(fernet, record.email or ""),
        ]
        if score_password(password, user_inputs) < ACCEPTABLE_PASSWORD_SCORE:
            problems.append((record, password))
    return problems