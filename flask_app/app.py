# ─── IMPORTS ──────────────────────────────────────────────────────────────────
import base64
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import shutil
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import serialization
from cryptography import x509
from cryptography.x509.oid import NameOID
import ipaddress
from urllib.parse import urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from flask import (Flask, Response, abort, g, jsonify, has_request_context,
                   redirect, render_template, request, send_file, session, url_for)
from flask_login import (LoginManager, UserMixin, current_user, login_required,
                         login_user, logout_user)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

try:
    from zxcvbn import zxcvbn as zxcvbn_score
except ImportError:  # Paket eksikse uygulama açılır; kurulumda zxcvbn kullanılır.
    zxcvbn_score = None

# ─── UYGULAMA KURULUMU ────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

APP_TOKEN = os.environ.setdefault('APP_TOKEN', uuid.uuid4().hex)
FLASK_SECRET_KEY = os.environ.setdefault('FLASK_SECRET_KEY', uuid.uuid4().hex)
APP_VERSION = os.environ.get("APP_VERSION", "2.5.5")
UPDATE_REPOSITORY = "salvetum/SifreKasam"
UPDATE_RELEASE_API = f"https://api.github.com/repos/{UPDATE_REPOSITORY}/releases/latest"
SECRET_PLACEHOLDER = '__SECRET__'
MAX_BULK_IDS = 500
MAX_IMPORT_RECORDS = 5000
VALID_RECORD_TYPES = {'Website', 'Application', 'CreditCard', 'SecureNote', 'Other'}
DEFAULT_CATEGORY = 'Genel'
DEFAULT_ACCENT_COLOR = '#7c6ff7'
DEFAULT_BACKGROUND_STYLE = 'aurora'
VALID_BACKGROUND_STYLES = {'aurora', 'midnight', 'mesh', 'plain'}
DEFAULT_GLASS_QUALITY = 'normal'
VALID_GLASS_QUALITIES = {'low', 'normal', 'high'}
DEFAULT_ANIMATED_BACKGROUNDS_ENABLED = True
DEFAULT_INTERFACE_ANIMATIONS_ENABLED = True
DEFAULT_GRADIENTS_ENABLED = True

def _normalize_version(value: str | None) -> str:
    return str(value or '').strip().lstrip('vV')

def _version_parts(value: str | None) -> tuple[int, ...]:
    normalized = _normalize_version(value).split('-', 1)[0]
    numbers = [int(part) for part in re.findall(r'\d+', normalized)]
    return tuple((numbers + [0, 0, 0])[:3])

def _is_newer_version(latest: str | None, current: str | None) -> bool:
    latest_parts = _version_parts(latest)
    current_parts = _version_parts(current)
    return bool(latest_parts) and latest_parts > current_parts

def _fetch_latest_release() -> dict[str, Any]:
    req = Request(
        UPDATE_RELEASE_API,
        headers={
            'Accept': 'application/vnd.github+json',
            'User-Agent': f'SifreKasam/{APP_VERSION}',
        },
    )
    with urlopen(req, timeout=5) as response:
        payload = response.read().decode('utf-8')
    data = json.loads(payload)
    latest_version = _normalize_version(data.get('tag_name') or data.get('name'))
    return {
        'latest_version': latest_version,
        'release_name': data.get('name') or f"v{latest_version}",
        'release_url': data.get('html_url') or f"https://github.com/{UPDATE_REPOSITORY}/releases",
        'published_at': data.get('published_at'),
    }

app.secret_key = FLASK_SECRET_KEY
app.permanent_session_lifetime = timedelta(minutes=60)
app.config.update(
    MAX_CONTENT_LENGTH=5 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=True,
)

# ─── VERİ YOLU AYARLARI ───────────────────────────────────────────────────────

def _ensure_private_data_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError as exc:
        log.warning("Veri dizini izinleri sıkılaştırılamadı: %s", exc)
    return path

def get_data_dir() -> str:
    if os.name == 'nt':
        appdata = os.environ.get('APPDATA')
        if appdata:
            return _ensure_private_data_dir(os.path.join(appdata, '.SifrekasamV2'))
    xdg = os.environ.get('XDG_CONFIG_HOME') or os.path.join(os.path.expanduser('~'), '.config')
    return _ensure_private_data_dir(os.path.join(xdg, 'sifrekasam'))

DATA_DIR  = get_data_dir()
DB_FILE   = os.path.join(DATA_DIR, 'sifreler.db')
TXT_FILE  = os.path.join(DATA_DIR, 'sifreler.txt')
THEME_FILE = os.path.join(DATA_DIR, 'theme.json')
VAULT_INIT_FILE = os.path.join(DATA_DIR, 'vault.initialized')
CERT_FILE  = os.path.join(DATA_DIR, 'cert.pem')
KEY_FILE   = os.path.join(DATA_DIR, 'key.pem')

app.config['SQLALCHEMY_DATABASE_URI']        = f"sqlite:///{DB_FILE}"
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db            = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# ─── MODELLER ─────────────────────────────────────────────────────────────────

class Setting(db.Model):
    __tablename__ = 'settings'
    key   = db.Column(db.String, primary_key=True)
    value = db.Column(db.String)


class Record(db.Model):
    __tablename__ = 'records'
    id                 = db.Column(db.String,   primary_key=True)
    type               = db.Column(db.String,   nullable=False)
    category           = db.Column(db.String,   default='Genel')
    title              = db.Column(db.String,   nullable=False)
    website_url        = db.Column(db.String,   default='')
    login              = db.Column(db.String,   default='')
    encrypted_password = db.Column(db.String,   default='')
    encrypted_comment  = db.Column(db.String,   default='')
    is_pinned          = db.Column(db.Integer,  default=0)
    expiry_date        = db.Column(db.DateTime, nullable=True)
    created_at         = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at         = db.Column(db.DateTime, default=datetime.utcnow,
                                   onupdate=datetime.utcnow)


class PasswordHistory(db.Model):
    __tablename__ = 'password_history'
    id                 = db.Column(db.Integer, primary_key=True, autoincrement=True)
    record_id          = db.Column(db.String,  db.ForeignKey('records.id', ondelete='CASCADE'),
                                   nullable=False)
    encrypted_password = db.Column(db.String,  nullable=False)
    created_at         = db.Column(db.DateTime, default=datetime.utcnow)


class User(UserMixin):
    def __init__(self, id: str):
        self.id = id


@login_manager.user_loader
def load_user(user_id: str):
    return User("admin") if user_id == "admin" else None

# ─── VERİTABANI BAŞLATMA ──────────────────────────────────────────────────────

with app.app_context():
    db.create_all()
    try:
        db.session.execute(db.text("ALTER TABLE records ADD COLUMN expiry_date DATETIME"))
        db.session.commit()
    except Exception:
        db.session.rollback()
    if os.environ.get('KASA_RESET_LAN_ON_START') == '1':
        try:
            lan_setting = Setting.query.filter_by(key='lan_enabled').first()
            if lan_setting:
                lan_setting.value = 'false'
            else:
                db.session.add(Setting(key='lan_enabled', value='false'))
            db.session.commit()
        except Exception:
            db.session.rollback()

# ─── ÇEVİRİ / DİL SİSTEMİ ──────────────────────────────────────

_TRANSLATIONS_DIR = os.path.join(os.path.dirname(__file__), 'translations')
_translations_cache: dict[str, dict] = {}

def get_available_languages() -> list[dict]:
    langs = []
    if not os.path.isdir(_TRANSLATIONS_DIR):
        return [{'code': 'tr', 'name': 'Türkçe'}]
    for fname in sorted(os.listdir(_TRANSLATIONS_DIR)):
        if fname.endswith('.json'):
            code = fname[:-5]
            try:
                with open(os.path.join(_TRANSLATIONS_DIR, fname), 'r', encoding='utf-8') as f:
                    data = json.load(f)
                langs.append({'code': code, 'name': data.get('language_name', code)})
            except Exception:
                langs.append({'code': code, 'name': code})
    return langs if langs else [{'code': 'tr', 'name': 'Türkçe'}]

def load_translations(lang: str) -> dict:
    if not lang or not lang.replace('-', '').replace('_', '').isalnum():
        lang = 'tr'
    if lang in _translations_cache:
        return _translations_cache[lang]
    filepath = os.path.join(_TRANSLATIONS_DIR, f'{lang}.json')
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            _translations_cache[lang] = data
            return data
        except Exception:
            pass
    _translations_cache[lang] = {}
    return {}

def get_saved_language() -> str:
    try:
        v = _get_setting('language')
        if v:
            return v
    except Exception:
        pass
    return 'tr'

def save_language(value: str) -> str:
    requested = value.strip() if value else 'tr'
    allowed = {item['code'] for item in get_available_languages()}
    code = requested if requested in allowed else 'tr'
    _set_setting('language', code)
    _save_appearance_file(language=code)
    return code

def _(key: str) -> str:
    lang = get_saved_language()
    if lang == 'tr':
        return key
    t = load_translations(lang)
    return t.get(key, key)

# ─── HEARTBEAT ────────────────────────────────────────────────────────────────

HEARTBEAT_TIMEOUT_SECONDS = 120
_last_heartbeat = time.time()

