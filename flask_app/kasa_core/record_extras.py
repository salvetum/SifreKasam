"""Özel alanlar ve etiketler — kayıt başına ek veri.

Tasarım kararı: ikisi de **şifreli tek bir JSON kümesi** olarak saklanır, ayrı
tablo/ilişki YOK. Gerekçesi ölçülebilir:

1. Özel alan değerleri sırdır (API anahtarı, PIN, kurtarma kodu). Düz metne
   düşürülürse `records` tablosunun tamamı şifre gerektirmeden okunabilir hâle
   gelir; oysa bugün her metadata alanı `RECORD_METADATA_PREFIX`'li Fernet
   metnidir (`kasa_core/crypto.py`). Ayrı tablo açmak bu garantiyi yalnız
   `title/website_url/login/email/card_holder` için korurdu.
2. Uygulamada **sunucu ucu arama yok** — arama tamamen istemci tarafında ve
   zaten çözülmüş veriyle çalışır (`vault-index.js`). Şifreli saklamak arama,
   filtre veya sıralama yeteneğinden hiçbir şey götürmez.
3. `ALTER TABLE ... ADD COLUMN` idempotent desen zaten dosyada var
   (`app.py`, `email` / `card_holder` eklemeleri); yeni tablo + foreign key
   ise ayrı bir migration yüzeyi ve `ON DELETE CASCADE` sorumluluğu getirirdi.

Alan adı kararı `records.encrypted_custom_fields` / `records.encrypted_tags`:
`safe_decrypt` (metadata prefix'i YOK) kullanılır, çünkü bu sütunlarda "eski
düz metin" diye bir durum hiç olmadı — prefix'i kullanmanın tek işlevi
`migrate_plaintext_record_metadata`'nın düz metni ayırt etmesidir.

Sır sınıflandırması: etiketler `category` ile aynı düzeyde **metadata**
sayılır (kullanıcının kendi verdiği ücretsiz etiketler); özel alan
**değerleri** ise sır kabul edilir. Bkz. `app.py:index()` — ızgara yalnız
etiketleri ve sır olmayan alanları taşır, `hide_secrets` varken özel alanlar
satır hiç oluşturmaz (mevcut "maske değil, yok" kuralı).
"""

from __future__ import annotations

import json
import unicodedata
from typing import Any

from cryptography.fernet import Fernet

from kasa_core.crypto import safe_decrypt, safe_encrypt
from kasa_core.validation import normalize_text

# Sınırlar. Kayıt başına sınırsız büyüyen ek veri, tek bir HTML formuyla
# kullanıcının makinelerini kilitlemenin en ucuz yoludur.
MAX_CUSTOM_FIELDS = 30
MAX_FIELD_LABEL = 60
MAX_FIELD_VALUE = 2000
MAX_TAGS = 20
MAX_TAG_LENGTH = 30

# Türkçe'nin noktalı ve noktasız `i` çifti büyük/küçük harf karşılaştırmasını
# bozar. Ölçüldü: `"İş".casefold()` -> `'i' + U+0307 + 'ş'` (birleşik nokta),
# `"iş".casefold()` -> `'i' + 'ş'` (düz). Yani **aynı kelime iki farklı etiket
# olur** ve ikisi birbirini tekilleştirmez. U+0130'in tek birleşimi U+0307
# olduğundan (Türkçede `i` ve `ı` dışında "noktalı i" harfi yoktur) bu kod
# noktasını kaldırmak hem `İş`/`iş` hem `İŞ`/`iş` çiftlerini eşitler.
_TURKISH_COMBINING_DOT = "̇"


def fold_label(text: str) -> str:
    """Türkçe büyük/küçük I çiftini de eşitleyen, NFC normalize kırpma."""
    return unicodedata.normalize("NFC", text).casefold().replace(
        _TURKISH_COMBINING_DOT, ""
    )


def encrypt_json(fernet: Fernet, value: Any) -> str:
    """Herhangi bir JSON-uyumlu değeri Fernet metnine çevirir."""
    if not value:
        return ""
    try:
        return safe_encrypt(fernet, json.dumps(value, ensure_ascii=False))
    except (TypeError, ValueError):
        return ""


