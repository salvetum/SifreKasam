# ─── IMPORTS ──────────────────────────────────────────────────────────────────
import base64
import hashlib
import hmac
import io
import json
import logging
import os
import shutil
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta
from functools import wraps
from typing import Any

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import serialization
from cryptography import x509
from cryptography.x509.oid import NameOID
import ipaddress
from urllib.parse import urlparse
from flask import (Flask, Response, abort, jsonify, redirect, render_template,
                   request, send_file, session, url_for)
from flask_login import (LoginManager, UserMixin, current_user, login_required,
                         login_user, logout_user)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

# ─── UYGULAMA KURULUMU ────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)

APP_TOKEN = os.environ.setdefault('APP_TOKEN', uuid.uuid4().hex)
FLASK_SECRET_KEY = os.environ.setdefault('FLASK_SECRET_KEY', uuid.uuid4().hex)
APP_VERSION = "2.3.1"
SECRET_PLACEHOLDER = '__SECRET__'
MAX_BULK_IDS = 500
MAX_IMPORT_RECORDS = 5000
VALID_RECORD_TYPES = {'Website', 'Application', 'CreditCard', 'SecureNote', 'Other'}
DEFAULT_CATEGORY = 'Genel'
DEFAULT_ACCENT_COLOR = '#7c6ff7'
DEFAULT_BACKGROUND_STYLE = 'aurora'
VALID_BACKGROUND_STYLES = {'aurora', 'midnight', 'mesh', 'plain'}
DEFAULT_ANIMATED_BACKGROUNDS_ENABLED = True
DEFAULT_GRADIENTS_ENABLED = True

app.secret_key = FLASK_SECRET_KEY
app.permanent_session_lifetime = timedelta(minutes=60)
app.config.update(
    MAX_CONTENT_LENGTH=5 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=True,
)

# ─── VERİ YOLU AYARLARI ───────────────────────────────────────────────────────

def get_data_dir() -> str:
    if os.name == 'nt':
        appdata = os.environ.get('APPDATA')
        if appdata:
            path = os.path.join(appdata, '.SifrekasamV2')
            os.makedirs(path, exist_ok=True)
            return path
    xdg = os.environ.get('XDG_CONFIG_HOME') or os.path.join(os.path.expanduser('~'), '.config')
    path = os.path.join(xdg, 'sifrekasam')
    os.makedirs(path, exist_ok=True)
    return path

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
    session['vault_session_id'] = new_sid

def _clear_vault_password():
    sid = session.pop('vault_session_id', None)
    session.pop('master_password', None)
    if sid:
        with _vault_keys_lock:
            _vault_keys.pop(sid, None)

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

_SALT = b'kasa_masaustu_salt_12345'

def derive_key(master_password: str) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32,
                     salt=_SALT, iterations=100_000)
    return base64.urlsafe_b64encode(kdf.derive(master_password.encode()))

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

# ─── YARDIMCI FONKSİYONLAR ────────────────────────────────────────────────────

def backup_database() -> None:
    """Var olan SQLite veritabanını güvenli bir yedek dosyasına kopyalar."""
    if not os.path.exists(DB_FILE):
        return
    try:
        shutil.copy2(DB_FILE, DB_FILE + ".backup")
    except Exception as e:
        log.warning(f"Yedekleme hatası: {e}")

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
    """Şifre güç puanını hesaplar (0–4)."""
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