def _check_heartbeat():
    while True:
        time.sleep(5)
        lan = None
        try:
            with app.app_context():
                lan = _get_setting('lan_enabled')
        except Exception:
            pass
        if lan == 'true':
            continue  # LAN açıkken heartbeat sunucuyu kapatmasın
        if time.time() - _last_heartbeat > HEARTBEAT_TIMEOUT_SECONDS:
            os._exit(0)

threading.Thread(target=_check_heartbeat, daemon=True).start()

_vault_keys: dict[str, str] = {}
_vault_keys_lock = threading.Lock()

def _set_vault_password(master_password: str):
    old_sid = session.pop('vault_session_id', None)
    session.pop('master_password', None)
    new_sid = uuid.uuid4().hex
    with _vault_keys_lock:
        if old_sid:
            _vault_keys.pop(old_sid, None)
        _vault_keys[new_sid] = master_password
    if old_sid:
        _remove_vault_report_cache(old_sid)
    session['vault_session_id'] = new_sid

def _clear_vault_password():
    sid = session.pop('vault_session_id', None)
    session.pop('master_password', None)
    if sid:
        with _vault_keys_lock:
            _vault_keys.pop(sid, None)
        _remove_vault_report_cache(sid)

def _get_vault_password() -> str | None:
    sid = session.get('vault_session_id')
    if sid:
        with _vault_keys_lock:
            return _vault_keys.get(sid)

    legacy_password = session.pop('master_password', None)
    if legacy_password:
        _set_vault_password(legacy_password)
        return legacy_password
    return None

# ─── KRİPTOGRAFİ ──────────────────────────────────────────────────────────────

LEGACY_PBKDF2_SALT = b'kasa_masaustu_salt_12345'
PBKDF2_SALT_SETTING = 'pbkdf2_salt_b64'
PBKDF2_ITERATIONS = 600_000
LEGACY_PBKDF2_ITERATIONS = 100_000
RECORD_METADATA_PREFIX = 'sifrekasam:v1:'
RECORD_METADATA_SETTING = 'record_metadata_encryption_v1'
RECORD_METADATA_FIELDS = ('title', 'website_url', 'login')

def _derive_key_with_salt(master_password: str, salt: bytes,
                          iterations: int = PBKDF2_ITERATIONS) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32,
                     salt=salt, iterations=iterations)
    return base64.urlsafe_b64encode(kdf.derive(master_password.encode()))

def _decode_salt(value: str | None) -> bytes | None:
    try:
        salt = base64.b64decode(value or '', validate=True)
        return salt if len(salt) >= 16 else None
    except Exception:
        return None

def _get_saved_pbkdf2_salt() -> bytes | None:
    return _decode_salt(_get_setting(PBKDF2_SALT_SETTING))

def _new_salt_b64() -> str:
    return base64.b64encode(os.urandom(16)).decode()

def _create_pbkdf2_salt() -> bytes:
    # Her kurulum için benzersiz salt üreterek offline brute-force maliyetini artırır.
    salt_b64 = _new_salt_b64()
    _set_setting(PBKDF2_SALT_SETTING, salt_b64)
    return base64.b64decode(salt_b64)

def derive_key(master_password: str) -> bytes:
    salt = _get_saved_pbkdf2_salt()
    if salt:
        return _derive_key_with_salt(master_password, salt)
    # Eski kasalar ilk başarılı girişte migrate edilene kadar legacy salt ile açılır.
    return _derive_key_with_salt(
        master_password,
        LEGACY_PBKDF2_SALT,
        LEGACY_PBKDF2_ITERATIONS,
    )

def get_fernet() -> Fernet:
    mp = _get_vault_password()
    if not mp:
        abort(401)
    return Fernet(derive_key(mp))

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

def _metadata_value_for_migration(fernet: Fernet, value: str) -> tuple[str, bool]:
    if not value or not value.startswith(RECORD_METADATA_PREFIX):
        return value or "", False
    try:
        return strict_decrypt_metadata(fernet, value), True
    except InvalidToken:
        return value, False

def _reencrypt_record(record: Record, old_fernet: Fernet, new_fernet: Fernet,
                      allow_legacy_prefix: bool = False) -> None:
    record.encrypted_password = safe_encrypt(
        new_fernet,
        strict_decrypt(old_fernet, record.encrypted_password),
    )
    record.encrypted_comment = safe_encrypt(
        new_fernet,
        strict_decrypt(old_fernet, record.encrypted_comment),
    )
    for field in RECORD_METADATA_FIELDS:
        encrypted_value = getattr(record, field) or ''
        if allow_legacy_prefix:
            plaintext, _ = _metadata_value_for_migration(old_fernet, encrypted_value)
        else:
            plaintext = strict_decrypt_metadata(old_fernet, encrypted_value)
        setattr(record, field, encrypt_metadata(new_fernet, plaintext))

def _is_legacy_master_hash(value: str) -> bool:
    return len(value or '') == 64 and all(c in '0123456789abcdef' for c in value.lower())

def hash_master_password(master_password: str) -> str:
    return generate_password_hash(master_password)

def verify_master_password(stored_hash: str, master_password: str) -> bool:
    if not stored_hash:
        return False
    if _is_legacy_master_hash(stored_hash):
        candidate = hashlib.sha256(master_password.encode()).hexdigest()
        return hmac.compare_digest(stored_hash, candidate)
    try:
        return check_password_hash(stored_hash, master_password)
    except Exception:
        return False

def _vault_initialized() -> bool:
    if os.path.exists(VAULT_INIT_FILE):
        return True
    try:
        return _get_setting('vault_initialized') == 'true'
    except Exception:
        return False

def _mark_vault_initialized():
    _set_setting('vault_initialized', 'true')
    payload = {
        'initialized': True,
        'created_at': datetime.utcnow().isoformat(timespec='seconds') + 'Z',
    }
    with open(VAULT_INIT_FILE, 'w', encoding='utf-8') as f:
        json.dump(payload, f)

def _has_existing_vault_data() -> bool:
    try:
        return bool(Record.query.first() or PasswordHistory.query.first())
    except Exception:
        return False

def _is_first_setup() -> bool:
    """Yalnızca daha önce kurulmamış, ana şifresiz kasaları ilk kurulum sayar."""
    try:
        master_setting = Setting.query.filter_by(key='master_hash').first()
        if master_setting and master_setting.value:
            return False
        return not _vault_initialized() and not _has_existing_vault_data()
    except Exception:
        # Durum belirlenemiyorsa yeniden şifre oluşturmayı teşvik etmemek için güvenli tarafta kal.
        return False

def migrate_legacy_pbkdf2_salt(master_password: str) -> bool:
    if _get_saved_pbkdf2_salt():
        return False

    # Sabit salt kullanan eski kasaları rastgele salt + yeni iterasyonla yeniden şifreler.
    new_salt = os.urandom(16)
    old_fernet = Fernet(_derive_key_with_salt(
        master_password,
        LEGACY_PBKDF2_SALT,
        LEGACY_PBKDF2_ITERATIONS,
    ))
    new_fernet = Fernet(_derive_key_with_salt(master_password, new_salt))
    rows = Record.query.all()
    hist_rows = PasswordHistory.query.all()

    try:
        backup_database()
        for row in rows:
            _reencrypt_record(row, old_fernet, new_fernet, allow_legacy_prefix=True)
        for history in hist_rows:
            history.encrypted_password = safe_encrypt(
                new_fernet,
                strict_decrypt(old_fernet, history.encrypted_password),
            )
        _set_setting(PBKDF2_SALT_SETTING, base64.b64encode(new_salt).decode())
        db.session.commit()
        _refresh_database_backup()
        log.info("Legacy PBKDF2 salt migrasyonu tamamlandı.")
        return True
    except Exception:
        db.session.rollback()
        log.exception("Legacy PBKDF2 salt migrasyonu geri alındı.")
        raise

# ─── YARDIMCI FONKSİYONLAR ────────────────────────────────────────────────────

def backup_database() -> None:
    """Var olan SQLite veritabanını güvenli bir yedek dosyasına kopyalar."""
    if not os.path.exists(DB_FILE):
        return
    try:
        shutil.copy2(DB_FILE, DB_FILE + ".backup")
    except Exception as e:
        log.warning(f"Yedekleme hatası: {e}")

def _refresh_database_backup() -> None:
    """Başarılı migrasyon sonrası düz metin içerebilen eski yedeği şifreli DB ile yeniler."""
    backup_path = DB_FILE + ".backup"
    try:
        overwrite_and_delete(backup_path)
    except OSError as exc:
        log.warning("Eski migrasyon yedeği güvenli biçimde temizlenemedi: %s", exc)
        return
    backup_database()