def decrypt_json(fernet: Fernet, value: str, fallback: Any) -> Any:
    """Fernet metnini JSON'a çevirir; bozuk/şifrelenememişse `fallback`.

    `safe_decrypt` bozuk metinde `"[Şifre Çözülemedi]"` döner; bu JSON için
    işe yaramaz (parse edilemez) ve kullanıcıya anlamsız bir etiket gösterirdi.
    Bu yüzden bu yol kendi hata politikasını uygular.
    """
    if not value:
        return fallback
    try:
        plaintext = safe_decrypt(fernet, value)
        parsed = json.loads(plaintext)
    except Exception:
        return fallback
    return parsed if isinstance(parsed, type(fallback)) else fallback


def normalize_custom_fields(raw: Any) -> list[dict[str, Any]]:
    """Ham girdiyi kanonik özel alan listesine indirger.

    Kanonik biçim: `[{'label': str, 'value': str, 'secret': bool}, ...]`
    - Etiketsiz alanlar **düşürülür** (etiket yoksa kullanıcı ne aradığını
      bilmez; boş satır kaydı kirletir).
    - Etiketler birebir karşılaştırma için normalize edilir; aynı etiket iki
      kez tutulursa ilki kazanır (sessizce son değeri ezmek yerine).
    - Sıralama korunur (kullanıcının yazdığı sıra anlamlıdır).
    """
    if not isinstance(raw, (list, tuple)):
        return []
    seen: set[str] = set()
    fields: list[dict[str, Any]] = []
    for item in raw[:MAX_CUSTOM_FIELDS]:
        if not isinstance(item, dict):
            continue
        label = normalize_text(item.get('label'), max_length=MAX_FIELD_LABEL)
        if not label:
            continue
        key = fold_label(label)
        if key in seen:
            continue
        seen.add(key)
        fields.append({
            'label': label,
            'value': normalize_text(item.get('value'), max_length=MAX_FIELD_VALUE),
            'secret': bool(item.get('secret')),
        })
    return fields


def normalize_tags(raw: Any) -> list[str]:
    """Ham etiket listesini kanonik biçime indirger.

    - Liste veya "virgülle ayrılmış metin" ikisini de kabul eder (form
      tek metin kutusu gönderir, JSON içe aktarma liste verir).
    - Küçük harfe indirgenir (`fold_label` — Türkçe `İ`/`i` çifti de eşitlenir),
      kırpılır, **tekilleştirilir ve sıralanır**; sıralama kanonik olduğu için
      aynı küme iki farklı yüklemede aynı şifreli metni üretir
      (yedek/aktarma kararlılığı için önemli).
    """
    if isinstance(raw, str):
        raw = raw.split(",")
    if not isinstance(raw, (list, tuple)):
        return []
    cleaned: set[str] = set()
    for item in raw:
        text = item if isinstance(item, str) else ""
        tag = fold_label(normalize_text(text, max_length=MAX_TAG_LENGTH))
        if tag:
            cleaned.add(tag)
    return sorted(cleaned)[:MAX_TAGS]


def custom_fields_from_form(form) -> list[dict[str, Any]]:
    """`cf_*` indeksli form alanlarını kanonik listeye çevirir.

    Sır bayrağı **checkbox**'tır ve işaretlenmediğinde GÖNDERİLMEZ; bu yüzden
    `form.get(...)` yokluğu `False` demektir (yeni alanda varsayılan değer
    zaten gizli değil). 🔴 `disabled` ASLA konmaz: AGENTS.md'deki tuzak,
    formun gerçek bir HTML formu olduğunu ve eksik gönderilen checkbox'ın
    `False` yazılacağını hatırlatır.
    """
    collected: list[dict[str, Any]] = []
    index = 0
    while index < MAX_CUSTOM_FIELDS * 2:
        label_key = f'cf_label_{index}'
        if label_key not in form:
            index += 1
            continue
        collected.append({
            'label': form.get(label_key, ''),
            'value': form.get(f'cf_value_{index}', ''),
            'secret': bool(form.get(f'cf_secret_{index}')),
        })
        index += 1
    return normalize_custom_fields(collected)


def tags_from_form(form) -> list[str]:
    return normalize_tags(form.get('tags', ''))