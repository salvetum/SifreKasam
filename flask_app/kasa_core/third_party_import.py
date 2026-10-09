"""Üçüncü parti şifre yöneticisi dosyalarını içe aktarma.

Tasarım kararı: **marka algılama içerikten yapılır, uzantıdan değil.** Nedeni
ölçülebilir: her satıcının farklı varsayılan uzantısı var (Bitwarden `.json`,
LastPass `.csv`, KeePass `.xml`, 1Password `.4pif`/`.json`, Chrome `.csv`) ve
kullanıcı dosyayı sık sık elle yeniden adlandırıyor. Uzantıya güvenmek
"desteklenmeyen biçim" hatalarının çoğunu kullanıcı hatası gibi gösterir.

`detect_format()` sırayla deniyor ve **ilk tam eşleşen** çözümleyiciyi seçiyor;
bulamazsa `kasa_json` varsayılanına düşer (kendi yedeklerimiz her zaman geçerli
kalmalı — aksi hâlde bir içe aktarma regresyonu yeni bir satırla gelirdi).

Çıktı sözleşmesi: her adaptör **kanonik sözlük** döndürür, anahtarlar
`parse_import_record`'ın zaten bildiği isimlerle birebir aynıdır; üstüne
iki tane yeni isim gelir: `tags` (list[str]) ve `custom_fields`
(list[{'label','value','secret'}]) — bunlar Faz 1'de eklenen şifreli JSON
sütunlarına yazılır, dolayısıyla Bitwarden'daki özel alanlar ve klasörler
kaybolmaz.

🔴 Sır disiplini: bu modül hiçbir yerde içeriği loglamaz, hata mesajına
koymaz ve `audit()`'a geçmez (bkz. `kasa_core/audit.py` — `DENIED_FIELD_NAMES`
içinde `value`/`data`/`content`/`tag`/`tags` var, yani sızan kayıt zaten
fail-closed). Bilerek verilmeyen tek bilgi **satır sayısı**dır, o da toplam
tavan aşıldığında `dropped` sayacı olarak döner.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import xml.etree.ElementTree as ET
from typing import Any, Callable

from kasa_core.constants import MAX_IMPORT_RECORDS
from kasa_core.record_extras import (
    MAX_FIELD_LABEL,
    MAX_FIELD_VALUE,
    MAX_TAG_LENGTH,
    normalize_custom_fields,
    normalize_tags,
)
from kasa_core.validation import normalize_text

# Kullanıcıya gösterilecek dosya uzantısı listesi (modalın `accept`
# özniteliği ve iç ipucu metni bu sabitten beslenir).
ACCEPTED_EXTENSIONS = (
    ".json",
    ".csv",
    ".txt",
    ".kasa",
    ".kasaenc",
    ".xml",
    ".4pif",
)

MAX_IMPORT_BYTES = 8 * 1024 * 1024


# ---------------------------------------------------------------------------
# Biçim algılama
# ---------------------------------------------------------------------------

def _sniff_json(raw: bytes) -> Any:
    """UTF-8/BOM dayanıklı JSON ayrıştırıcı. Hata `ValueError` yükseltir."""
    try:
        return json.loads(raw.decode('utf-8-sig'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError('invalid-import-payload') from exc


def _looks_bitwarden(payload: Any) -> bool:
    """Bitwarden dışa aktarımı: üstte `items` dizisi + **tamsayı** `type`.

    🔴 Yalnız `items` + `type` varlığına bakmak yetmez: kullanıcının kasası
    sadece kart/notes içeriyorsa hiçbir öğede `login` anahtarı bulunmaz ve
    dosya `kasa_json` sanılıp bozuk sayılıyordu. Ayırt edici olan `type`
    alanının **tamsayı** olmasıdır — kendi biçimimizde `type` metindir
    (`"Website"`), Bitwarden'de 1/2/3/4 sayıdır.
    """
    return (
        isinstance(payload, dict)
        and isinstance(payload.get('items'), list)
        and any(
            isinstance(item, dict) and isinstance(item.get('type'), int)
            for item in payload['items']
        )
    )


def _looks_1password(payload: Any) -> bool:
    """1Password şifresiz JSON dışa aktarımı: `detailsPlaintext.fields`."""
    return (
        isinstance(payload, list)
        and any(
            isinstance(item, dict) and isinstance(item.get('detailsPlaintext'), dict)
            for item in payload
        )
    )


def _csv_header(raw: bytes) -> list[str]:
    """CSV başlık satırını normalize edilmiş sütun adları olarak döndürür."""
    sample = raw[:8192].decode('utf-8-sig', errors='replace')
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=',;\t')
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(sample), dialect)
    for row in reader:
        return [normalize_text(cell).casefold() for cell in row]
    return []


def _csv_rows(raw: bytes) -> list[dict[str, str]]:
    sample = raw[:8192].decode('utf-8-sig', errors='replace')
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=',;\t')
    except csv.Error:
        dialect = csv.excel
    # 🔴 `dialect` **konumel** geçirilemez: `DictReader`'ın 2. konum argümanı
    # `fieldnames`'tır ve `iter(fieldnames)` TypeError verir. Anahtar kelime şart.
    reader = csv.DictReader(
        io.StringIO(raw.decode('utf-8-sig', errors='replace')), dialect=dialect
    )
    return [dict(row) for row in reader if isinstance(row, dict)]


def _looks_csv(raw: bytes) -> bool:
    return b',' in raw[:4096] or b'\t' in raw[:4096] or b';' in raw[:4096]


def _looks_keepass_xml(raw: bytes) -> bool:
    head = raw[:2048].lstrip()
    if not head.startswith(b'<'):
        return False
    return b'KeePassFile' in raw[:4096] or b'<KeePass' in raw[:4096]


# ---------------------------------------------------------------------------
# Ortak yardımcılar
# ---------------------------------------------------------------------------

def _first(item: dict[str, Any], *keys: str) -> Any:
    """İlk dolu anahtarı döndürür; hiçbiri yoksa `''`."""
    for key in keys:
        value = item.get(key)
        if value not in (None, '', [], {}):
            return value
    return ''


def _text(value: Any, max_length: int = MAX_FIELD_VALUE) -> str:
    if value is None:
        return ''
    if isinstance(value, (list, tuple)):
        value = ' '.join(str(part) for part in value)
    return normalize_text(str(value), max_length=max_length)


def _year(value: Any) -> str:
    """`2029`, `2029.0`, `'2029'`, `'12/2029'` girişlerini yıl metnine indirger."""
    text = _text(value, 40)
    match = re.search(r'(19|20)\d{2}', text)
    return match.group(0) if match else ''


def _month(value: Any) -> str:
    text = _text(value, 40)
    if re.fullmatch(r'0?[1-9]|1[0-2]', text):
        return str(int(text))
    return ''


def _month_year(expiry: str) -> str:
    """`2029-12` veya `12/2029` gibi birleşik değerden `YYYY-MM` üretir."""
    text = _text(expiry, 40)
    match = re.search(r'((?:19|20)\d{2})\D{0,3}(\d{1,2})', text)
    if match:
        month = int(match.group(2))
        if 1 <= month <= 12:
            return f'{match.group(1)}-{month:02d}'
    return ''


def _expiry_value(*parts: Any) -> str:
    """Farklı ayrım düzenlerini tek `YYYY-MM` biçimine indirger."""
    combined = _month_year(' '.join(_text(part, 40) for part in parts if part))
    if combined:
        return combined
    year = _year(parts[0] if parts else '')
    month = _month(parts[1] if len(parts) > 1 else '')
    return f'{year}-{month}' if year and month else ''


def _custom_field(label: Any, value: Any, secret: bool = False) -> dict[str, Any]:
    """Tek özel alan; uzunluk sınırları Faz 1'in sınırlarıyla aynı."""
    return {
        'label': _text(label, MAX_FIELD_LABEL),
        'value': _text(value, MAX_FIELD_VALUE),
        'secret': bool(secret),
    }