def migrate_plaintext_record_metadata(fernet: Fernet) -> bool:
    if _get_setting(RECORD_METADATA_SETTING) == 'true':
        return False

    rows = Record.query.all()
    try:
        backup_database()
        db.session.execute(db.text("PRAGMA secure_delete=ON"))
        for row in rows:
            for field in RECORD_METADATA_FIELDS:
                current_value = getattr(row, field) or ''
                plaintext, already_encrypted = _metadata_value_for_migration(
                    fernet,
                    current_value,
                )
                if not already_encrypted:
                    setattr(row, field, encrypt_metadata(fernet, plaintext))
        _set_setting(RECORD_METADATA_SETTING, 'true')
        db.session.commit()
        _refresh_database_backup()
        invalidate_vault_report_cache()
        log.info("Kayıt metadata şifreleme migrasyonu tamamlandı.")
        return True
    except Exception:
        db.session.rollback()
        log.exception("Kayıt metadata şifreleme migrasyonu geri alındı.")
        raise

def new_record_id() -> str:
    return uuid.uuid4().hex

def request_json() -> dict[str, Any]:
    """JSON body sözlük değilse güvenli biçimde boş dict döndürür."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}

def normalize_record_type(value: str | None) -> str:
    return value if value in VALID_RECORD_TYPES else 'Other'

def normalize_text(value: object | None, fallback: str = '', max_length: int | None = None) -> str:
    """Form/import verisini string'e çevirir, kırpar ve opsiyonel uzunluk sınırı uygular."""
    text = str(value if value not in (None, '') else fallback).strip()
    return text[:max_length] if max_length and len(text) > max_length else text

def normalize_url(value: object | None) -> str:
    """Sadece http/https URL kabul eder; şema yoksa https ekler."""
    url = normalize_text(value)
    if not url:
        return ''
    parsed = urlparse(url if '://' in url else f'https://{url}')
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        return ''
    return parsed.geturl()

def get_bulk_ids() -> list[str]:
    """Toplu işlem ID listesini normalize eder, tekrarları ve aşırı uzun listeleri engeller."""
    ids = request_json().get('ids', [])
    if not isinstance(ids, list):
        return []
    normalized = []
    seen: set[str] = set()
    for item in ids:
        record_id = normalize_text(item)
        if record_id and record_id not in seen:
            normalized.append(record_id)
            seen.add(record_id)
        if len(normalized) >= MAX_BULK_IDS:
            break
    return normalized

def _score_password(pw: str) -> int:
    """Return the backend password strength score in the same 0-4 range as zxcvbn.js."""
    if zxcvbn_score:
        try:
            return int(zxcvbn_score(pw or '').get('score', 0))
        except Exception:
            log.exception("zxcvbn score calculation failed")
    # Fallback keeps the app usable if the optional package is missing.
    return sum([
        len(pw) >= 12,
        any(c.isupper() for c in pw),
        any(c.isdigit() for c in pw),
        any(c in "!@#$%^&*()_+-=" for c in pw),
    ])

# ─── AYAR / TEMA YARDIMCILARI ─────────────────────────────────────────────────

def normalize_theme(value) -> str:
    return 'light' if value == 'light' else 'dark'

def normalize_glass_effects(value) -> bool:
    return str(value).lower() not in {'false', '0', 'off', 'disabled', 'kapali'}

def normalize_theme_option(value, default: bool = True) -> bool:
    if value is None:
        return default
    return str(value).lower() not in {'false', '0', 'off', 'disabled', 'kapali'}

def normalize_hex_color(value, fallback: str = DEFAULT_ACCENT_COLOR) -> str:
    text = str(value or '').strip()
    if not text.startswith('#'):
        text = f'#{text}'
    if len(text) == 7 and all(c in '0123456789abcdefABCDEF' for c in text[1:]):
        return text.lower()
    return fallback

def normalize_background_style(value) -> str:
    text = str(value or DEFAULT_BACKGROUND_STYLE).strip().lower()
    return text if text in VALID_BACKGROUND_STYLES else DEFAULT_BACKGROUND_STYLE

def normalize_glass_quality(value) -> str:
    text = str(value or DEFAULT_GLASS_QUALITY).strip().lower()
    return text if text in VALID_GLASS_QUALITIES else DEFAULT_GLASS_QUALITY

def safe_int(value: object | None, default: int, minimum: int | None = None,
             maximum: int | None = None) -> int:
    """Kullanıcı/env kaynaklı sayıları güvenli aralığa çevirir."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    if minimum is not None:
        number = max(minimum, number)
    if maximum is not None:
        number = min(maximum, number)
    return number

def _load_appearance_file() -> dict:
    try:
        if os.path.exists(THEME_FILE):
            with open(THEME_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return {}

def _save_appearance_file(**updates: Any) -> None:
    """Tema ayarlarını atomik JSON yazma ile kaydeder."""
    data = _load_appearance_file()
    data.update(updates)
    tmp_file = f"{THEME_FILE}.{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_file, THEME_FILE)
    finally:
        if os.path.exists(tmp_file):
            try:
                os.unlink(tmp_file)
            except OSError:
                pass

def _get_setting(key: str):
    """DB'den ayar okur; bulamazsa None döner."""
    s = Setting.query.filter_by(key=key).first()
    return s.value if s else None

def _set_setting(key: str, value: str):
    s = Setting.query.filter_by(key=key).first()
    if s:
        s.value = value
    else:
        db.session.add(Setting(key=key, value=value))

def get_saved_theme() -> str:
    try:
        v = _get_setting('theme')
        if v:
            return normalize_theme(v)
    except Exception:
        pass
    return normalize_theme(_load_appearance_file().get('theme', 'dark'))

def get_glass_effects_enabled() -> bool:
    try:
        v = _get_setting('glass_effects_enabled')
        if v is not None:
            return normalize_glass_effects(v)
    except Exception:
        pass
    data = _load_appearance_file()
    if 'glass_effects_enabled' in data:
        return normalize_glass_effects(data['glass_effects_enabled'])
    return True

def get_saved_accent_color() -> str:
    try:
        v = _get_setting('accent_color')
        if v:
            return normalize_hex_color(v)
    except Exception:
        pass
    return normalize_hex_color(_load_appearance_file().get('accent_color'))

def get_saved_background_style() -> str:
    try:
        v = _get_setting('background_style')
        if v:
            return normalize_background_style(v)
    except Exception:
        pass
    return normalize_background_style(_load_appearance_file().get('background_style'))

def get_glass_quality() -> str:
    try:
        v = _get_setting('glass_quality')
        if v:
            return normalize_glass_quality(v)
    except Exception:
        pass
    return normalize_glass_quality(_load_appearance_file().get('glass_quality'))

def get_animated_backgrounds_enabled() -> bool:
    try:
        v = _get_setting('animated_backgrounds_enabled')
        if v is not None:
            return normalize_theme_option(v, DEFAULT_ANIMATED_BACKGROUNDS_ENABLED)
    except Exception:
        pass
    data = _load_appearance_file()
    return normalize_theme_option(
        data.get('animated_backgrounds_enabled'),
        DEFAULT_ANIMATED_BACKGROUNDS_ENABLED,
    )

def get_interface_animations_enabled() -> bool:
    try:
        value = _get_setting('interface_animations_enabled')
        if value is not None:
            return normalize_theme_option(value, DEFAULT_INTERFACE_ANIMATIONS_ENABLED)
    except Exception:
        pass
    return normalize_theme_option(
        _load_appearance_file().get('interface_animations_enabled'),
        DEFAULT_INTERFACE_ANIMATIONS_ENABLED,
    )

def get_gradients_enabled() -> bool:
    try:
        v = _get_setting('gradients_enabled')
        if v is not None:
            return normalize_theme_option(v, DEFAULT_GRADIENTS_ENABLED)
    except Exception:
        pass
    return normalize_theme_option(
        _load_appearance_file().get('gradients_enabled'),
        DEFAULT_GRADIENTS_ENABLED,
    )

def save_glass_effects(value) -> bool:
    enabled = normalize_glass_effects(value)
    _set_setting('glass_effects_enabled', str(enabled).lower())
    _save_appearance_file(glass_effects_enabled=enabled)
    return enabled

def save_theme(value) -> str:
    theme = normalize_theme(value)
    _set_setting('theme', theme)
    _save_appearance_file(theme=theme)
    return theme

def save_accent_color(value) -> str:
    color = normalize_hex_color(value)
    _set_setting('accent_color', color)
    _save_appearance_file(accent_color=color)
    return color

def save_background_style(value) -> str:
    background = normalize_background_style(value)
    _set_setting('background_style', background)
    _save_appearance_file(background_style=background)
    return background

def save_glass_quality(value) -> str:
    quality = normalize_glass_quality(value)
    _set_setting('glass_quality', quality)
    _save_appearance_file(glass_quality=quality)
    return quality

def save_animated_backgrounds(value) -> bool:
    enabled = normalize_theme_option(value, DEFAULT_ANIMATED_BACKGROUNDS_ENABLED)
    _set_setting('animated_backgrounds_enabled', str(enabled).lower())
    _save_appearance_file(animated_backgrounds_enabled=enabled)
    return enabled

def save_interface_animations(value) -> bool:
    enabled = normalize_theme_option(value, DEFAULT_INTERFACE_ANIMATIONS_ENABLED)
    _set_setting('interface_animations_enabled', str(enabled).lower())
    _save_appearance_file(interface_animations_enabled=enabled)
    return enabled

