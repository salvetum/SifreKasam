"""LAN erişim şifresi: kasa anahtarı sarmalama ve ayar yaşam döngüsü.

LAN üzerinden girişte ana şifre ağa gönderilmez; uygulamanın ürettiği ayrı,
rastgele bir "LAN erişim şifresi" kullanılır. Kasa anahtarı bu şifreyle
sarılmış (wrap) halde veritabanında saklanır; böylece LAN istemcileri ana
şifreyi bilmeden kasayı açabilir. LAN şifresinin düz metni hiçbir zaman diskte
saklanmaz: kullanıcıya gösterim için yalnızca kasa anahtarıyla şifrelenmiş
kopyası (lan_access_secret) tutulur ve yerel oturumdayken çözülür.
"""

import base64
import logging
import secrets

from cryptography.fernet import Fernet

from kasa_core.crypto import (
    derive_key_with_salt,
    hash_master_password,
    new_salt_b64,
)
from kasa_core.extensions import db
from kasa_core.models import Setting
from kasa_core.settings_store import forget_setting as _forget_setting
from kasa_core.settings_store import get_setting as _get_setting
from kasa_core.settings_store import set_setting as _set_setting

log = logging.getLogger(__name__)

LAN_ACCESS_HASH_SETTING = 'lan_access_hash'
LAN_ACCESS_SECRET_SETTING = 'lan_access_secret'
LAN_VAULT_WRAP_SETTING = 'lan_vault_wrap'
# LAN oturumlarına tam yetki verilip verilmeyeceği. Varsayılan 'false' = LAN
# istemcileri kasayı yalnızca OKUYABİLİR; yazma/silme/dışa aktarma reddedilir.
LAN_FULL_ACCESS_SETTING = 'lan_full_access_enabled'
# LAN oturumlarında açık metin şifre gösterimi. Varsayılan KAPALI: ağdaki
# cihaz kayıt başlıklarını görür ama şifreyi göremez. Tam yetkiden bağımsız
# bir anahtardır (tam yetki = kayıt düzenleme, şifre gösterme değil).
LAN_REVEAL_PASSWORDS_SETTING = 'lan_reveal_passwords_enabled'

LAN_PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'  # 0/o/1/i/l karışıklığı önlenir
LAN_PASSWORD_LENGTH = 10


def generate_password() -> str:
    """Telefonda kolay yazılabilir, ~50 bit entropili rastgele LAN şifresi."""
    return ''.join(secrets.choice(LAN_PASSWORD_ALPHABET)
                   for _ in range(LAN_PASSWORD_LENGTH))


def _wrap_key(lan_password: str, salt: bytes) -> bytes:
    """LAN şifresinden türetilen kasa-anahtari sarma anahtarı."""
    return derive_key_with_salt(lan_password, salt)


def build_vault_wrap(lan_password: str, vault_key: bytes) -> str:
    """Kasa anahtarını LAN şifresiyle sarar; 'salt_b64:token' biçiminde döner."""
    salt_b64 = new_salt_b64()
    wrap_key = _wrap_key(lan_password, base64.b64decode(salt_b64))
    token = Fernet(wrap_key).encrypt(vault_key).decode()
    return f'{salt_b64}:{token}'


def unwrap_vault_key(lan_password: str, wrap: str | None) -> bytes | None:
    """LAN şifresiyle sarılmış kasa anahtarını açar."""
    if not wrap:
        return None
    try:
        salt_b64, _, token = wrap.partition(':')
        wrap_key = _wrap_key(lan_password, base64.b64decode(salt_b64))
        return Fernet(wrap_key).decrypt(token.encode())
    except Exception:
        log.warning('LAN kasa anahtari cozulemedi.', exc_info=True)
        return None


def encrypt_access_secret(vault_key: bytes, lan_password: str) -> str:
    """LAN şifresinin düz metnini kasa anahtarıyla şifreler."""
    return Fernet(vault_key).encrypt(lan_password.encode()).decode()


def decrypt_stored_password(vault_key: bytes | None) -> str | None:
    """Yerel oturum (kasa anahtarı bellekteyken) LAN şifresini çözer."""
    secret = _get_setting(LAN_ACCESS_SECRET_SETTING)
    if not secret or not vault_key:
        return None
    try:
        return Fernet(vault_key).decrypt(secret.encode()).decode()
    except Exception:
        log.warning('LAN erisim sifresi cozulemedi.', exc_info=True)
        return None


def ensure_setup(get_vault_key) -> tuple[str | None, bool]:
    """LAN şifresi + kasa anahtarı sarmalını eksikse oluşturur.

    Dönüş: (düz metin LAN şifresi, yeni üretildi mi). Kasa anahtarı bellekte
    değilse (yerel oturum yoksa) hiçbir şey yapmaz ve (None, False) döner.
    """
    vault_key = get_vault_key()
    if not vault_key:
        return None, False
    if _get_setting(LAN_ACCESS_HASH_SETTING):
        if not _get_setting(LAN_VAULT_WRAP_SETTING):
            lan_password = decrypt_stored_password(vault_key)
            if lan_password:
                _set_setting(LAN_VAULT_WRAP_SETTING,
                             build_vault_wrap(lan_password, vault_key))
        return decrypt_stored_password(vault_key), False
    lan_password = generate_password()
    _set_setting(LAN_ACCESS_HASH_SETTING, hash_master_password(lan_password))
    _set_setting(LAN_ACCESS_SECRET_SETTING, encrypt_access_secret(vault_key, lan_password))
    _set_setting(LAN_VAULT_WRAP_SETTING,
                 build_vault_wrap(lan_password, vault_key))
    return lan_password, True


def clear_settings() -> None:
    """LAN kapandığında şifre/sarmal kayıtlarını siler (sonraki açılışta yeni şifre)."""
    for key in (LAN_ACCESS_HASH_SETTING, LAN_ACCESS_SECRET_SETTING,
                LAN_VAULT_WRAP_SETTING):
        Setting.query.filter_by(key=key).delete()
        # Toplu delete() önbelleği bayat bırakır; aynı istekte yeniden üretim
        # kararı bu anahtarları okuduğu için önbellekten düşürülmeleri gerekir.
        _forget_setting(key)


def refresh_bindings(old_key: bytes, new_key: bytes) -> None:
    """Ana şifre değişince LAN şifresiyle kasa anahtarı bağlarını yeniler."""
    if not _get_setting(LAN_ACCESS_HASH_SETTING):
        return
    try:
        lan_password = decrypt_stored_password(old_key)
        if not lan_password:
            log.warning('LAN erisim sifresi ana sifre degisimi sirasinda cozulemedi.')
            return
        _set_setting(LAN_ACCESS_SECRET_SETTING, encrypt_access_secret(new_key, lan_password))
        _set_setting(LAN_VAULT_WRAP_SETTING,
                     build_vault_wrap(lan_password, new_key))
        db.session.commit()
    except Exception:
        db.session.rollback()
        log.exception('LAN erisim sarmallari yenilenemedi.')