def save_animated_backgrounds(value) -> bool:
    enabled = normalize_theme_option(value, DEFAULT_ANIMATED_BACKGROUNDS_ENABLED)
    _set_setting('animated_backgrounds_enabled', str(enabled).lower())
    _save_appearance_file(animated_backgrounds_enabled=enabled)
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
    animated_backgrounds = DEFAULT_ANIMATED_BACKGROUNDS_ENABLED
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
        animated_backgrounds = get_animated_backgrounds_enabled()
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
        'ANIMATED_BACKGROUNDS_ENABLED': animated_backgrounds,
        'GRADIENTS_ENABLED':     gradients_enabled,
        'LAN_ENABLED':           lan_enabled,
        'CURRENT_LANG':          current_lang,
        'AVAILABLE_LANGS':       available_langs,
        'TRANSLATIONS_JSON':     json.dumps(lang_translations, ensure_ascii=False),
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
    token = request.headers.get('X-App-Token')
    endpoint = request.endpoint

    if not _same_origin_state_change():
        abort(403)

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
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'same-origin')
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
    if request.method != 'POST':
        return render_template('login.html')

    mp = request.form.get('master_password', '').strip()
    if not mp:
        return render_template('login.html', error="Ana şifre boş olamaz.")

    setting = Setting.query.filter_by(key='master_hash').first()

    if setting and setting.value:
        changed = False
        if not verify_master_password(setting.value, mp):
            _clear_vault_password()
            session.clear()
            logout_user()
            log.warning("Hatalı ana şifre denemesi.")
            return render_template('login.html', error="Hatalı Ana Şifre!")
        if _is_legacy_master_hash(setting.value):
            setting.value = hash_master_password(mp)
            changed = True
        if not _vault_initialized():
            _mark_vault_initialized()
            changed = True
        if changed:
            db.session.commit()
    else:
        if _vault_initialized() or _has_existing_vault_data():
            log.error("Ana şifre kaydı bulunamadı; güvenlik nedeniyle yeniden kurulum engellendi.")
            return render_template(
                'login.html',
                error="Bu kasa zaten kurulmuş görünüyor. Güvenlik nedeniyle yeni ana şifre belirleme engellendi."
            ), 403
        log.info("İlk kurulum: Ana şifre belirleniyor...")
        Setting.query.filter_by(key='master_hash').delete()
        db.session.add(Setting(key='master_hash', value=hash_master_password(mp)))
        _mark_vault_initialized()
        db.session.commit()
        if os.path.exists(TXT_FILE):
            migrate_txt_to_db(mp)

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
        dec_comm = safe_decrypt(fernet, r.encrypted_comment)

        if r.type == 'CreditCard':
            detaylar = {k: v for k, v in [
                ('Kart Numarası', r.login), ('CVV / Şifre', SECRET_PLACEHOLDER if r.encrypted_password else '')
            ] if v}
        elif r.type == 'SecureNote':
            detaylar = {'Not': dec_comm} if dec_comm else {}
        else:
            detaylar = {k: v for k, v in [
                ('Kategori',       r.category),
                ('Kullanıcı Adı',  r.login),
                ('Şifre',          SECRET_PLACEHOLDER if r.encrypted_password else ''),
                ('İnternet Adresi', r.website_url),
                ('Not',            dec_comm),
            ] if v}

        kasa_verileri.append({
            'id': r.id,
            'normalized': {'baslik': r.title, 'detaylar': detaylar},
            'full_data': {
                'id': r.id, 'type': r.type, 'category': r.category,
                'title': r.title, 'website_url': r.website_url,
                'login': r.login, 'is_pinned': r.is_pinned,
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
        title              = normalize_text(request.form.get('isim'), _('Bilinmeyen'), 200),
        website_url        = normalize_url(request.form.get('website_url')),
        login              = normalize_text(request.form.get('login'), max_length=300),
        encrypted_password = safe_encrypt(fernet, request.form.get('password', '')),
        encrypted_comment  = safe_encrypt(fernet, request.form.get('comment', '')),
        expiry_date        = _parse_expiry(request.form.get('expiry_date', '')),
    )

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
        return redirect(url_for('index'))

    dec_pass = safe_decrypt(fernet, r.encrypted_password)
    dec_comm = safe_decrypt(fernet, r.encrypted_comment)
    mapped_data = {
        'type': r.type, 'Category': r.category,
        'Website name':  r.title if r.type == 'Website'     else '',
        'Application':   r.title if r.type == 'Application' else '',
        'Account name':  r.title if r.type == 'Other'       else '',
        'CreditCard':    r.title if r.type == 'CreditCard'  else '',
        'SecureNote':    r.title if r.type == 'SecureNote'  else '',
        'Website URL': r.website_url, 'Login': r.login,
        'Password': dec_pass, 'Comment': dec_comm,
        'expiry_date': r.expiry_date.strftime('%Y-%m-%d') if r.expiry_date else '',
    }
    return render_template('ekle.html', title="Kaydı Düzenle",
                           kayit={'id': kayit_id, 'full_data': mapped_data})

@app.route('/sil/<kayit_id>', methods=['POST'])
@login_required
def sil_kayit(kayit_id):
    backup_database()
    Record.query.filter_by(id=kayit_id).delete()
    db.session.commit()
    return redirect(url_for('index'))

@app.route('/pin/<kayit_id>', methods=['POST'])
@login_required
def pin_kayit(kayit_id):
    r = db.session.get(Record, kayit_id)
    if r:
        r.is_pinned = 0 if r.is_pinned else 1
        db.session.commit()
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

@app.route('/api/stats')
@login_required
def api_stats():
    fernet      = get_fernet()
    rows        = Record.query.with_entities(
        Record.id, Record.encrypted_password,
        Record.updated_at, Record.is_pinned, Record.expiry_date
    ).all()

    simdi       = datetime.utcnow()
    alti_ay_once = simdi - timedelta(days=180)
    pinned = zayif = eski = expired = 0

    for r in rows:
        if r.is_pinned:
            pinned += 1
        pw = safe_decrypt(fernet, r.encrypted_password)
        if pw:
            if _score_password(pw) < 4:
                zayif += 1
            if r.updated_at and r.updated_at < alti_ay_once:
                eski += 1
            if r.expiry_date and r.expiry_date < simdi:
                expired += 1

    return jsonify({'toplam': len(rows), 'pinned': pinned,
                    'zayif': zayif, 'eski': eski, 'expired': expired})

@app.route('/saglik')
@login_required
def saglik_raporu():
    fernet       = get_fernet()
    rows         = Record.query.with_entities(
        Record.id, Record.title, Record.encrypted_password,
        Record.updated_at, Record.expiry_date
    ).all()

    simdi        = datetime.utcnow()
    alti_ay_once = simdi - timedelta(days=180)
    zayif, eski, expired = [], [], []
    pw_map: dict[str, list] = {}

    for r in rows:
        pw = safe_decrypt(fernet, r.encrypted_password)
        if not pw:
            continue
        rec = {'id': r.id, 'title': r.title}
        if _score_password(pw) < 4:
            zayif.append(rec)
        pw_map.setdefault(pw, []).append(rec)
        if r.updated_at and r.updated_at < alti_ay_once:
            eski.append({**rec, 'days': (simdi - r.updated_at).days})
        if r.expiry_date and r.expiry_date < simdi:
            expired.append(rec)

    tekrar = [g for g in pw_map.values() if len(g) > 1]
    return render_template('saglik.html', zayif=zayif, tekrar=tekrar,
                            eski=eski, expired=expired)

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
    save_animated_backgrounds(
        'true' if request.form.get('animated_backgrounds_enabled') else 'false')
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
            "animated_backgrounds_enabled": get_animated_backgrounds_enabled(),
            "gradients_enabled": get_gradients_enabled(),
            "lan_enabled": _lan_access_enabled(),
        })
    return redirect(url_for('index'))