def save_gradients(value) -> bool:
    enabled = normalize_theme_option(value, DEFAULT_GRADIENTS_ENABLED)
    _set_setting('gradients_enabled', str(enabled).lower())
    _save_appearance_file(gradients_enabled=enabled)
    return enabled

# ─── CONTEXT PROCESSORS ───────────────────────────────────────────────────────

@app.context_processor
def inject_globals():
    auto_lock_enabled  = True
    auto_lock_timeout  = 5
    theme              = 'dark'
    glass_effects      = True
    accent_color       = DEFAULT_ACCENT_COLOR
    background_style   = DEFAULT_BACKGROUND_STYLE
    glass_quality      = DEFAULT_GLASS_QUALITY
    animated_backgrounds = DEFAULT_ANIMATED_BACKGROUNDS_ENABLED
    interface_animations = DEFAULT_INTERFACE_ANIMATIONS_ENABLED
    gradients_enabled  = DEFAULT_GRADIENTS_ENABLED
    lan_enabled        = False
    try:
        v = _get_setting('auto_lock_enabled')
        if v is not None:
            auto_lock_enabled = v.lower() == 'true'
        t = _get_setting('auto_lock_timeout')
        if t is not None:
            auto_lock_timeout = int(t)
        theme         = get_saved_theme()
        glass_effects = get_glass_effects_enabled()
        accent_color  = get_saved_accent_color()
        background_style = get_saved_background_style()
        glass_quality = get_glass_quality()
        animated_backgrounds = get_animated_backgrounds_enabled()
        interface_animations = get_interface_animations_enabled()
        gradients_enabled = get_gradients_enabled()
        le           = _get_setting('lan_enabled')
        if le is not None:
            lan_enabled = le.lower() == 'true'
    except Exception:
        pass
    current_lang = get_saved_language()
    available_langs = get_available_languages()
    lang_translations = load_translations(current_lang)
    return {
        'APP_VERSION':           APP_VERSION,
        'AUTO_LOCK_ENABLED':     auto_lock_enabled,
        'AUTO_LOCK_TIMEOUT':     auto_lock_timeout,
        'SAVED_THEME':           theme,
        'GLASS_EFFECTS_ENABLED': glass_effects,
        'ACCENT_COLOR':          accent_color,
        'BACKGROUND_STYLE':      background_style,
        'GLASS_QUALITY':         glass_quality,
        'ANIMATED_BACKGROUNDS_ENABLED': animated_backgrounds,
        'INTERFACE_ANIMATIONS_ENABLED': interface_animations,
        'GRADIENTS_ENABLED':     gradients_enabled,
        'LAN_ENABLED':           lan_enabled,
        'CURRENT_LANG':          current_lang,
        'AVAILABLE_LANGS':       available_langs,
        'TRANSLATIONS':          lang_translations,
        'csp_nonce':             getattr(g, 'csp_nonce', ''),
        '_':                     _,
    }

# ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

_PUBLIC_ENDPOINTS = {'login', 'static', 'loading', 'manifest_json', 'sw',
                     'settings_language'}
_TOKEN_ENDPOINTS = {'heartbeat', 'shutdown', 'settings_tray', 'lan_info',
                    'settings_runtime'}

def _is_local_request() -> bool:
    remote = request.remote_addr or '127.0.0.1'
    try:
        return ipaddress.ip_address(remote).is_loopback
    except ValueError:
        return remote.startswith('127.') or remote == '::1'

def _lan_access_enabled() -> bool:
    try:
        return _get_setting('lan_enabled') == 'true'
    except Exception:
        return False

_login_attempts: dict[str, dict[str, float | int]] = {}
_login_attempts_lock = threading.Lock()
LOGIN_LOCK_THRESHOLD = 5
LOGIN_LOCK_BASE_SECONDS = 30
LOGIN_LOCK_MAX_SECONDS = 30 * 60

def _login_attempt_key() -> str:
    # LAN açıkken aynı ağdaki istemciler için IP bazlı brute-force limiti uygular.
    if _lan_access_enabled():
        return request.remote_addr or 'unknown'
    return 'local'

def _login_retry_after(key: str) -> int:
    with _login_attempts_lock:
        state = _login_attempts.get(key) or {}
        retry_after = int(max(0, float(state.get('locked_until', 0)) - time.time()))
        if retry_after <= 0 and state.get('locked_until'):
            state.pop('locked_until', None)
        return retry_after

def _login_backoff_seconds(failures: int) -> int:
    """Başarısız girişler sürdükçe bekleme süresini 30 dakikaya kadar katlar."""
    if failures < LOGIN_LOCK_THRESHOLD:
        return 0
    exponent = failures - LOGIN_LOCK_THRESHOLD
    return min(LOGIN_LOCK_BASE_SECONDS * (2 ** exponent), LOGIN_LOCK_MAX_SECONDS)

def _record_login_failure(key: str) -> int:
    with _login_attempts_lock:
        state = _login_attempts.setdefault(key, {'failures': 0, 'locked_until': 0.0})
        failures = int(state.get('failures', 0)) + 1
        state['failures'] = failures
        wait_seconds = _login_backoff_seconds(failures)
        if wait_seconds:
            state['locked_until'] = max(float(state.get('locked_until', 0)), time.time() + wait_seconds)
        return int(max(0, float(state.get('locked_until', 0)) - time.time()))

def _reset_login_failures(key: str) -> None:
    with _login_attempts_lock:
        _login_attempts.pop(key, None)

_LOGIN_LOCKED_TEMPLATE = "Çok fazla başarısız deneme, {seconds} saniye sonra tekrar deneyin."

def _too_many_attempts_message(seconds: int) -> str:
    # Dinamik sayaç metnini çeviri anahtarından formatlayarak login ekranında dil tutarlılığını korur.
    return _(_LOGIN_LOCKED_TEMPLATE).format(seconds=max(int(seconds), 0))

def overwrite_and_delete(path: str) -> None:
    # Eski düz metin yedeklerini migrasyon sonrası diskte bırakmamak için silmeden önce ezer.
    try:
        size = os.path.getsize(path)
    except FileNotFoundError:
        return
    with open(path, 'r+b') as f:
        if size > 0:
            f.write(os.urandom(size))
            f.flush()
            os.fsync(f.fileno())
    os.remove(path)

_vault_write_locked = threading.Event()
_VAULT_WRITE_LOCK_MESSAGE = "Ana \u015fifre de\u011fi\u015ftiriliyor, l\u00fctfen bekleyin."
_VAULT_WRITE_ENDPOINTS = {
    'ekle_sayfasi', 'duzenle_sayfasi', 'sil_kayit', 'pin_kayit',
    'import_data', 'bulk_delete', 'bulk_category', 'change_password',
}

_vault_report_cache: dict[str, dict[str, tuple[float, Any]]] = {}
_vault_report_cache_lock = threading.Lock()
_VAULT_REPORT_CACHE_TTL_SECONDS = 20

def _vault_write_lock_response():
    return jsonify({'error': _VAULT_WRITE_LOCK_MESSAGE}), 409

def _vault_report_cache_key() -> str | None:
    if not has_request_context():
        return None
    return session.get('vault_session_id')

def _remove_vault_report_cache(key: str | None) -> None:
    if not key:
        return
    with _vault_report_cache_lock:
        _vault_report_cache.pop(key, None)

def _get_vault_report_cache(kind: str):
    key = _vault_report_cache_key()
    if not key:
        return None
    with _vault_report_cache_lock:
        item = _vault_report_cache.get(key, {}).get(kind)
        if not item:
            return None
        created_at, data = item
        if time.time() - created_at > _VAULT_REPORT_CACHE_TTL_SECONDS:
            _vault_report_cache.get(key, {}).pop(kind, None)
            return None
        return data

def _set_vault_report_cache(kind: str, data: Any) -> None:
    key = _vault_report_cache_key()
    if not key:
        return
    with _vault_report_cache_lock:
        _vault_report_cache.setdefault(key, {})[kind] = (time.time(), data)

def invalidate_vault_report_cache() -> None:
    # Successful vault writes make stats/health cache stale.
    key = _vault_report_cache_key()
    if key:
        _remove_vault_report_cache(key)
    else:
        with _vault_report_cache_lock:
            _vault_report_cache.clear()

def _same_origin_state_change() -> bool:
    if request.method not in {'POST', 'PUT', 'PATCH', 'DELETE'}:
        return True
    origin = request.headers.get('Origin') or request.headers.get('Referer')
    if not origin:
        return True
    parsed = urlparse(origin)
    return parsed.netloc == request.host and parsed.scheme == request.scheme

@app.before_request
def check_token_and_auth():
    # Her yanıt için ayrı nonce kullanarak yalnızca onaylı inline blokları çalıştır.
    g.csp_nonce = secrets.token_urlsafe()
    token = request.headers.get('X-App-Token')
    endpoint = request.endpoint

    if not _same_origin_state_change():
        abort(403)

    # Re-encrypt sürerken eski anahtarla yeni veri yazılmasını engeller.
    if (request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}
            and endpoint in _VAULT_WRITE_ENDPOINTS
            and _vault_write_locked.is_set()):
        return _vault_write_lock_response()

    is_local = _is_local_request()
    lan_enabled = _lan_access_enabled()

    if token == APP_TOKEN:
        if endpoint in _PUBLIC_ENDPOINTS or endpoint in _TOKEN_ENDPOINTS:
            return
        if not current_user.is_authenticated:
            return redirect(url_for('login'))
        return

    if endpoint in _PUBLIC_ENDPOINTS:
        if endpoint in {'login', 'settings_language'} and not is_local and not lan_enabled:
            return render_template(
                'login.html',
                error="LAN erişimi kapalıyken uzaktan erişim engellendi."
            ), 403
        return

    if not is_local and lan_enabled:
        if not current_user.is_authenticated:
            return redirect(url_for('login'))
        return

    abort(403)

