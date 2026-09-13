"""Şifreli yedek formatı (.kasaenc) — AES-256-GCM + scrypt KDF.

Güvenlik modeli:
- Veri, ``password``'dan türetilen 256 bitlik anahtarla AES-256-GCM ile
  şifrelenir; her dosya için rastgele nonce(12B) ve ayrılmaz auth tag (16B)
  üretilir. GCM hem gizlilik hem bütünlük sağlar (kurcalanmış içerik açılamaz).
- Parola → anahtar türetme scrypt ile yapılır. scrypt brute-force'a karşı
  bellek+zaman maliyetli olduğu için (n=2^17) kaba kuvvet saldırılarını zorlaştırır.
  Tuz her dosyada rastgele (16B) üretilir → aynı parolayla şifrelenmiş iki dosya
  aynı çıktıyı üretmez.
- Düz metin (kayıt listesi) asla diske / günlüğe yazılmaz; yalnızca istemciye
  giden tepki ayakta işlenir.
- Şifre hiçbir yerde kalıcı saklanmaz (manuel indirme akışında kullanıcıya tek
  sefer gösterilir; otomatik yedekte anahtar master-Fernet ile sarmalanır).

Dosya formatı (binary):
  magic      : 8B   b"KASAENC1"
  version    : 1B   0x01
  kdf_n      : 4B   big-endian uint32 (scrypt N)
  kdf_r      : 4B   big-endian uint32
  kdf_p      : 4B   big-endian uint32
  salt       : 16B
  nonce      : 12B
  ciphertext : uzunluk öneksiz (GCM tag ciphertext sonundadır)
  Uzunluk bilgisi magic/version/kdf yerleşiminden deterministik değildir; bu
  yüzden başlık sabit boyutlu (8+1+4+4+4+16+12 = 49B) tutulur, gerisi ciphertext.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"KASAENC1"
VERSION = 0x01
SALT_LEN = 16
NONCE_LEN = 12
GCM_TAG_LEN = 16
AES_KEY_LEN = 32

# Başlık boyutu: magic(8) + version(1) + kdf_n(4) + kdf_r(4) + kdf_p(4)
#               + salt(16) + nonce(12) = 49 bayt.
HEADER_LEN = len(MAGIC) + 1 + 4 + 4 + 4 + SALT_LEN + NONCE_LEN

DEFAULT_KDF_N = 1 << 17  # 131072; ~0.5-1s, kaba kuvvete karşı yeterli
DEFAULT_KDF_R = 8
DEFAULT_KDF_P = 1
MAX_PASSWORD_LEN = 512

# DoS önleme: scrypt bellek maliyeti ~= 128 * N * r bayt. Bu sınır ile başlıktaki
# (saldırgan-denetimli) N/r/p değerlerinin aşırı bellek ayırması engellenir, yoksa
# import sırasında uygulama donar / mavi ekran verir. Kendi kodlayıcımız 128 MiB
# (n=2^17, r=8) kullanır; 256 MiB'lik tavan ~2 katı pay bırakır, makul sürede açılır.
MAX_KDF_N = 1 << 18          # 262144 → r=8 iken en fazla 256 MiB
MAX_KDF_R = 8
MAX_KDF_P = 8
MAX_KDF_MEMORY_BYTES = 256 * 1024 * 1024  # 128 * MAX_KDF_N * MAX_KDF_R


class EncryptedBackupError(Exception):
    """Şifreli yedek açma/sunma hatası (kullanıcıya gösterilebilir)."""


class InvalidPasswordError(EncryptedBackupError):
    """Parola yanlış veya dosya bütünlüğü bozuk."""


class CorruptBackupError(EncryptedBackupError):
    """Dosya başlığı/formatı geçersiz veya desteklenmiyor."""


@dataclass(frozen=True)
class Header:
    version: int
    kdf_n: int
    kdf_r: int
    kdf_p: int
    salt: bytes
    nonce: bytes


def _derive_key(password: str, header: Header) -> bytes:
    if len(password) > MAX_PASSWORD_LEN:
        raise ValueError("password-too-long")
    kdf = Scrypt(
        salt=header.salt,
        length=AES_KEY_LEN,
        n=header.kdf_n,
        r=header.kdf_r,
        p=header.kdf_p,
    )
    return kdf.derive(password.encode("utf-8"))


def _pack_header(header: Header) -> bytes:
    return (
        MAGIC
        + bytes([header.version & 0xFF])
        + header.kdf_n.to_bytes(4, "big")
        + header.kdf_r.to_bytes(4, "big")
        + header.kdf_p.to_bytes(4, "big")
        + header.salt
        + header.nonce
    )


def _unpack_header(prefix: bytes) -> Header:
    if len(prefix) != HEADER_LEN or not prefix.startswith(MAGIC):
        raise CorruptBackupError("corrupt-backup")
    body = prefix[len(MAGIC):]
    version = body[0]
    if version != VERSION:
        raise CorruptBackupError("unsupported-version")
    kdf_n = int.from_bytes(body[1:5], "big")
    kdf_r = int.from_bytes(body[5:9], "big")
    kdf_p = int.from_bytes(body[9:13], "big")
    salt = body[13:13 + SALT_LEN]
    nonce = body[13 + SALT_LEN:13 + SALT_LEN + NONCE_LEN]
    if kdf_n < 2 or (kdf_n & (kdf_n - 1)) != 0 or kdf_r < 1 or kdf_p < 1:
        raise CorruptBackupError("corrupt-backup")
    # scrypt bellek/CPU bütçesi: aşırı N/r/p değerleri anahtarı çıkarmadan önce
    # reddedilir (sunucu/cihaz belleğini garanti eder, import donma/çökme yapamaz).
    if kdf_n > MAX_KDF_N or kdf_r > MAX_KDF_R or kdf_p > MAX_KDF_P:
        raise CorruptBackupError("unsupported-kdf")
    if 128 * kdf_n * kdf_r > MAX_KDF_MEMORY_BYTES:
        raise CorruptBackupError("unsupported-kdf")
    return Header(version=version, kdf_n=kdf_n, kdf_r=kdf_r, kdf_p=kdf_p,
                  salt=salt, nonce=nonce)


def encrypt_payload(payload: bytes, password: str) -> bytes:
    """Düz metin ``payload``'ı şifreler ve .kasaenc baytlarını döner.

    İki şeyi ayrı kaydeder: (1) kullanıcıya değil, (2) otomatik yedekte kullanılan
    dahili anahtar — her ikisi de aynı fonksiyonla üretilir; çağıran şifreyi seçer.
    """
    if len(password) > MAX_PASSWORD_LEN:
        raise ValueError("password-too-long")
    salt = secrets.token_bytes(SALT_LEN)
    nonce = secrets.token_bytes(NONCE_LEN)
    header = Header(version=VERSION, kdf_n=DEFAULT_KDF_N, kdf_r=DEFAULT_KDF_R,
                    kdf_p=DEFAULT_KDF_P, salt=salt, nonce=nonce)
    key = _derive_key(password, header)
    encryptor = Cipher(
        algorithms.AES(key), modes.GCM(nonce)
    ).encryptor()
    ciphertext = encryptor.update(payload) + encryptor.finalize()
    # GCM tag encryptor.tag (16B) ciphertext'in sonuna eklenir.
    return _pack_header(header) + ciphertext + encryptor.tag


def decrypt_payload(blob: bytes, password: str) -> bytes:
    """Şifreli .kasaenc baytlarını açıp düz metni döner; hatalara özel tür.

    - Başlık geçersiz / sürüm desteklenmiyor → CorruptBackupError
    - Yanlış şifre ya da kurcalanmış içerik → InvalidPasswordError
    (GCM tag doğrulaması bu ikisini ayrıştırır.)
    """
    if len(blob) <= HEADER_LEN:
        raise CorruptBackupError("corrupt-backup")
    header = _unpack_header(blob[:HEADER_LEN])
    body = blob[HEADER_LEN:]
    if len(body) < GCM_TAG_LEN:
        raise CorruptBackupError("corrupt-backup")
    ciphertext = body[:-GCM_TAG_LEN]
    tag = body[-GCM_TAG_LEN:]
    key = _derive_key(password, header)
    decryptor = Cipher(
        algorithms.AES(key), modes.GCM(header.nonce, tag)
    ).decryptor()
    try:
        plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    except InvalidTag:
        raise InvalidPasswordError("invalid-password")
    return plaintext


def build_encrypted_export_payload(
    data: list[dict[str, Any]], password: str
) -> bytes:
    """Kayıt listesini JSON'a çevirip şifreli yedek byte dizisi üretir."""
    payload = json.dumps(data, ensure_ascii=False, indent=4).encode("utf-8")
    return encrypt_payload(payload, password)


def decrypt_encrypted_records(
    blob: bytes, password: str
) -> list[dict[str, Any]]:
    """Şifreli .kasaenc içeriğini JSON kayıt listesine çözer."""
    plaintext = decrypt_payload(blob, password)
    try:
        data = json.loads(plaintext)
    except (ValueError, TypeError):
        raise CorruptBackupError("corrupt-backup")
    if not isinstance(data, list):
        raise CorruptBackupError("invalid-import-payload")
    return [item for item in data if isinstance(item, dict)]


def generate_backup_password() -> str:
    """Dışa aktarılan .kasaenc dosyası için güçlü tekrar-sız rastgele parola.

    ``secrets`` tabanlı; dosya yanlışlıkla düz metne düşerse bile tahmin
    edilemesin diye yüksek entropili üretilir.
    """
    return secrets.token_urlsafe(18)
