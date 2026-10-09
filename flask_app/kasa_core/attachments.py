"""Kayda dosya/ek ekleme — şifreli saklama, indirme, silme.

Tasarım kararı: ekler **veritabanında**, Fernet ile şifreli olarak saklanır
(diskte değil). Gerekçesi ölçülebilir:

1. Disk yolu geri alınabilir iz bırakır. Bir ek silindiğinde ya da kayıt
   düşürüldüğünde dosya yaşar ve kasa "temiz" görünürken diskte sır durur.
   `backup_database()` zaten SQL yedeği alıyor; ekler onunla birlikte
   yedeklenir ve geri yüklemede geri gelir.
2. `Backup` sınıfı bütün kayıtları zaten kapsıyor; ayrı bir dosya ağacı
   yedek/geri yükleme/taşıma mantığını üç ayrı yerde bozardı.
3. Boyut tavanı (`MAX_ATTACHMENT_BYTES`) küçük tutulduğu için BLOB maliyeti
   öngörülebilir.

🔴 GÜVENLİK — üç kural, hepsi ölçülebilir:

1. **Dosya adı da sırdır.** `kaskad_police_tamir.pdf` adı bile sızdırır, bu
   yüzden Fernet'lenir. Yalnız MIME ve boyut düz metindir; MIME kullanıcıya
   `application/octet-stream` olarak sabitlenen bir indirmede hiç yansımaz.
2. **İçerik asla "satır içi" sunulmaz.** Yüklenen HTML/SVG bir tarayıcıda
   çalıştırılırsa kasa sayfasında kalıcı XSS olur. Bu yüzden indirme
   `Content-Disposition: attachment` + `application/octet-stream` +
   `X-Content-Type-Options: nosniff` üçlüsüyle yapılır. `send_file` ile
   sunulduğunda tarayıcı Content-Type'a güvenir; bu yüzden tip **bize**
   sabitlenir, kullanıcının MIME'ine değil.
3. **Dosya adı temizlenir.** Yol ayırıcıları, `..` ve kontrol karakterleri
   atılır; indirmede `Content-Disposition` için ASCII'ye indirgenmiş kopya
   kullanılır (non-ASCII başlıkta tarayıcı/ara katman farkları yaratıyor).
"""

from __future__ import annotations

import base64
import re
import unicodedata
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from kasa_core.crypto import safe_decrypt, safe_encrypt

# 2 MB. Vault'ta tek bir kayda yüzlerce MB gömmek, tek HTML formuyla
# kullanıcının diskini doldurmanın en ucuz yolu olurdu.
MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
MAX_ATTACHMENT_NAME = 120
MAX_ATTACHMENT_MIME = 100

# Dışa aktarımda base64 metin olarak gömülür; JSON'un şişmemesi için
# (aşılırsa yedeğin tamamı kullanılamaz hale gelir) toplam ek bütçesi.
MAX_EXPORT_ATTACHMENT_BYTES = 8 * 1024 * 1024

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._ ()çğıöşüÇĞİÖŞÜ-]")
_SAFE_ASCII = re.compile(r"[^A-Za-z0-9._ -]")


def sanitize_filename(name: str | None, fallback: str = "ek") -> str:
    """Yol ayırıcıları ve kontrol karakterlerini atar, uzunluğu kısar."""
    raw = _CONTROL_CHARS.sub("", str(name or ""))
    # Hem '/' hem '\\' — Windows yolları da tehdit.
    raw = raw.replace("/", " ").replace("\\", " ")
    # 🔴 SIRA ÖNEMLİ: güvenli karakter filtresi ÖNCE, ayraç temizliği SONRA.
    # Ters sırada `"../../etc/passwd"` → `".. .. etc passwd"` →
    # `lstrip(".")` boşluğa takılıp yol öğesi olarak bırakılıyordu.
    raw = _UNSAFE_NAME.sub("", raw)
    # Ayraçları boşluğa çevirdik; artık nokta gruplarını BEKIR BOŞLUKTAN
    # ayırmak zorundayız. `lstrip(".")` tek bir grupta durur —
    # `".. .."` içinde ikinci grup kalıyordu. Token tabanlı: yalnız nokta
    # olan her token atılır.
    tokens = [tok for tok in raw.split() if set(tok) - {"."}]
    cleaned = " ".join(tokens).strip()
    if not cleaned:
        return fallback[:MAX_ATTACHMENT_NAME]
    return cleaned[:MAX_ATTACHMENT_NAME]