@app.after_request
def add_security_headers(response):
    csp_nonce = getattr(g, 'csp_nonce', '')
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'same-origin')
    response.headers.setdefault(
        'Content-Security-Policy',
        "default-src 'self' data: blob:; "
        f"script-src 'self' 'nonce-{csp_nonce}'; "
        f"style-src 'self' 'nonce-{csp_nonce}'; "
        "script-src-attr 'none'; style-src-attr 'none'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self'; "
        "worker-src 'self' blob:; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    )
    response.headers.setdefault(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()',
    )
    if request.endpoint != 'static':
        response.headers['Cache-Control'] = 'no-store, max-age=0'
        response.headers['Pragma'] = 'no-cache'
    return response

@app.errorhandler(500)
def internal_error(error):
    log.exception("Sunucu hatası", exc_info=error)
    return render_template('login.html', error="Beklenmeyen bir sunucu hatası oluştu."), 500

# ─── ROTALAR ──────────────────────────────────────────────────────────────────

@app.route('/manifest.json')
def manifest_json():
    return jsonify({
        'name': 'ŞifreKasam',
        'short_name': 'ŞifreKasam',
        'description': 'Güvenli, hızlı ve modern masaüstü şifre yöneticisi',
        'start_url': f'/',
        'scope': '/',
        'display': 'standalone',
        'background_color': '#080912',
        'theme_color': '#080912',
        'icons': [
            {
                'src': url_for('static', filename='icons/icon-192.svg'),
                'sizes': '192x192',
                'type': 'image/svg+xml',
            },
            {
                'src': url_for('static', filename='icons/icon-512.svg'),
                'sizes': '512x512',
                'type': 'image/svg+xml',
            },
        ],
    })

@app.route('/sw.js')
def sw():
    return Response(render_template('sw.js'), mimetype='application/javascript')

@app.route('/loading')
def loading_page():
    return render_template('loading.html')

@app.route('/heartbeat', methods=['POST'])
def heartbeat():
    if request.headers.get('X-App-Token') != APP_TOKEN:
        abort(403)
    global _last_heartbeat
    _last_heartbeat = time.time()
    return jsonify({"status": "ok"})

@app.route('/shutdown', methods=['POST'])
def shutdown():
    if request.headers.get('X-App-Token') != APP_TOKEN or not _is_local_request():
        abort(403)
    os._exit(0)

@app.route('/lock', methods=['POST'])
def lock():
    _clear_vault_password()
    session.clear()
    logout_user()
    return jsonify({"status": "locked"})

@app.route('/logout')
@login_required
def logout():
    _clear_vault_password()
    session.clear()
    logout_user()
    return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    first_setup = _is_first_setup()
    if request.method != 'POST':
        return render_template('login.html', first_setup=first_setup)

    attempt_key = _login_attempt_key()
    retry_after = _login_retry_after(attempt_key)
    if retry_after > 0:
        return render_template(
            'login.html', error=_too_many_attempts_message(retry_after),
            retry_after=retry_after, first_setup=first_setup,
        ), 429

    mp = request.form.get('master_password', '').strip()
    if not mp:
        return render_template('login.html', error="Ana şifre boş olamaz.", first_setup=first_setup)

    setting = Setting.query.filter_by(key='master_hash').first()

    if setting and setting.value:
        changed = False
        migration_committed = False
        if not verify_master_password(setting.value, mp):
            _clear_vault_password()
            session.clear()
            logout_user()
            retry_after = _record_login_failure(attempt_key)
            log.warning("Hatalı ana şifre denemesi.")
            if retry_after > 0:
                return render_template(
                    'login.html', error=_too_many_attempts_message(retry_after),
                    retry_after=retry_after, first_setup=first_setup,
                ), 429
            return render_template('login.html', error="Hatalı Ana Şifre!", first_setup=first_setup)
        if _is_legacy_master_hash(setting.value):
            setting.value = hash_master_password(mp)
            changed = True
        if not _vault_initialized():
            _mark_vault_initialized()
            changed = True
        try:
            if migrate_legacy_pbkdf2_salt(mp):
                migration_committed = True
            # Düz metin metadata, geçerli kasa anahtarıyla tek seferlik şifrelenir.
            current_fernet = Fernet(derive_key(mp))
            if migrate_plaintext_record_metadata(current_fernet):
                migration_committed = True
        except Exception:
            return render_template(
                'login.html',
                error="Kasa güvenlik migrasyonu başarısız oldu. Veri güvenliği için giriş durduruldu.",
                first_setup=first_setup,
            ), 500
        if changed and not migration_committed:
            db.session.commit()
    else:
        if _vault_initialized() or _has_existing_vault_data():
            log.error("Ana şifre kaydı bulunamadı; güvenlik nedeniyle yeniden kurulum engellendi.")
            return render_template(
                'login.html',
                error="Bu kasa zaten kurulmuş görünüyor. Güvenlik nedeniyle yeni ana şifre belirleme engellendi.",
                first_setup=False,
            ), 403
        log.info("İlk kurulum: Ana şifre belirleniyor...")
        Setting.query.filter_by(key='master_hash').delete()
        db.session.add(Setting(key='master_hash', value=hash_master_password(mp)))
        _create_pbkdf2_salt()
        # Yeni kasalarda metadata ilk kayıttan itibaren şifreli yazılır.
        _set_setting(RECORD_METADATA_SETTING, 'true')
        _mark_vault_initialized()
        db.session.commit()
        if os.path.exists(TXT_FILE):
            migrate_txt_to_db(mp)

    _reset_login_failures(attempt_key)
    session.permanent = True
    _set_vault_password(mp)
    login_user(User("admin"), remember=False)
    return redirect(url_for('index'))
@app.route('/')
@login_required
def index():
    fernet = get_fernet()
    rows   = Record.query.order_by(
        Record.is_pinned.desc(),
        Record.updated_at.desc(),
        Record.created_at.desc()
    ).all()

    kasa_verileri = []
    for r in rows:
        title = decrypt_metadata(fernet, r.title)
        website_url = decrypt_metadata(fernet, r.website_url)
        login_value = decrypt_metadata(fernet, r.login)
        dec_comm = safe_decrypt(fernet, r.encrypted_comment)

        if r.type == 'CreditCard':
            detaylar = {k: v for k, v in [
                ('Kart Numarası', login_value), ('CVV / Şifre', SECRET_PLACEHOLDER if r.encrypted_password else '')
            ] if v}
        elif r.type == 'SecureNote':
            detaylar = {'Not': dec_comm} if dec_comm else {}
        else:
            detaylar = {k: v for k, v in [
                ('Kategori',       r.category),
                ('Kullanıcı Adı',  login_value),
                ('Şifre',          SECRET_PLACEHOLDER if r.encrypted_password else ''),
                ('İnternet Adresi', website_url),
                ('Not',            dec_comm),
            ] if v}

        kasa_verileri.append({
            'id': r.id,
            'normalized': {'baslik': title, 'detaylar': detaylar},
            'full_data': {
                'id': r.id, 'type': r.type, 'category': r.category,
                'title': title, 'website_url': website_url,
                'login': login_value, 'is_pinned': r.is_pinned,
                'expiry_date': r.expiry_date.strftime('%Y-%m-%d') if r.expiry_date else '',
            },
        })

    return render_template('index.html', kayit_listesi=kasa_verileri)

def _parse_expiry(expiry_str: str | None) -> datetime | None:
    if not expiry_str:
        return None
    try:
        return datetime.strptime(expiry_str, '%Y-%m-%d')
    except ValueError:
        return None

def _record_from_form(fernet: Fernet, record_id: str | None = None) -> dict[str, Any]:
    """Form verilerini okuyup (id, Record alanları) döner."""
    record_type = normalize_record_type(request.form.get('kayit_tipi'))
    return dict(
        id                 = record_id or new_record_id(),
        type               = record_type,
        category           = normalize_text(request.form.get('kategori'), DEFAULT_CATEGORY, 120),
        title              = encrypt_metadata(
            fernet, normalize_text(request.form.get('isim'), _('Bilinmeyen'), 200)),
        website_url        = encrypt_metadata(
            fernet, normalize_url(request.form.get('website_url'))),
        login              = encrypt_metadata(
            fernet, normalize_text(request.form.get('login'), max_length=300)),
        encrypted_password = safe_encrypt(fernet, request.form.get('password', '')),
        encrypted_comment  = safe_encrypt(fernet, request.form.get('comment', '')),
        expiry_date        = _parse_expiry(request.form.get('expiry_date', '')),
    )

def _delete_records_and_history(record_ids: list[str]) -> int:
    """Kayıtlarla birlikte artık erişilemeyecek şifre geçmişini de siler."""
    if not record_ids:
        return 0
    PasswordHistory.query.filter(
        PasswordHistory.record_id.in_(record_ids)
    ).delete(synchronize_session=False)
    return Record.query.filter(
        Record.id.in_(record_ids)
    ).delete(synchronize_session=False)

@app.route('/ekle', methods=['GET', 'POST'])
@login_required
def ekle_sayfasi():
    if request.method == 'POST':
        fernet = get_fernet()
        fields = _record_from_form(fernet)
        backup_database()
        new_record = Record(**fields)
        db.session.add(new_record)
        if fields['encrypted_password']:
            db.session.add(PasswordHistory(
                record_id=fields['id'],
                encrypted_password=fields['encrypted_password'],
            ))
        db.session.commit()
        invalidate_vault_report_cache()
        return redirect(url_for('index'))
    return render_template('ekle.html', title="Yeni Kayıt Ekle", kayit=None)

@app.route('/duzenle/<kayit_id>', methods=['GET', 'POST'])
@login_required
def duzenle_sayfasi(kayit_id):
    fernet = get_fernet()
    r      = Record.query.get_or_404(kayit_id)

    if request.method == 'POST':
        old_password = safe_decrypt(fernet, r.encrypted_password)
        new_password = request.form.get('password', '')
        fields = _record_from_form(fernet, record_id=kayit_id)
        if r.encrypted_password and fields['encrypted_password'] and new_password != old_password:
            db.session.add(PasswordHistory(
                record_id=kayit_id,
                encrypted_password=r.encrypted_password,
            ))
        backup_database()
        for key, val in fields.items():
            if key != 'id':
                setattr(r, key, val)
        db.session.commit()
        invalidate_vault_report_cache()
        return redirect(url_for('index'))

    dec_pass = safe_decrypt(fernet, r.encrypted_password)
    dec_comm = safe_decrypt(fernet, r.encrypted_comment)
    title = decrypt_metadata(fernet, r.title)
    mapped_data = {
        'type': r.type, 'Category': r.category,
        'Website name':  title if r.type == 'Website'     else '',
        'Application':   title if r.type == 'Application' else '',
        'Account name':  title if r.type == 'Other'       else '',
        'CreditCard':    title if r.type == 'CreditCard'  else '',
        'SecureNote':    title if r.type == 'SecureNote'  else '',
        'Website URL': decrypt_metadata(fernet, r.website_url),
        'Login': decrypt_metadata(fernet, r.login),
        'Password': dec_pass, 'Comment': dec_comm,
        'expiry_date': r.expiry_date.strftime('%Y-%m-%d') if r.expiry_date else '',
    }
    return render_template('ekle.html', title="Kaydı Düzenle",
                           kayit={'id': kayit_id, 'full_data': mapped_data})

@app.route('/sil/<kayit_id>', methods=['POST'])
@login_required
def sil_kayit(kayit_id):
    backup_database()
    _delete_records_and_history([kayit_id])
    db.session.commit()
    invalidate_vault_report_cache()
    return redirect(url_for('index'))

@app.route('/pin/<kayit_id>', methods=['POST'])
@login_required
def pin_kayit(kayit_id):
    r = db.session.get(Record, kayit_id)
    if r:
        r.is_pinned = 0 if r.is_pinned else 1
        db.session.commit()
        invalidate_vault_report_cache()
    return redirect(url_for('index'))

@app.route('/gecmis/<kayit_id>')
@login_required
def get_gecmis(kayit_id):
    fernet = get_fernet()
    rows   = PasswordHistory.query.filter_by(record_id=kayit_id)\
                                  .order_by(PasswordHistory.created_at.desc()).all()
    return jsonify([{
        'password': safe_decrypt(fernet, r.encrypted_password),
        'date':     r.created_at.strftime('%Y-%m-%d %H:%M:%S') if r.created_at else '',
    } for r in rows])

@app.route('/api/record/<kayit_id>/password')
@login_required
def get_record_password(kayit_id):
    fernet = get_fernet()
    r = db.get_or_404(Record, kayit_id)
    return jsonify({'password': safe_decrypt(fernet, r.encrypted_password)})

def _build_vault_report_payloads() -> tuple[dict[str, int], dict[str, list]]:
    """Stats ve sağlık verisini tek decrypt/score geçişinde üretir."""
    fernet      = get_fernet()
    rows        = Record.query.with_entities(
        Record.id, Record.title, Record.encrypted_password,
        Record.updated_at, Record.is_pinned, Record.expiry_date
    ).all()

    simdi       = datetime.utcnow()
    alti_ay_once = simdi - timedelta(days=180)
    pinned = zayif = eski = expired = 0
    zayif_records: list[dict[str, str]] = []
    eski_records: list[dict[str, Any]] = []
    expired_records: list[dict[str, str]] = []
    pw_map: dict[str, list[dict[str, str]]] = {}

    for r in rows:
        if r.is_pinned:
            pinned += 1
        pw = safe_decrypt(fernet, r.encrypted_password)
        if not pw:
            continue

        rec = {'id': r.id, 'title': decrypt_metadata(fernet, r.title)}
        if _score_password(pw) < 4:
            zayif += 1
            zayif_records.append(rec)
        pw_map.setdefault(pw, []).append(rec)
        if r.updated_at and r.updated_at < alti_ay_once:
            eski += 1
            eski_records.append({**rec, 'days': (simdi - r.updated_at).days})
        if r.expiry_date and r.expiry_date < simdi:
            expired += 1
            expired_records.append(rec)

    stats = {'toplam': len(rows), 'pinned': pinned,
             'zayif': zayif, 'eski': eski, 'expired': expired}
    health = {
        'zayif': zayif_records,
        'tekrar': [group for group in pw_map.values() if len(group) > 1],
        'eski': eski_records,
        'expired': expired_records,
    }
    return stats, health

@app.route('/api/stats')
@login_required
def api_stats():
    cached = _get_vault_report_cache('stats')
    if cached is not None:
        return jsonify(cached)

    stats, health = _build_vault_report_payloads()
    _set_vault_report_cache('stats', stats)
    _set_vault_report_cache('saglik', health)
    return jsonify(stats)

@app.route('/saglik')
@login_required
def saglik_raporu():
    cached = _get_vault_report_cache('saglik')
    if cached is not None:
        return render_template('saglik.html', **cached)

    stats, health = _build_vault_report_payloads()
    _set_vault_report_cache('stats', stats)
    _set_vault_report_cache('saglik', health)
    return render_template('saglik.html', **health)

@app.route('/save_settings', methods=['POST'])
@login_required
def save_settings():
    auto_lock_timeout = safe_int(request.form.get('auto_lock_timeout'), 5, 1, 240)
    _set_setting('auto_lock_enabled',
                 'true' if request.form.get('auto_lock_enabled') else 'false')
    _set_setting('auto_lock_timeout', str(auto_lock_timeout))
    save_glass_effects(
        'true' if request.form.get('glass_effects_enabled') else 'false')
    if 'accent_color' in request.form:
        save_accent_color(request.form.get('accent_color'))
    if 'background_style' in request.form:
        save_background_style(request.form.get('background_style'))
    if 'glass_quality' in request.form:
        save_glass_quality(request.form.get('glass_quality'))
    save_animated_backgrounds(
        'true' if request.form.get('animated_backgrounds_enabled') else 'false')
    save_interface_animations(
        'true' if request.form.get('interface_animations_enabled') else 'false')
    save_gradients(
        'true' if request.form.get('gradients_enabled') else 'false')
    _set_setting('lan_enabled',
                 'true' if request.form.get('lan_enabled') else 'false')
    db.session.commit()
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return jsonify({
            "status": "ok",
            "glass_effects_enabled": get_glass_effects_enabled(),
            "accent_color": get_saved_accent_color(),
            "background_style": get_saved_background_style(),
            "glass_quality": get_glass_quality(),
            "animated_backgrounds_enabled": get_animated_backgrounds_enabled(),
            "interface_animations_enabled": get_interface_animations_enabled(),
            "gradients_enabled": get_gradients_enabled(),
            "lan_enabled": _lan_access_enabled(),
        })
    return redirect(url_for('index'))

@app.route('/export')
@login_required
def export_data():
    fernet = get_fernet()
    rows   = Record.query.all()
    export_format = _requested_export_format()

    return _send_records_export(
        _serialize_records(rows, fernet),
        f"sifrekasam_yedek_{datetime.now().strftime('%Y%m%d')}",
        export_format,
    )

def _serialize_records(rows, fernet: Fernet) -> list[dict[str, Any]]:
    """Kayıtları dışa aktarılabilir plain JSON sözlüklerine dönüştürür."""
    return [{
        'type': r.type, 'category': r.category,
        'title': decrypt_metadata(fernet, r.title),
        'website_url': decrypt_metadata(fernet, r.website_url),
        'login': decrypt_metadata(fernet, r.login),
        'password': safe_decrypt(fernet, r.encrypted_password),
        'comment':  safe_decrypt(fernet, r.encrypted_comment),
        'expiry_date': r.expiry_date.strftime('%Y-%m-%d') if r.expiry_date else '',
    } for r in rows]

def _requested_export_format() -> str:
    export_format = normalize_text(request.args.get('format', 'json')).lower()
    return export_format if export_format in {'json', 'kasa', 'txt'} else 'json'

def _serialize_records_txt(data: list[dict[str, Any]]) -> bytes:
    fields = ('type', 'category', 'title', 'website_url', 'login',
              'password', 'comment', 'expiry_date')
    blocks = []
    for item in data:
        lines = [
            f"{field}: {json.dumps(str(item.get(field) or ''), ensure_ascii=False)}"
            for field in fields
        ]
        blocks.append('\n'.join(lines))
    return '\n---\n'.join(blocks).encode('utf-8')

def _send_records_export(data: list[dict[str, Any]], base_name: str,
                         export_format: str = 'json'):
    if export_format == 'txt':
        payload = _serialize_records_txt(data)
        mimetype = 'text/plain; charset=utf-8'
    else:
        payload = json.dumps(data, ensure_ascii=False, indent=4).encode('utf-8')
        mimetype = ('application/vnd.sifrekasam.backup+json'
                    if export_format == 'kasa' else 'application/json')

    return send_file(io.BytesIO(payload), mimetype=mimetype, as_attachment=True,
                     download_name=f'{base_name}.{export_format}')

def _parse_import_record(item: dict, fernet: Fernet) -> Record:
    """Desteklenen yedek sözlüğünü yeni Record modeline çevirir."""
    title = (item.get('title') or item.get('Website name') or item.get('Application')
             or item.get('Account name') or item.get('SecureNote') or 'Bilinmeyen')
    login_val = normalize_text(item.get('login') or item.get('Login') or
                               item.get('Login name') or item.get('CreditCard') or '', max_length=300)
    password  = normalize_text(item.get('password') or item.get('Password') or '')
    comment   = normalize_text(item.get('comment') or item.get('Comment') or item.get('SecureNote') or '',
                               max_length=5000)
    url       = normalize_url(item.get('website_url') or item.get('Website URL') or '')
    category  = item.get('category') or item.get('Category') or 'Genel'
    rec_type  = (item.get('type') or
                 ('Website'    if 'Website name' in item else
                  'Application' if 'Application' in item else
                  'CreditCard'  if 'CreditCard'  in item else
                  'SecureNote'  if 'SecureNote'  in item else 'Other'))
    return Record(
        id                 = new_record_id(),
        type               = normalize_record_type(rec_type),
        category           = normalize_text(category, DEFAULT_CATEGORY, 120),
        title              = encrypt_metadata(
            fernet, normalize_text(title, _('Bilinmeyen'), 200)),
        website_url        = encrypt_metadata(fernet, url),
        login              = encrypt_metadata(fernet, login_val),
        encrypted_password = safe_encrypt(fernet, password),
        encrypted_comment  = safe_encrypt(fernet, comment),
        expiry_date        = _parse_expiry(normalize_text(item.get('expiry_date') or item.get('Expiry Date'))),
    )

def _parse_import_payload(filename: str, content: str) -> list[dict[str, Any]]:
    """Yedek dosyasını uzantısına göre çözer ve geçerli kayıt sözlüklerini döndürür."""
    suffix = os.path.splitext(filename.lower())[1]
    if suffix in {'.json', '.kasa'}:
        data = json.loads(content)
    elif suffix == '.txt':
        data = parse_old_txt(content)
    else:
        raise ValueError('unsupported-import-format')

    if not isinstance(data, list):
        raise ValueError('invalid-import-payload')

    return [item for item in data[:MAX_IMPORT_RECORDS] if isinstance(item, dict)]

@app.route('/import', methods=['POST'])
@login_required
def import_data():
    if 'file' not in request.files:
        return redirect(url_for('index'))
    file = request.files['file']
    if not file.filename:
        return redirect(url_for('index'))

    fernet   = get_fernet()
    filename = file.filename.lower()
    try:
        content = file.read().decode('utf-8-sig')
        records = [_parse_import_record(item, fernet)
                   for item in _parse_import_payload(filename, content)]
        if not records:
            return "İçe aktarılacak geçerli kayıt bulunamadı.", 400
        backup_database()
        db.session.add_all(records)
        db.session.commit()
        invalidate_vault_report_cache()
        return redirect(url_for('index'))
    except UnicodeDecodeError:
        return "Dosya UTF-8 olarak okunamadı.", 400
    except ValueError as e:
        db.session.rollback()
        log.warning(f"Import validation error: {e}")
        return "Geçersiz veya desteklenmeyen yedek dosyası.", 400
    except Exception as e:
        db.session.rollback()
        log.error(f"Import Error: {e}")
        return "İçe aktarma sırasında hata oluştu.", 400

def parse_old_txt(content: str) -> list[dict[str, str]]:
    """Eski TXT yedek formatını kayıt sözlüklerine dönüştürür."""
    records: list[dict[str, str]] = []
    for block in content.split("---"):
        block = block.strip()
        if not block:
            continue
        data = {}
        for line in block.splitlines():
            if ':' in line:
                key, _, val = line.partition(':')
                value = val.strip()
                if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
                    try:
                        value = json.loads(value)
                    except json.JSONDecodeError:
                        pass
                data[key.strip()] = str(value)
        if data and any(k in data for k in (
                'title', 'Website name', 'Application', 'Account name',
                'CreditCard', 'SecureNote', 'Login')):
            records.append(data)
    return records

@app.route('/api/bulk/delete', methods=['POST'])
@login_required
def bulk_delete():
    ids = get_bulk_ids()
    if not ids:
        return jsonify({'status': 'error', 'message': 'ID listesi boş.'}), 400
    backup_database()
    deleted = _delete_records_and_history(ids)
    db.session.commit()
    invalidate_vault_report_cache()
    return jsonify({'status': 'ok', 'deleted': deleted})

@app.route('/api/bulk/category', methods=['POST'])
@login_required
def bulk_category():
    ids      = get_bulk_ids()
    category = normalize_text(request_json().get('category'), max_length=120)
    if not ids or not category:
        return jsonify({'status': 'error', 'message': 'ID ve kategori gerekli.'}), 400
    backup_database()
    updated = Record.query.filter(Record.id.in_(ids)).update(
        {'category': category}, synchronize_session=False)
    db.session.commit()
    invalidate_vault_report_cache()
    return jsonify({'status': 'ok', 'updated': updated})

@app.route('/api/bulk/export', methods=['POST'])
@login_required
def bulk_export():
    fernet = get_fernet()
    ids    = get_bulk_ids()
    if not ids:
        return jsonify({'status': 'error', 'message': 'ID listesi boş.'}), 400

    rows = Record.query.filter(Record.id.in_(ids)).all()
    return _send_records_export(
        _serialize_records(rows, fernet),
        f"toplu_export_{datetime.now().strftime('%Y%m%d')}",
        _requested_export_format(),
    )

@app.route('/settings/tray', methods=['GET', 'POST'])
def settings_tray():
    if request.method == 'POST':
        val = request_json().get('minimize_to_tray')
        _set_setting('minimize_to_tray', str(val).lower())
        db.session.commit()
        return jsonify({"status": "ok"})
    s        = Setting.query.filter_by(key='minimize_to_tray').first()
    minimize = bool(s and s.value == 'true')
    return jsonify({"minimize_to_tray": minimize})

@app.route('/settings/runtime')
def settings_runtime():
    return jsonify({
        'lan_enabled': _lan_access_enabled(),
        'runtime_lan_enabled': os.environ.get('FLASK_HOST') == '0.0.0.0',
    })

@app.route('/api/update-check')
@login_required
def update_check():
    try:
        latest = _fetch_latest_release()
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        log.warning("Güncelleme kontrolü başarısız: %s", exc)
        return jsonify({
            'status': 'error',
            'message': 'Güncelleme bilgisi alınamadı.',
            'current_version': _normalize_version(APP_VERSION),
        }), 502

    latest_version = latest['latest_version']
    current_version = _normalize_version(APP_VERSION)
    return jsonify({
        'status': 'ok',
        'current_version': current_version,
        'has_update': _is_newer_version(latest_version, current_version),
        **latest,
    })

@app.route('/api/lan-info')
def lan_info():
    ips = []
    # Gerçek ağ arayüzünü bul: 8.8.8.8'e bağlanmayı dene
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1)
            sock.connect(('8.8.8.8', 53))
            ips.append(sock.getsockname()[0])
    except Exception:
        pass
    # Fallback: tüm non-127 IP'leri topla
    if not ips:
        hostname = socket.gethostname()
        try:
            for info in socket.getaddrinfo(hostname, None, family=socket.AF_INET):
                addr = info[4][0]
                if not addr.startswith('127.'):
                    ips.append(addr)
        except Exception:
            pass
    return jsonify({
        'hostname': socket.gethostname(),
        'ips': sorted(set(ips)),
        'port': safe_int(os.environ.get('FLASK_PORT') or os.environ.get('PORT'), 5000, 1, 65535),
        'ssl': os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE),
    })