@app.route('/export')
@login_required
def export_data():
    fernet = get_fernet()
    rows   = Record.query.all()

    return _send_records_export(
        _serialize_records(rows, fernet),
        f"kasa_yedek_{datetime.now().strftime('%Y%m%d')}.json"
    )

def _serialize_records(rows, fernet: Fernet) -> list[dict[str, Any]]:
    """Kayıtları dışa aktarılabilir plain JSON sözlüklerine dönüştürür."""
    return [{
        'type': r.type, 'category': r.category, 'title': r.title,
        'website_url': r.website_url, 'login': r.login,
        'password': safe_decrypt(fernet, r.encrypted_password),
        'comment':  safe_decrypt(fernet, r.encrypted_comment),
    } for r in rows]

def _send_records_export(data: list[dict[str, Any]], download_name: str):
    payload = json.dumps(data, ensure_ascii=False, indent=4).encode('utf-8')
    return send_file(io.BytesIO(payload), mimetype='application/json', as_attachment=True,
                     download_name=download_name)

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
        title              = normalize_text(title, _('Bilinmeyen'), 200),
        website_url        = url, login=login_val,
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
                data[key.strip()] = val.strip()
        if data and any(k in data for k in ('Website name', 'Application', 'Login')):
            records.append(data)
    return records

@app.route('/api/bulk/delete', methods=['POST'])
@login_required
def bulk_delete():
    ids = get_bulk_ids()
    if not ids:
        return jsonify({'status': 'error', 'message': 'ID listesi boş.'}), 400
    backup_database()
    deleted = Record.query.filter(Record.id.in_(ids)).delete(synchronize_session=False)
    db.session.commit()
    return jsonify({'status': 'ok', 'deleted': deleted})

