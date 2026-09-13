"""Otomatik yedekler: uygulama-yönetimli backup anahtarı + rotasyon.

"Şimdi yedek al" ve periyodik rotasyon yedekleri, master-anhtar sarmalı bir
28-bayt rastgele anahtarla AES-256-GCM (encrypted_backup) kullanır. Manuel
.kasaenc indirmedeki tek-sunum parolanın aksine bu anahtar uygulama tarafından
yönetilir ve kasa anahtarıyla (Fernet) sarılarak Setting tablosunda saklanır
— böylece diske yazılan otomatik yedekler ana şifre olmadan da geri
yüklenebilir (kasa açıkken) ve ana şifre değişikliğinde yeniden sarmalanır.
"""

import base64
import logging
import os
import secrets
from datetime import datetime
from pathlib import Path

from cryptography.fernet import Fernet

from kasa_core.encrypted_backup import encrypt_payload
from kasa_core.models import Setting

log = logging.getLogger(__name__)

BACKUP_KEY_WRAP_SETTING = 'auto_backup_key_wrap'
LAST_AUTO_BACKUP_SETTING = 'last_auto_backup_at'
AUTO_BACKUP_INTERVAL_SETTING = 'auto_backup_interval'
AUTO_BACKUP_DEFAULT_INTERVAL = 'daily'

# Ayarlanabilir otomatik yedek aralıkları: value -> saniye.
AUTO_BACKUP_INTERVAL_SECONDS_MAP = {
    'hourly': 60 * 60,
    'daily': 24 * 3600,
    'weekly': 7 * 24 * 3600,
    'monthly': 30 * 24 * 3600,
}

AUTO_BACKUP_PREFIX = 'sifrekasam_otomatik_'
AUTO_BACKUP_MAX_COUNT = 8
BACKUP_DIR_NAME = 'backups'


def _get_setting(key: str) -> str | None:
    setting = Setting.query.filter_by(key=key).first()
    return setting.value if setting else None


def _set_setting(key: str, value: str) -> None:
    setting = Setting.query.filter_by(key=key).first()
    if setting:
        setting.value = value
    else:
        from kasa_core.extensions import db
        db.session.add(Setting(key=key, value=value))


def _backup_key_to_password(key_bytes: bytes) -> str:
    """Rastgele anahtarı encrypted_backup'un parola girdisine çevirir."""
    return base64.urlsafe_b64encode(key_bytes).decode('ascii')


def ensure_unwrapped_backup_key(fernet: Fernet) -> bytes:
    """Sarmal backup anahtarını açar; yoksa üretir, sarmalar ve kaydeder."""
    wrap = _get_setting(BACKUP_KEY_WRAP_SETTING)
    if wrap:
        try:
            return fernet.decrypt(wrap.encode())
        except Exception:
            log.warning('Yedek anahtari cozulemedi; yeniden uretiliyor.', exc_info=True)
    raw_key = secrets.token_bytes(32)
    _set_setting(BACKUP_KEY_WRAP_SETTING, fernet.encrypt(raw_key).decode())
    return raw_key


def backup_password(fernet: Fernet) -> str:
    """Sarmal backup anahtarını parola biçiminde döner (dosya açmak için)."""
    return _backup_key_to_password(ensure_unwrapped_backup_key(fernet))


def refresh_backup_key(old_fernet: Fernet, new_fernet: Fernet) -> None:
    """Ana şifre değişince backup anahtarını yeni kasa anahtarıyla yeniden sarar."""
    wrap = _get_setting(BACKUP_KEY_WRAP_SETTING)
    if not wrap:
        return
    try:
        raw_key = old_fernet.decrypt(wrap.encode())
        _set_setting(BACKUP_KEY_WRAP_SETTING, new_fernet.encrypt(raw_key).decode())
        from kasa_core.extensions import db
        db.session.commit()
    except Exception:
        from kasa_core.extensions import db
        db.session.rollback()
        log.exception('Otomatik yedek anahtari yeniden sarmalanamadi.')


def backups_dir(base_dir: str | os.PathLike) -> Path:
    path = Path(base_dir) / BACKUP_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def _is_managed(filename: str) -> bool:
    return filename.startswith(AUTO_BACKUP_PREFIX) and filename.endswith('.kasaenc')


def create_backup(records: list[dict], fernet: Fernet, base_dir: str | os.PathLike) -> dict:
    """Tüm kayıtları backup anahtarıyla şifreleyip disk'e yazar; rotasyon uygular.

    Dönüş: {filename, size, created_at}. Dosya adı saniye çakışmalarını
    önlemek için zaman + rastgele sonek içerir.
    """
    password = backup_password(fernet)
    blob = encrypt_payload(
        __import__('json').dumps(records, ensure_ascii=False).encode('utf-8'),
        password,
    )
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f'{AUTO_BACKUP_PREFIX}{stamp}_{secrets.token_hex(3)}.kasaenc'
    target = backups_dir(base_dir) / filename
    tmp = target.with_suffix('.tmp')
    tmp.write_bytes(blob)
    os.replace(tmp, target)
    rotate(base_dir)
    return {
        'filename': filename,
        'size': len(blob),
        'created_at': datetime.now().astimezone().isoformat(timespec='seconds'),
    }


def rotate(base_dir: str | os.PathLike) -> None:
    """Yalnızca en yeni AUTO_BACKUP_MAX_COUNT yönetimli yedeği tutar."""
    entries = sorted(
        list_backups(base_dir),
        key=lambda e: e['created_at'],
        reverse=True,
    )
    for old in entries[AUTO_BACKUP_MAX_COUNT:]:
        try:
            (backups_dir(base_dir) / old['filename']).unlink(missing_ok=True)
        except OSError:
            log.warning('Eski yedek silenemedi: %s', old['filename'])


def list_backups(base_dir: str | os.PathLike) -> list[dict]:
    """Yönetimli yedeklerin listesi; en yenisi başta."""
    folder = backups_dir(base_dir)
    entries: list[tuple[float, dict]] = []
    try:
        for entry in os.scandir(folder):
            if not (entry.is_file() and _is_managed(entry.name)):
                continue
            stat = entry.stat()
            entries.append((
                stat.st_mtime,
                {
                    'filename': entry.name,
                    'size': stat.st_size,
                    'created_at': datetime.fromtimestamp(
                        stat.st_mtime).astimezone().isoformat(timespec='seconds'),
                },
            ))
    except OSError:
        log.warning('Yedek dizini okunamadi.', exc_info=True)
    entries.sort(key=lambda item: item[0], reverse=True)
    return [meta for _, meta in entries]


def read_backup(base_dir: str | os.PathLike, filename: str) -> bytes:
    """Yönetimli bir yedeği okur; yol dışı geçişi (path traversal) reddeder."""
    if not _is_managed(filename):
        raise ValueError('invalid-backup-filename')
    folder = backups_dir(base_dir).resolve()
    target = (folder / filename).resolve()
    if not target.is_relative_to(folder):
        raise ValueError('invalid-backup-filename')
    if not target.is_file():
        raise FileNotFoundError(filename)
    return target.read_bytes()


def delete_backup(base_dir: str | os.PathLike, filename: str) -> bool:
    if not _is_managed(filename):
        raise ValueError('invalid-backup-filename')
    try:
        (backups_dir(base_dir) / filename).unlink(missing_ok=True)
        return True
    except OSError:
        log.warning('Yedek silinenemedi: %s', filename)
        return False