def _blank(**overrides: Any) -> dict[str, Any]:
    """Kanonik boş kayıt — her adaptör bunu başlangıç olarak kullanır."""
    base: dict[str, Any] = {
        'title': '',
        'login': '',
        'password': '',
        'email': '',
        'website_url': '',
        'comment': '',
        'category': '',
        'type': '',
        'card_holder': '',
        'expiry_date': '',
        'tags': [],
        'custom_fields': [],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Adaptörler
# ---------------------------------------------------------------------------

def _bitwarden(payload: Any) -> list[dict[str, Any]]:
    """Bitwarden (KeeWeb, Web ve masaüstü) şifresiz JSON dışa aktarımı.

    `type`: 1=login, 2=güvenli not, 3=kart, 4=kimlik. Klasörler `folderId`
    ile bağlanır ve **etikete** çevrilir; `fields` özel alana, `totp`
    alanı olmadığı için **özel alana** gider (2FA kapsam dışı, bkz. Faz 2
    kararı) — kaybolmasındansa şifreli saklanması yeğdir.
    """
    folders: dict[str, str] = {}
    for folder in payload.get('folders') or []:
        if isinstance(folder, dict) and folder.get('id'):
            folders[str(folder['id'])] = _text(folder.get('name'), 120)

    records: list[dict[str, Any]] = []
    for item in payload.get('items') or []:
        if not isinstance(item, dict):
            continue
        item_type = item.get('type')
        record = _blank(
            title=_text(item.get('name'), 200),
            comment=_text(item.get('notes'), 5000),
        )
        folder_name = folders.get(str(item.get('folderId') or ''), '')
        tags = [folder_name] if folder_name else []

        if item_type == 1:
            login = item.get('login') if isinstance(item.get('login'), dict) else {}
            uris = login.get('uris') if isinstance(login.get('uris'), list) else []
            record['type'] = 'Website' if uris else 'Application'
            record['website_url'] = _text(_first(uris[0] if uris else {}, 'uri', 'match'), 500)
            record['login'] = _text(login.get('username'), 300)
            record['password'] = _text(login.get('password'), 1000)
            if login.get('totp'):
                # 2FA kapsam dışı; kaybolmasın diye şifreli özel alana yazılır.
                record['custom_fields'].append(_custom_field('TOTP (2FA)', login['totp'], True))
        elif item_type == 2:
            record['type'] = 'SecureNote'
            secure_note = item.get('secureNote') if isinstance(item.get('secureNote'), dict) else {}
            record['comment'] = _text(_first(secure_note, 'content', 'notes'), 5000) or record['comment']
        elif item_type == 3:
            card = item.get('card') if isinstance(item.get('card'), dict) else {}
            record['type'] = 'CreditCard'
            record['card_holder'] = _text(card.get('cardholderName'), 120)
            record['login'] = _text(_first(card, 'number'), 300)
            record['expiry_date'] = _expiry_value(card.get('expYear'), card.get('expMonth'))
            record['website_url'] = _text(_first(card, 'brand'), 120)
            if card.get('code'):
                record['custom_fields'].append(_custom_field('CVV', card['code'], True))
        else:
            record['type'] = 'Other'

        for field in item.get('fields') or []:
            if not isinstance(field, dict):
                continue
            # Bitwarden alan tipi 3 = gizli (hiddi), 0/1 = düz.
            record['custom_fields'].append(
                _custom_field(field.get('name'), field.get('value'), field.get('type') == 3)
            )

        record['tags'] = normalize_tags(tags)
        records.append(record)
    return records


def _onepassword(payload: Any) -> list[dict[str, Any]]:
    """1Password şifresiz JSON dışa aktarımı (`detailsPlaintext.fields`).

    Bu biçimde alanlar `designation` (alanın rolü) ve `type` (`T`=metin,
    `C`=kilitli/gizli) taşır. `url` bir liste olabilir.
    """
    records: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        details = item.get('detailsPlaintext') if isinstance(item.get('detailsPlaintext'), dict) else {}
        record = _blank(
            title=_text(_first(item, 'title', 'overview', 'name'), 200),
            website_url=_text(_first(item, 'location', 'url'), 500),
            comment=_text(details.get('notesPlaintext'), 5000),
        )
        urls = item.get('urls') if isinstance(item.get('urls'), list) else []
        if urls and not record['website_url']:
            record['website_url'] = _text(_first(urls[0] if isinstance(urls[0], dict) else {}, 'href', 'url'), 500)
        record['type'] = 'Website' if record['website_url'] else 'Application'

        for field in details.get('fields') or []:
            if not isinstance(field, dict):
                continue
            designation = _text(field.get('designation'), 40).casefold()
            value = _text(field.get('value'), MAX_FIELD_VALUE)
            if designation == 'username':
                record['login'] = value
            elif designation == 'password':
                record['password'] = value
            elif designation == 'notes':
                record['comment'] = value or record['comment']
            elif designation in {'cardholder name', 'cardholder'}:
                record['card_holder'] = value
            elif designation == 'totp':
                record['custom_fields'].append(_custom_field('TOTP (2FA)', value, True))
            elif field.get('id') or field.get('label') or value:
                label = _first(field, 'label', 'id', 'designation')
                record['custom_fields'].append(
                    _custom_field(label, value, _text(field.get('type'), 4).upper().startswith('C'))
                )
        record['tags'] = normalize_tags(item.get('tags'))
        records.append(record)
    return records


def _lastpass_csv(raw: bytes) -> list[dict[str, Any]]:
    """LastPass `lastpass_export.csv`.

    Başlık: `url,username,password,totp,extra,name,grouping,fav`. `extra`
    içinde satır sonu ayrılmış `alan: değer` çiftleri olur — bunlar özel
    alana çevrilir. `grouping` etikete gider.
    """
    records: list[dict[str, Any]] = []
    for row in _csv_rows(raw):
        row = {key.strip().casefold(): value for key, value in row.items() if key}
        record = _blank(
            title=_text(_first(row, 'name', 'username', 'url'), 200),
            login=_text(_first(row, 'username'), 300),
            password=_text(_first(row, 'password'), 1000),
            website_url=_text(_first(row, 'url'), 500),
            type='Website' if _text(row.get('url')) else 'Application',
            tags=normalize_tags(_text(row.get('grouping'), MAX_FIELD_LABEL)),
        )
        if _text(row.get('totp')):
            record['custom_fields'].append(_custom_field('TOTP (2FA)', row['totp'], True))
        extra = _text(row.get('extra'), MAX_FIELD_VALUE)
        if extra:
            for line in extra.splitlines():
                key, sep, value = line.partition(':')
                if sep and _text(key, MAX_FIELD_LABEL):
                    record['custom_fields'].append(_custom_field(key, value, False))
            if not record['comment']:
                record['comment'] = normalize_text(extra, max_length=5000)
        records.append(record)
    return records


def _generic_csv(raw: bytes) -> list[dict[str, Any]]:
    """Chrome / Firefox / 1Password CSV dışa aktarımları.

    Sütun adları satıcıya göre değişir; eşleme bilinmeyen alanları yok sayar.
    Tanınmayan sütun **değerleri** özel alana taşınır — kullanıcının
    dışa aktardığı her şey kaybolmasın diye (üstel kısıtlı sayıda).
    """
    known = {
        'name', 'title', 'username', 'user', 'login', 'password', 'pass',
        'url', 'urls', 'website', 'website_url', 'host', 'hostname', 'notes',
        'note', 'comment', 'extra', 'grouping', 'folder', 'category',
        'group', 'email', 'e-mail', 'otpauth', 'totp', 'fav',
    }
    records: list[dict[str, Any]] = []
    for row in _csv_rows(raw):
        row = {key.strip().casefold(): value for key, value in row.items() if key}
        if not any(_text(value) for value in row.values()):
            continue
        record = _blank(
            title=_text(_first(row, 'name', 'title', 'username', 'login', 'url'), 200),
            login=_text(_first(row, 'username', 'user', 'login'), 300),
            password=_text(_first(row, 'password', 'pass'), 1000),
            email=_text(row.get('email') or row.get('e-mail'), 300),
            website_url=_text(_first(row, 'url', 'urls', 'website', 'website_url', 'host', 'hostname'), 500),
            comment=_text(_first(row, 'notes', 'note', 'comment', 'extra'), 5000),
            type='Website' if _text(_first(row, 'url', 'website', 'host', 'hostname')) else 'Application',
            tags=normalize_tags(_text(_first(row, 'grouping', 'folder', 'category', 'group'), MAX_FIELD_LABEL)),
        )
        if _text(_first(row, 'totp', 'otpauth')):
            record['custom_fields'].append(_custom_field('TOTP (2FA)', _first(row, 'totp', 'otpauth'), True))
        for key, value in row.items():
            if key in known or not _text(value, MAX_FIELD_VALUE):
                continue
            record['custom_fields'].append(_custom_field(key, value, False))
        records.append(record)
    return records


def _keepass_entry(entry: ET.Element, path: list[str]) -> dict[str, Any]:
    """Tek `<Entry>` düğümünü kanonik kayda çevirir.

    🔴 `fields` sözlüğü **küçük harfli anahtarla** tutulur (eşleme için), ama
    özel alan **etiketi orijinal yazımıyla** korunur — ilk ölçümde
    `casefold()` edilmiş anahtarlar etiket olarak basılıyordu ve kullanıcının
    "Ozel" adı "ozel" olmuştu.
    """
    fields: dict[str, str] = {}
    labels: dict[str, str] = {}
    for node in entry.findall('String'):
        raw_key = normalize_text(node.findtext('Key') or '', max_length=MAX_FIELD_LABEL)
        if not raw_key:
            continue
        key = raw_key.casefold()
        fields[key] = normalize_text(node.findtext('Value') or '', max_length=MAX_FIELD_VALUE)
        labels.setdefault(key, raw_key)
    record = _blank(
        title=_text(_first(fields, 'title', 'account', 'login name', 'user name'), 200),
        login=_text(_first(fields, 'username', 'user name', 'login name'), 300),
        password=_text(_first(fields, 'password'), 1000),
        email=_text(fields.get('email'), 300),
        website_url=_text(_first(fields, 'url', 'website'), 500),
        comment=_text(fields.get('notes'), 5000),
        type='Website' if _text(fields.get('url')) else 'Application',
        tags=normalize_tags(path),
    )
    known = {'title', 'username', 'user name', 'login name', 'password',
             'email', 'url', 'website', 'notes', 'group'}
    for key, value in fields.items():
        if key in known or not value:
            continue
        record['custom_fields'].append(_custom_field(labels.get(key, key), value, False))
    return record


def _keepass_walk(element: ET.Element, path: list[str],
                  records: list[dict[str, Any]]) -> None:
    """`<Root>` ağacını özyinelemeli gezer; her `Group` adı etikete eklenir.

    Düz `root.iter('Group')` + `iterfind('Group')` yaklaşımı ölçülüp **reddedildi**:
    yalnız *doğrudan* alt grupları gördüğü için `Root/Alt/Entry` yolunda yalnız
    "Alt" etiketi üretiliyordu, "Root" kayboluyordu.

    🔴 `root.iter()` yerine elle geziliyor, çünkü yalnız `<Entry>` altındakiler
    alınmalı: `<DeletedObjects>` altındaki **silinmiş** kayıtlar KeePass'ta
    gerçekten durur ve `iter()` onları da içe aktarmaya sokardı.
    """
    for child in element:
        if child.tag == 'String':
            continue
        if child.tag == 'Entry':
            records.append(_keepass_entry(child, path))
        elif child.tag == 'DeletedObjects':
            continue
        else:
            name = ''
            if child.tag == 'Group':
                name = normalize_text(child.findtext('Name') or '', max_length=MAX_TAG_LENGTH)
            _keepass_walk(child, path + [name] if name else path, records)


def _keepass_xml(raw: bytes) -> list[dict[str, Any]]:
    """KeePass 2.x XML veri dosyası.

    🔴 `xml.etree.ElementTree` Python 3'te **dış varlık genişletmez** (DOCTYPE
    içe/dışa bağlantı çözmez), bu yüzden XXE yüzeyi yok; `resolve_entities`
    tabanlı `lxml` bilerek kullanılmıyor.

    Klasör zinciri (`Group/Group/Entry`) etiket olarak taşınır — KeePass'ta
    kategori gömülü bir yoldur ve bu uygulamada kategori metin alanı
    olduğundan hiyerarşiyi etikette korumak en sadeleştirici eşlemedir.
    """
    root = ET.fromstring(raw.decode('utf-8-sig', errors='replace'))
    records: list[dict[str, Any]] = []
    _keepass_walk(root, [], records)
    return records


def _kasa_json(payload: Any) -> list[dict[str, Any]]:
    """Kendi yedek biçimimiz — alanlar zaten kanonik.

    Sır sınıflandırması korunur: `tags` metadata (metin), `custom_fields`
    değerleri sır → `secret` bayrağı aynen taşınır.
    """
    if isinstance(payload, dict) and isinstance(payload.get('records'), list):
        payload = payload['records']
    if not isinstance(payload, list):
        raise ValueError('invalid-import-payload')
    records = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        record = _blank(
            title=_text(_first(item, 'title', 'Website name', 'Application', 'Account name', 'SecureNote', 'CreditCard'), 200),
            login=_text(_first(item, 'login', 'Login', 'Login name', 'CreditCard'), 300),
            password=_text(_first(item, 'password', 'Password'), 1000),
            email=_text(_first(item, 'email', 'Email'), 300),
            website_url=_text(_first(item, 'website_url', 'Website URL', 'URL'), 500),
            comment=_text(_first(item, 'comment', 'Comment', 'SecureNote'), 5000),
            category=_text(_first(item, 'category', 'Category'), 120),
            type=_text(_first(item, 'type'), 40),
            card_holder=_text(_first(item, 'card_holder', 'Card holder'), 120),
            expiry_date=_text(_first(item, 'expiry_date', 'Expiry Date'), 40),
            tags=normalize_tags(item.get('tags') or item.get('tags_text')),
        )
        for field in item.get('custom_fields') or []:
            if isinstance(field, dict):
                record['custom_fields'].append(_custom_field(
                    _first(field, 'label', 'name'), _first(field, 'value'), bool(field.get('secret'))
                ))
        records.append(record)
    return records


# ---------------------------------------------------------------------------
# Giriş noktası
# ---------------------------------------------------------------------------

def detect_format(filename: str, raw: bytes) -> str:
    """Dosyanın biçimini **içerikten** belirler.

    🔴 Sıra ölçülmüş bir tuzaktır: CSV imzası (virgül/tab/semikolon) JSON'da
    **her yerde** bulunur, bu yüzden JSON **önce** denenir. Ters sırada
    Bitwarden/1Password dışa aktarımları CSV sanılır (ilk ölçümde olan buydu).
    KeePass XML'i `<` ile başladığı için her ikisinden de önce gelir.
    """
    if filename.lower().endswith('.kasaenc'):
        return 'kasaenc'
    if _looks_keepass_xml(raw):
        return 'keepass_xml'
    try:
        payload = _sniff_json(raw)
    except ValueError:
        payload = None
    if payload is not None:
        if _looks_bitwarden(payload):
            return 'bitwarden'
        if _looks_1password(payload):
            return '1password'
        return 'kasa_json'
    if _looks_csv(raw):
        return 'lastpass_csv' if 'grouping' in _csv_header(raw) else 'generic_csv'
    return 'kasa_json'


def parse_third_party(filename: str, raw: bytes) -> tuple[list[dict[str, Any]], int]:
    """Dosyayı kanonik kayıt listesine çevirir.

    Döndürür: `(kayıtlar, düşürülen_sayı)`. `MAX_IMPORT_RECORDS` aşıldığında
    fazlası sessizce atılır ve sayı döner (mevcut `/import` rotası bunu
    `?import_dropped=` toast'u olarak zaten gösteriyor).

    🔴 Bellek: `MAX_IMPORT_BYTES` sınırı burada **değil** route'ta
    (`MAX_CONTENT_LENGTH`) uygulanır; bu fonksiyon yalnız içerik zaten bellekte
    olduğu için çalışır.
    """
    if len(raw) > MAX_IMPORT_BYTES:
        raise ValueError('import-file-too-large')
    kind = detect_format(filename, raw)
    parser: Callable[[Any], list[dict[str, Any]]]
    source: Any
    if kind == 'kasaenc':
        raise ValueError('unsupported-import-format')
    if kind == 'keepass_xml':
        parser, source = _keepass_xml, raw
    elif kind == 'lastpass_csv':
        parser, source = _lastpass_csv, raw
    elif kind == 'generic_csv':
        parser, source = _generic_csv, raw
    elif kind == 'bitwarden':
        parser, source = _bitwarden, _sniff_json(raw)
    elif kind == '1password':
        parser, source = _onepassword, _sniff_json(raw)
    else:
        parser, source = _kasa_json, _sniff_json(raw)
    try:
        parsed = parser(source)
    except ET.ParseError as exc:
        raise ValueError('invalid-import-payload') from exc
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError('invalid-import-payload') from exc
    parsed = [record for record in parsed if isinstance(record, dict)]
    dropped = max(0, len(parsed) - MAX_IMPORT_RECORDS)
    return parsed[:MAX_IMPORT_RECORDS], dropped


def format_label(kind: str) -> str:
    """Algılanan biçimin kullanıcıya gösterilecek kısa adı."""
    return {
        'bitwarden': 'Bitwarden',
        '1password': '1Password',
        'lastpass_csv': 'LastPass',
        'generic_csv': 'CSV',
        'keepass_xml': 'KeePass',
        'kasa_json': 'ŞifreKasam',
        'kasaenc': 'Şifreli yedek',
    }.get(kind, 'CSV')