@app.route('/api/bulk/category', methods=['POST'])
@login_required
def bulk_category():
    ids      = get_bulk_ids()
    category = normalize_text(request_json().get('category'))
    if not ids or not category:
        return jsonify({'status': 'error', 'message': 'ID ve kategori gerekli.'}), 400
    backup_database()
    updated = Record.query.filter(Record.id.in_(ids)).update(
        {'category': category}, synchronize_session=False)
    db.session.commit()
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
        f"toplu_export_{datetime.now().strftime('%Y%m%d')}.json"
    )

@app.route('/settings/tray', methods=['GET', 'POST'])
def settings_tray():
    if request.method == 'POST':
        val = request_json().get('minimize_to_tray')
        _set_setting('minimize_to_tray', str(val).lower())
        db.session.commit()
        return jsonify({"status": "ok"})
    s        = Setting.query.filter_by(key='minimize_to_tray').first()
    minimize = not s or s.value == 'true'
    return jsonify({"minimize_to_tray": minimize})

@app.route('/settings/runtime')
def settings_runtime():
    return jsonify({
        'lan_enabled': _lan_access_enabled(),
        'runtime_lan_enabled': os.environ.get('FLASK_HOST') == '0.0.0.0',
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
        animated_backgrounds = (
            save_animated_backgrounds(data.get('animated_backgrounds_enabled'))
            if 'animated_backgrounds_enabled' in data
            else get_animated_backgrounds_enabled()
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
            "animated_backgrounds_enabled": animated_backgrounds,
            "gradients_enabled": gradients,
        })
    return jsonify({
        "accent_color": get_saved_accent_color(),
        "background_style": get_saved_background_style(),
        "animated_backgrounds_enabled": get_animated_backgrounds_enabled(),
        "gradients_enabled": get_gradients_enabled(),
    })

# ─── ŞİFRE DEĞİŞTİRME ────────────────────────────────────────────────────────

_reencrypt_state: dict = {}
_reencrypt_lock = threading.Lock()

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
    try:
        with app.app_context():
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
                        'progress': int(done / total * 100) if total else 100,
                        'total': total,
                    }

            _update_progress()

            for row in rows:
                row.encrypted_password = safe_encrypt(new_fernet, safe_decrypt(old_fernet, row.encrypted_password))
                row.encrypted_comment  = safe_encrypt(new_fernet, safe_decrypt(old_fernet, row.encrypted_comment))
                done += 1
                _update_progress()

            for h in hist_rows:
                h.encrypted_password = safe_encrypt(new_fernet, safe_decrypt(old_fernet, h.encrypted_password))
                done += 1
                _update_progress()

            setting = Setting.query.filter_by(key='master_hash').first()
            if setting:
                setting.value = new_hash
            db.session.commit()
            if vault_sid:
                with _vault_keys_lock:
                    _vault_keys[vault_sid] = new_pw
            log.info("Ana şifre başarıyla değiştirildi.")
            with _reencrypt_lock:
                _reencrypt_state[task_id] = {'progress': 100, 'total': total, 'done': True}

    except Exception as e:
        try:
            db.session.rollback()
        except Exception:
            pass
        log.error(f"Password change error: {e}")
        with _reencrypt_lock:
            _reencrypt_state[task_id] = {'progress': -1, 'error': str(e)}

@app.route('/change-password', methods=['POST'])
@login_required
def change_password():
    old_pw = request.form.get('old_password', '')
    new_pw = request.form.get('new_password', '')
    if not old_pw or not new_pw:
        return jsonify({'error': 'Eksik bilgi.'}), 400

    setting = Setting.query.filter_by(key='master_hash').first()
    if not setting or not verify_master_password(setting.value, old_pw):
        return jsonify({'error': 'Mevcut şifre hatalı.'}), 403

    task_id = uuid.uuid4().hex
    vault_sid = session.get('vault_session_id')
    _prune_reencrypt_state()
    threading.Thread(target=_reencrypt_task,
                     args=(task_id, old_pw, new_pw, vault_sid),
                     daemon=True).start()
    return jsonify({'task_id': task_id})

@app.route('/change-password/progress/<task_id>')
@login_required
def change_password_progress(task_id):
    with _reencrypt_lock:
        state = _reencrypt_state.get(task_id)
    return jsonify(state or {'progress': 100, 'done': True})

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
        os.rename(TXT_FILE, TXT_FILE + ".migrated")
    except Exception as e:
        db.session.rollback()
        log.error(f"Migration error: {e}")

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