def safe_attachment_name(name: str) -> str:
    """`Content-Disposition` başlığı için ASCII güvenli kopya."""
    normalized = unicodedata.normalize("NFKD", name)
    ascii_name = _SAFE_ASCII.sub("_", normalized.encode("ascii", "ignore").decode())
    ascii_name = ascii_name.strip() or "ek"
    return ascii_name[:MAX_ATTACHMENT_NAME]


def normalize_mime(value: str | None) -> str:
    mime = _CONTROL_CHARS.sub("", str(value or ""))[:MAX_ATTACHMENT_MIME]
    return mime if "/" in mime else "application/octet-stream"


def encrypt_attachment(fernet: Fernet, data: bytes) -> bytes:
    """Ek gövdesini Fernet metnine çevirir (bayt olarak saklanır).

    🔴 `base64.b64encode` BAYT döndürür; `safe_encrypt` metin bekler, yoksa
    `AttributeError: 'bytes' object has no attribute 'encode'` veriyor.
    """
    if not data:
        return b""
    encoded = base64.b64encode(data).decode("ascii")
    return safe_encrypt(fernet, encoded).encode("utf-8")


def decrypt_attachment(fernet: Fernet, blob: bytes | None) -> bytes:
    """Ek gövdesini çözer; bozuk/şifrelenmemişse boş bayt."""
    if not blob:
        return b""
    try:
        raw = safe_decrypt(fernet, blob.decode("utf-8"))
        return base64.b64decode(raw, validate=True)
    except (InvalidToken, ValueError, TypeError, UnicodeDecodeError):
        return b""


def record_attachment_meta(record, fernet: Fernet) -> dict[str, Any]:
    """Kart/JSON görünümü için **sır içermeyen** özet.

    🔴 Yalnız varlık, ad ve boyut döner — gövde asla. Çağıran taraf gövdeyi
    ayrı, kimlik doğrulamalı uçtan ister.
    """
    if not record.encrypted_attachment:
        return {}
    name = safe_decrypt(fernet, record.attachment_name or "")
    return {
        "name": name or "ek",
        "mime": record.attachment_mime or "application/octet-stream",
        "size": int(record.attachment_size or 0),
    }


def clear_attachment(record) -> None:
    """Eki ve adını temizler (yeniden yüklemeden önce çağrılır)."""
    record.encrypted_attachment = None
    record.attachment_name = ""
    record.attachment_mime = ""
    record.attachment_size = 0


def base64_payload(fernet: Fernet, blob: bytes | None) -> str:
    """Dışa aktarım için şifrelenmemiş gövdenin base64 metni.

    🔴 Yalnız dışa aktarımda kullanılır; düz JSON dışa aktarımı zaten parolaları
    düz metin taşıyor, ekler de aynı sınıfta. `.kasaenc` içinde ise gövde
    dosyanın kendi şifresiyle korunur.
    """
    return base64.b64encode(decrypt_attachment(fernet, blob)).decode("ascii") if blob else ""


def restore_attachment(
    record,
    fernet: Fernet,
    name: str,
    payload: str,
    mime: str = "",
) -> bool:
    """İçe aktarımda ek gövdesini geri yükler. Başarı durumunu döndürür."""
    if not payload:
        return False
    try:
        data = base64.b64decode(payload, validate=True)
    except (ValueError, TypeError):
        return False
    if not data or len(data) > MAX_ATTACHMENT_BYTES:
        return False
    clear_attachment(record)
    record.encrypted_attachment = encrypt_attachment(fernet, data)
    record.attachment_name = safe_encrypt(fernet, sanitize_filename(name))
    record.attachment_mime = normalize_mime(mime)
    record.attachment_size = len(data)
    return True