@app.route('/settings/theme', methods=['GET', 'POST'])
@login_required
def settings_theme():
    if request.method == 'POST':
        theme = save_theme(request_json().get('theme'))
        db.session.commit()
        return jsonify({"status": "ok", "theme": theme})
    return jsonify({"theme": get_saved_theme()})

@app.route('/settings/language', methods=['GET', 'POST'])
def settings_language():
    if request.method == 'POST':
        lang = request_json().get('language', 'tr')
        lang = save_language(lang)
        db.session.commit()
        return jsonify({"status": "ok", "language": lang})
    return jsonify({
        "current": get_saved_language(),
        "available": get_available_languages(),
    })

@app.route('/settings/glass-effects', methods=['GET', 'POST'])
@login_required
def settings_glass_effects():
    if request.method == 'POST':
        enabled = save_glass_effects(request_json().get('enabled'))
        db.session.commit()
        return jsonify({"status": "ok", "enabled": enabled})
    return jsonify({"enabled": get_glass_effects_enabled()})

@app.route('/settings/appearance', methods=['GET', 'POST'])
@login_required
def settings_appearance():
    if request.method == 'POST':
        data = request_json()
        accent = save_accent_color(data.get('accent_color')) if 'accent_color' in data else get_saved_accent_color()
        background = save_background_style(data.get('background_style')) if 'background_style' in data else get_saved_background_style()
        glass_quality = save_glass_quality(data.get('glass_quality')) if 'glass_quality' in data else get_glass_quality()
        animated_backgrounds = (
            save_animated_backgrounds(data.get('animated_backgrounds_enabled'))
            if 'animated_backgrounds_enabled' in data
            else get_animated_backgrounds_enabled()
        )
        interface_animations = (
            save_interface_animations(data.get('interface_animations_enabled'))
            if 'interface_animations_enabled' in data
            else get_interface_animations_enabled()
        )
        gradients = (
            save_gradients(data.get('gradients_enabled'))
            if 'gradients_enabled' in data
            else get_gradients_enabled()
        )
        db.session.commit()
        return jsonify({
            "status": "ok",
            "accent_color": accent,
            "background_style": background,
            "glass_quality": glass_quality,
            "animated_backgrounds_enabled": animated_backgrounds,
            "interface_animations_enabled": interface_animations,
            "gradients_enabled": gradients,
        })
    return jsonify({
        "accent_color": get_saved_accent_color(),
        "background_style": get_saved_background_style(),
        "glass_quality": get_glass_quality(),
        "animated_backgrounds_enabled": get_animated_backgrounds_enabled(),
        "interface_animations_enabled": get_interface_animations_enabled(),
        "gradients_enabled": get_gradients_enabled(),
    })

