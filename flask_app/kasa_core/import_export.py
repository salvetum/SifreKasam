"""Vault import and export serialization."""

import json
import os
import uuid
from datetime import datetime
from typing import Any

from cryptography.fernet import Fernet

from kasa_core.constants import DEFAULT_CATEGORY, MAX_IMPORT_RECORDS
from kasa_core.crypto import (
    decrypt_metadata,
    encrypt_metadata,
    safe_decrypt,
    safe_encrypt,
)
from kasa_core.models import Record
from kasa_core.validation import (
    normalize_record_type,
    normalize_text,
    normalize_url,
)


def new_record_id() -> str:
    return uuid.uuid4().hex


def parse_expiry(expiry_value: str | None) -> datetime | None:
    if not expiry_value:
        return None
    try:
        return datetime.strptime(expiry_value, "%Y-%m-%d")
    except ValueError:
        return None


def serialize_records(rows, fernet: Fernet) -> list[dict[str, Any]]:
    return [
        {
            "type": record.type,
            "category": record.category,
            "title": decrypt_metadata(fernet, record.title),
            "website_url": decrypt_metadata(fernet, record.website_url),
            "login": decrypt_metadata(fernet, record.login),
            "password": safe_decrypt(fernet, record.encrypted_password),
            "comment": safe_decrypt(fernet, record.encrypted_comment),
            "expiry_date": (
                record.expiry_date.strftime("%Y-%m-%d")
                if record.expiry_date
                else ""
            ),
        }
        for record in rows
    ]


def serialize_records_txt(data: list[dict[str, Any]]) -> bytes:
    fields = (
        "type",
        "category",
        "title",
        "website_url",
        "login",
        "password",
        "comment",
        "expiry_date",
    )
    blocks = []
    for item in data:
        lines = [
            f"{field}: {json.dumps(str(item.get(field) or ''), ensure_ascii=False)}"
            for field in fields
        ]
        blocks.append("\n".join(lines))
    return "\n---\n".join(blocks).encode("utf-8")


def build_export_payload(
    data: list[dict[str, Any]],
    export_format: str,
) -> tuple[bytes, str]:
    if export_format == "txt":
        return serialize_records_txt(data), "text/plain; charset=utf-8"
    payload = json.dumps(data, ensure_ascii=False, indent=4).encode("utf-8")
    mimetype = (
        "application/vnd.sifrekasam.backup+json"
        if export_format == "kasa"
        else "application/json"
    )
    return payload, mimetype


def parse_import_record(
    item: dict,
    fernet: Fernet,
    unknown_title: str = "Bilinmeyen",
) -> Record:
    title = (
        item.get("title")
        or item.get("Website name")
        or item.get("Application")
        or item.get("Account name")
        or item.get("SecureNote")
        or unknown_title
    )
    login_value = normalize_text(
        item.get("login")
        or item.get("Login")
        or item.get("Login name")
        or item.get("CreditCard")
        or "",
        max_length=300,
    )
    password = normalize_text(item.get("password") or item.get("Password") or "")
    comment = normalize_text(
        item.get("comment")
        or item.get("Comment")
        or item.get("SecureNote")
        or "",
        max_length=5000,
    )
    url = normalize_url(
        item.get("website_url") or item.get("Website URL") or ""
    )
    category = item.get("category") or item.get("Category") or DEFAULT_CATEGORY
    record_type = item.get("type") or (
        "Website"
        if "Website name" in item
        else "Application"
        if "Application" in item
        else "CreditCard"
        if "CreditCard" in item
        else "SecureNote"
        if "SecureNote" in item
        else "Other"
    )
    return Record(
        id=new_record_id(),
        type=normalize_record_type(record_type),
        category=normalize_text(category, DEFAULT_CATEGORY, 120),
        title=encrypt_metadata(
            fernet,
            normalize_text(title, unknown_title, 200),
        ),
        website_url=encrypt_metadata(fernet, url),
        login=encrypt_metadata(fernet, login_value),
        encrypted_password=safe_encrypt(fernet, password),
        encrypted_comment=safe_encrypt(fernet, comment),
        expiry_date=parse_expiry(
            normalize_text(item.get("expiry_date") or item.get("Expiry Date"))
        ),
    )


def parse_import_payload(filename: str, content: str) -> list[dict[str, Any]]:
    suffix = os.path.splitext(filename.lower())[1]
    if suffix in {".json", ".kasa"}:
        data = json.loads(content)
    elif suffix == ".txt":
        data = parse_old_txt(content)
    else:
        raise ValueError("unsupported-import-format")

    if not isinstance(data, list):
        raise ValueError("invalid-import-payload")
    return [
        item
        for item in data[:MAX_IMPORT_RECORDS]
        if isinstance(item, dict)
    ]


def parse_old_txt(content: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for block in content.split("---"):
        block = block.strip()
        if not block:
            continue
        data = {}
        for line in block.splitlines():
            if ":" not in line:
                continue
            key, _, raw_value = line.partition(":")
            value = raw_value.strip()
            if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
                try:
                    value = json.loads(value)
                except json.JSONDecodeError:
                    pass
            data[key.strip()] = str(value)
        if data and any(
            key in data
            for key in (
                "title",
                "Website name",
                "Application",
                "Account name",
                "CreditCard",
                "SecureNote",
                "Login",
            )
        ):
            records.append(data)
    return records
