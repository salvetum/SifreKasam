"""Özel arka plan dosya yönetimi: doğrulama, optimizasyon ve geçmiş."""

import hashlib
import json
import os
import re
import shutil
import threading
import time

from .constants import (
    CUSTOM_BACKGROUND_MAX_DIM,
    CUSTOM_BACKGROUND_MAX_DIMENSION,
    CUSTOM_BACKGROUND_MAX_GIF_BYTES,
    CUSTOM_BACKGROUND_MAX_IMAGE_BYTES,
    CUSTOM_BACKGROUND_MAX_PIXELS,
    CUSTOM_BACKGROUND_MAX_VIDEO_BYTES,
    CUSTOM_BACKGROUND_HISTORY_LIMIT,
    CUSTOM_BACKGROUND_UPLOAD_MAX_PER_WINDOW,
    CUSTOM_BACKGROUND_UPLOAD_WINDOW_SECONDS,
)
from .paths import get_backgrounds_dir

ALLOWED_BACKGROUND_MIMES = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/webm': '.webm',
    'video/mp4': '.mp4',
}

IMAGE_FORMAT_MIMES = {
    'PNG': 'image/png',
    'JPEG': 'image/jpeg',
    'WEBP': 'image/webp',
    'GIF': 'image/gif',
}

_EXT_TO_MIME = {ext: mime for mime, ext in ALLOWED_BACKGROUND_MIMES.items()}
_CUSTOM_BACKGROUND_NAME_RE = re.compile(r'^[0-9a-f]{32}\.(png|jpg|webp|gif|webm|mp4)$')
_BACKGROUND_METADATA_NAME = 'metadata.json'

VIDEO_EXTS = ('.webm', '.mp4')

background_state_lock = threading.Lock()

_upload_log: dict[str, list[float]] = {}
_upload_lock = threading.Lock()


def validate_custom_background(file_storage):
    """Validate uploaded file via header sniffing and size limits.

    Görüntüler Pillow ile doğrulanır (header-only, tam çözümleme yapılmaz);
    WebM/MP4 videoları magic-byte imzasıyla tanınır (``1A45DFA3`` = EBML,
    ``ftyp`` = MP4 kutusu). Boyut sınırı formata göre seçilir.
    """
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = CUSTOM_BACKGROUND_MAX_PIXELS

    try:
        file_storage.seek(0, 2)
        size = file_storage.tell()
        file_storage.seek(0)
        head = file_storage.stream.read(12) if hasattr(file_storage.stream, 'read') else b''
        file_storage.seek(0)
    except Exception:
        file_storage.seek(0)
        return None, 'Geçersiz dosya formatı.'

    ext = None
    if head[:4] == b'\x1a\x45\xdf\xa3':
        ext = '.webm'
    elif b'ftyp' in head[:12]:
        ext = '.mp4'

    if ext is None:
        try:
            img = Image.open(file_storage.stream)
            fmt = (img.format or '').upper()
            width, height = img.size
        except Exception:
            file_storage.seek(0)
            return None, 'Geçersiz dosya formatı.'
        finally:
            file_storage.seek(0)
        mime = IMAGE_FORMAT_MIMES.get(fmt)
        if not mime:
            return None, 'Desteklenmeyen dosya formatı. PNG, JPEG, WebP, GIF, WebM veya MP4 yükleyin.'
        if width * height > CUSTOM_BACKGROUND_MAX_PIXELS or max(width, height) > CUSTOM_BACKGROUND_MAX_DIMENSION:
            return None, 'Görsel çözünürlüğü çok yüksek. Maksimum 24MP ve maksimum kenar 8192px olabilir.'
        ext = ALLOWED_BACKGROUND_MIMES[mime]

    mime = _EXT_TO_MIME.get(ext, '')
    if mime == 'image/gif':
        max_bytes = CUSTOM_BACKGROUND_MAX_GIF_BYTES
    elif mime.startswith('video/'):
        max_bytes = CUSTOM_BACKGROUND_MAX_VIDEO_BYTES
    else:
        max_bytes = CUSTOM_BACKGROUND_MAX_IMAGE_BYTES
    if size > max_bytes:
        limit_mb = max_bytes // (1024 * 1024)
        return None, f'Dosya boyutu {limit_mb}MB sınırını aşıyor.'

    return ext, None