# ─── ŞİFRE DEĞİŞTİRME ────────────────────────────────────────────────────────

_reencrypt_state: dict = {}
_reencrypt_lock = threading.Lock()
_REENCRYPT_ERROR_MESSAGE = "Kayıtlardan biri çözülemedi. Ana şifre değişikliği geri alındı."

def _prune_reencrypt_state(max_entries: int = 20) -> None:
    """Tamamlanmış/hataya düşmüş eski şifre değişimi işlerini bellekten temizler."""
    with _reencrypt_lock:
        if len(_reencrypt_state) <= max_entries:
            return
        removable = [
            task_id for task_id, state in _reencrypt_state.items()
            if state.get('done') or state.get('error')
        ]
        for task_id in removable[:len(_reencrypt_state) - max_entries]:
            _reencrypt_state.pop(task_id, None)

def _reencrypt_task(task_id: str, old_pw: str, new_pw: str, vault_sid: str | None):
    _vault_write_locked.set()
    error_message = _REENCRYPT_ERROR_MESSAGE
    try:
        with app.app_context():
            error_message = _(_REENCRYPT_ERROR_MESSAGE)
            backup_database()
            old_fernet = Fernet(derive_key(old_pw))
            new_fernet = Fernet(derive_key(new_pw))
            new_hash   = hash_master_password(new_pw)

            rows      = Record.query.all()
            hist_rows = PasswordHistory.query.all()
            total     = len(rows) + len(hist_rows)
            done      = 0

            def _update_progress():
                with _reencrypt_lock:
                    _reencrypt_state[task_id] = {
                        # Commit tamamlanmadan frontend'e yüzde 100 bildirme.
                        'progress': min(99, int(done / total * 100)) if total else 99,
                        'total': total,
                        'done': False,
                    }

            _update_progress()

            for row in rows:
                # Çözme hatasında placeholder yazmak yerine tüm işlemi geri al.
                _reencrypt_record(row, old_fernet, new_fernet)
                done += 1
                _update_progress()

            for h in hist_rows:
                h.encrypted_password = safe_encrypt(new_fernet, strict_decrypt(old_fernet, h.encrypted_password))
                done += 1
                _update_progress()

            setting = Setting.query.filter_by(key='master_hash').first()
            if setting:
                setting.value = new_hash
            db.session.commit()
            invalidate_vault_report_cache()
            if vault_sid:
                with _vault_keys_lock:
                    # Kullanıcı işlem sırasında çıkış yaptıysa silinmiş anahtarı yeniden ekleme.
                    if _vault_keys.get(vault_sid) == old_pw:
                        _vault_keys[vault_sid] = new_pw
            log.info("Ana ?ifre ba?ar?yla de?i?tirildi.")
            with _reencrypt_lock:
                _reencrypt_state[task_id] = {'progress': 100, 'total': total, 'done': True}

    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
        log.exception("Password change error")
        with _reencrypt_lock:
            _reencrypt_state[task_id] = {
                'progress': -1,
                'done': False,
                'error': error_message,
            }
    finally:
        # Keep vault writes blocked until password rotation fully ends.
        _vault_write_locked.clear()

@app.route('/change-password', methods=['POST'])
@login_required
def change_password():
    old_pw = request.form.get('old_password', '')
    new_pw = request.form.get('new_password', '')
    if not old_pw or not new_pw:
        return jsonify({'error': _('Eksik bilgi.')}), 400

    # Lock writes before re-encrypt starts to close the race window.
    with _reencrypt_lock:
        if _vault_write_locked.is_set():
            return _vault_write_lock_response()
        _vault_write_locked.set()

    task_id = None
    try:
        setting = Setting.query.filter_by(key='master_hash').first()
        if not setting or not verify_master_password(setting.value, old_pw):
            _vault_write_locked.clear()
            return jsonify({'error': _('Mevcut şifre hatalı.')}), 403

        task_id = uuid.uuid4().hex
        vault_sid = session.get('vault_session_id')
        _prune_reencrypt_state()
        # Polling ilk istekte görevi yanlışlıkla tamamlanmış sanmasın.
        with _reencrypt_lock:
            _reencrypt_state[task_id] = {
                'progress': 0,
                'total': 0,
                'done': False,
            }
        threading.Thread(target=_reencrypt_task,
                         args=(task_id, old_pw, new_pw, vault_sid),
                         daemon=True).start()
        return jsonify({'task_id': task_id})
    except Exception:
        _vault_write_locked.clear()
        if task_id:
            with _reencrypt_lock:
                _reencrypt_state.pop(task_id, None)
        raise

@app.route('/change-password/progress/<task_id>')
@login_required
def change_password_progress(task_id):
    with _reencrypt_lock:
        state = _reencrypt_state.get(task_id)
    if state is None:
        return jsonify({'error': _('Şifre değiştirme görevi bulunamadı.')}), 404
    return jsonify(dict(state))

# ─── MİGRASYON ────────────────────────────────────────────────────────────────

def migrate_txt_to_db(mp: str):
    if not os.path.exists(TXT_FILE):
        return
    try:
        with open(TXT_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
        fernet = Fernet(derive_key(mp))
        for item in parse_old_txt(content):
            db.session.add(_parse_import_record(item, fernet))
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        log.error(f"Migration error: {e}")
        return
    try:
        overwrite_and_delete(TXT_FILE)
    except Exception as e:
        log.error(f"Plaintext migration cleanup error: {e}")

# ─── SSL SERTİFİKASI (self-signed) ─────────────────────────────────────────────

def _ensure_self_signed_cert():
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        return
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ŞifreKasam")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow())
        .not_valid_after(datetime.utcnow() + timedelta(days=365 * 10))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                x509.IPAddress(ipaddress.IPv6Address("::1")),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    with open(CERT_FILE, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(KEY_FILE, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    log.info("Self-signed SSL sertifikasi olusturuldu")

_ensure_self_signed_cert()

# ─── BAŞLATMA ─────────────────────────────────────────────────────────────────

def _get_server_host() -> str:
    configured_host = os.environ.get('FLASK_HOST')
    if configured_host:
        return configured_host
    with app.app_context():
        return '0.0.0.0' if _lan_access_enabled() else '127.0.0.1'

if __name__ == '__main__':
    flask_host = _get_server_host()
    flask_port = safe_int(os.environ.get('FLASK_PORT') or os.environ.get('PORT'), 5000, 1, 65535)
    ssl_ctx = (CERT_FILE, KEY_FILE) if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE) else None
    app.run(host=flask_host, port=flask_port, ssl_context=ssl_ctx)