def optimize_custom_background(file_storage, filepath, ext):
    """Statik görüntüleri yeniden boyutlandırıp sıkıştırarak kaydeder.

    GIF ve videolar (WebM/MP4) animasyonu/akışı bozmamak için kaynak
    formatında olduğu gibi kopyalanır. Arkaplan ``cover`` olarak gösterildiği
    için görünüm değişmez; yalnızca yükleme/servis hızı artar. Optimizasyon
    başarısız olursa orijinal dosya kaydedilir (işlev bozulmaz).

    Dosya önce ``filepath + '.tmp'`` yoluna yazılır ve başarılı olursa
    ``os.replace`` ile atomik olarak hedefe taşınır; böylece yarı yazılmış
    bir dosya hedef yolda asla görünmez.
    """
    tmp_path = filepath + '.tmp'
    try:
        file_storage.seek(0)
        file_storage.save(tmp_path)
    except Exception:
        unlink_quiet(tmp_path)
        raise

    if ext in ('.gif', '.webm', '.mp4'):
        os.replace(tmp_path, filepath)
        return

    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = CUSTOM_BACKGROUND_MAX_PIXELS

    try:
        with Image.open(tmp_path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode not in ('RGB', 'RGBA'):
                has_alpha = 'A' in img.getbands() or (
                    img.mode == 'P' and 'transparency' in img.info)
                img = img.convert('RGBA' if has_alpha else 'RGB')
            if max(img.size) > CUSTOM_BACKGROUND_MAX_DIM:
                img.thumbnail((CUSTOM_BACKGROUND_MAX_DIM, CUSTOM_BACKGROUND_MAX_DIM), Image.LANCZOS)
            if ext == '.png':
                img.save(filepath, format='PNG', optimize=True)
            elif ext == '.webp':
                img.save(filepath, format='WEBP', quality=85, method=6)
            else:
                img.convert('RGB').save(filepath, format='JPEG', quality=85, optimize=True, progressive=True)
        unlink_quiet(tmp_path)
    except Exception:
        # Optimizasyon başarısız: orijinal dosyayı hedefe taşı (işlev bozulmaz).
        unlink_quiet(filepath)
        try:
            os.replace(tmp_path, filepath)
        except OSError:
            unlink_quiet(tmp_path)
            raise


def remove_old_custom_backgrounds():
    """Delete all files in the backgrounds directory (active root background)."""
    background_dir = get_backgrounds_dir()
    if not os.path.isdir(background_dir):
        return
    for name in os.listdir(background_dir):
        filepath = os.path.join(background_dir, name)
        if os.path.isfile(filepath):
            try:
                os.unlink(filepath)
            except OSError:
                pass


def find_custom_background():
    """Return the path of the current custom background file, or None.

    Yalnızca UUID biçimindeki arkaplan dosyaları dikkate alınır; yarım kalmış
    ``.tmp`` dosyaları veya başka artıklar asla arkaplan olarak servis edilmez.
    """
    background_dir = get_backgrounds_dir()
    if not os.path.isdir(background_dir):
        return None
    for name in os.listdir(background_dir):
        if not safe_background_filename(name):
            continue
        filepath = os.path.join(background_dir, name)
        if os.path.isfile(filepath):
            return filepath
    return None


def _custom_background_history_dir():
    history_dir = os.path.join(get_backgrounds_dir(), 'history')
    os.makedirs(history_dir, exist_ok=True)
    try:
        os.chmod(history_dir, 0o700)
    except OSError:
        pass
    return history_dir


def safe_background_filename(name):
    """Return the basename only if it is a known UUID-style background file."""
    base = os.path.basename(name or '')
    if base and _CUSTOM_BACKGROUND_NAME_RE.match(base):
        return base
    return None


def file_sha256(filepath):
    """Return the hex SHA-256 digest of a file, or None on read error."""
    digest = hashlib.sha256()
    try:
        with open(filepath, 'rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def unlink_quiet(filepath):
    """Best-effort file deletion (missing files are not an error)."""
    try:
        os.unlink(filepath)
    except OSError:
        pass


def find_background_by_hash(meta, digest):
    """Return the filename of an existing background with the same SHA-256 digest."""
    if not digest:
        return None
    for name, info in meta.items():
        if isinstance(info, dict) and info.get('sha256') == digest:
            if safe_background_filename(name):
                return name
    return None


def current_background_filename():
    """Return the filename of the active root background, or None."""
    path = find_custom_background()
    if not path:
        return None
    return os.path.basename(path)


def background_upload_allowed(client_key: str) -> bool:
    """Sliding-window rate limit for custom background uploads per client.

    LAN üzerinden kimliği doğrulanmış bir istemcinin tekrar tekrar 50MB'ye
    kadar dosya yazarak disk/hafıza DoS'u yapmasını sınırlar.
    """
    now = time.monotonic()
    with _upload_lock:
        stamps = _upload_log.setdefault(client_key, [])
        stamps[:] = [t for t in stamps if now - t < CUSTOM_BACKGROUND_UPLOAD_WINDOW_SECONDS]
        if len(stamps) >= CUSTOM_BACKGROUND_UPLOAD_MAX_PER_WINDOW:
            return False
        stamps.append(now)
        return True


def _custom_background_metadata_path():
    return os.path.join(_custom_background_history_dir(), _BACKGROUND_METADATA_NAME)


def _load_custom_background_metadata():
    """Load the {filename: {size,width,height,mime}} JSON index for history."""
    meta_path = _custom_background_metadata_path()
    try:
        with open(meta_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {}


def _save_custom_background_metadata(meta):
    """Atomically write the metadata index (temp file + os.replace)."""
    meta_path = _custom_background_metadata_path()
    tmp = meta_path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(meta, f)
        os.replace(tmp, meta_path)
    except OSError:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass


def _compute_background_metadata(filepath, ext):
    """Return {size, width, height, mime} for a saved background file."""
    info = {
        'size': 0,
        'width': None,
        'height': None,
        'mime': _EXT_TO_MIME.get((ext or '').lower(), ''),
    }
    try:
        info['size'] = os.path.getsize(filepath)
    except OSError:
        pass
    try:
        from PIL import Image
        with Image.open(filepath) as img:
            info['width'] = img.width
            info['height'] = img.height
            info['mime'] = IMAGE_FORMAT_MIMES.get((img.format or '').upper(), info['mime'])
    except Exception:
        pass
    return info


def _ensure_background_metadata(meta, filename, filepath):
    """Return metadata for a file, computing and caching it if missing."""
    entry = meta.get(filename)
    if entry is not None:
        return entry
    entry = _compute_background_metadata(filepath, os.path.splitext(filename)[1])
    meta[filename] = entry
    return entry


def list_custom_background_history():
    """Return history entries as [{filename, mtime, size, width, height, mime, sha256}]
    sorted newest-first. Metadata is computed lazily for legacy files and
    persisted back to the JSON index. Dosyası artık var olmayan (harici silme
    veya yarım kalmış işlem) meta kayıtları temizlenir."""
    history_dir = _custom_background_history_dir()
    meta = _load_custom_background_metadata()
    changed = False
    entries = []
    seen = set()
    try:
        for name in os.listdir(history_dir):
            filename = safe_background_filename(name)
            if not filename:
                continue
            filepath = os.path.join(history_dir, filename)
            try:
                mtime = os.path.getmtime(filepath)
            except OSError:
                continue
            seen.add(filename)
            existed = filename in meta
            info = _ensure_background_metadata(meta, filename, filepath)
            if not existed:
                changed = True
            entries.append({
                'filename': filename,
                'mtime': mtime,
                'size': info.get('size'),
                'width': info.get('width'),
                'height': info.get('height'),
                'mime': info.get('mime'),
                'sha256': info.get('sha256'),
            })
    except OSError:
        return []
    # Orphan meta kayıtlarını temizle: dosya ne history'de ne de kökte yoksa
    # kayıt geçersizdir (aktif kök dosyanın kaydı korunur).
    root_dir = get_backgrounds_dir()
    for name in list(meta.keys()):
        if not safe_background_filename(name):
            continue
        if name in seen:
            continue
        if os.path.isfile(os.path.join(root_dir, name)):
            continue  # aktif kök dosya
        meta.pop(name, None)
        changed = True
    entries.sort(key=lambda entry: entry['mtime'], reverse=True)
    if changed:
        _save_custom_background_metadata(meta)
    return entries


def prune_custom_background_history():
    """Delete the oldest history entries beyond the configured limit."""
    history_dir = _custom_background_history_dir()
    pruned = []
    for entry in list_custom_background_history()[CUSTOM_BACKGROUND_HISTORY_LIMIT:]:
        filepath = os.path.join(history_dir, entry['filename'])
        try:
            os.unlink(filepath)
            pruned.append(entry['filename'])
        except OSError:
            pass
    if pruned:
        meta = _load_custom_background_metadata()
        for name in pruned:
            meta.pop(name, None)
        _save_custom_background_metadata(meta)


def move_current_to_history(prune: bool = True):
    """Move the current root background into history (if any).

    ``prune=False`` verildiğinde budama yapılmaz; çağıran (ör. dedup/aktifleştirme
    akışı) hedef dosyayı köke taşıdıktan sonra budamayı kendisi yapar. Taşıma
    hatası sessizce yutulmaz: kökte iki dosya kalıp hangisinin "aktif" olduğu
    belirsizleşmesin diye hata yukarı fırlatılır.
    """
    background_dir = get_backgrounds_dir()
    if not os.path.isdir(background_dir):
        return
    history_dir = _custom_background_history_dir()
    for name in os.listdir(background_dir):
        filename = safe_background_filename(name)
        if not filename:
            continue
        source = os.path.join(background_dir, filename)
        if not os.path.isfile(source):
            continue
        shutil.move(source, os.path.join(history_dir, filename))
    if prune:
        prune_custom_background_history()


def clear_custom_background_history():
    """Delete all files (and the metadata index) in the history directory."""
    history_dir = os.path.join(get_backgrounds_dir(), 'history')
    if not os.path.isdir(history_dir):
        return
    for name in os.listdir(history_dir):
        filepath = os.path.join(history_dir, name)
        if os.path.isfile(filepath):
            try:
                os.unlink(filepath)
            except OSError:
                pass
    unlink_quiet(os.path.join(history_dir, _BACKGROUND_METADATA_NAME))
