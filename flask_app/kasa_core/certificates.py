"""Self-signed localhost certificate generation."""

import base64
import ipaddress
import logging
import os
import re
import socket
from datetime import timedelta

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from kasa_core.time_utils import utc_now


log = logging.getLogger(__name__)


def detect_lan_ips() -> list[str]:
    """Ağ üzerinden erişilebilir IPv4 adreslerini döndürür (loopback hariç)."""
    ips: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1)
            sock.connect(('8.8.8.8', 53))
            ips.append(sock.getsockname()[0])
    except Exception:
        pass
    if not ips:
        hostname = socket.gethostname()
        try:
            for info in socket.getaddrinfo(hostname, None, family=socket.AF_INET):
                addr = info[4][0]
                if not addr.startswith('127.'):
                    ips.append(addr)
        except Exception:
            pass
    return sorted(set(ips))


def cert_missing_lan_ips(cert_file: str, extra_ips: list[str]) -> bool:
    try:
        with open(cert_file, 'rb') as f:
            cert = x509.load_pem_x509_certificate(f.read())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName)
        present = {str(ip) for ip in san.value.get_values_for_type(x509.IPAddress)}
        return bool(extra_ips) and not set(extra_ips).issubset(present)
    except Exception:
        return True


def migrate_legacy_ssl_files(
    data_dir: str,
    ssl_dir: str,
    cert_file: str,
    key_file: str,
    logger: logging.Logger | None = None,
) -> None:
    logger = logger or log
    old_cert = os.path.join(data_dir, 'cert.pem')
    old_key = os.path.join(data_dir, 'key.pem')
    os.makedirs(ssl_dir, exist_ok=True)
    for old, new in ((old_cert, cert_file), (old_key, key_file)):
        if os.path.exists(old) and not os.path.exists(new):
            os.replace(old, new)
            logger.info("SSL dosyasi %s -> %s tasindi", old, new)


def normalize_pem_file(cert_file: str, logger: logging.Logger | None = None) -> None:
    """Normalize double-encoded PEM files (some installers produced a PEM that
    base64-encodes a PEM block, which breaks Python's SSL PEM parser).
    If detected, fix in-place."""
    logger = logger or log
    try:
        if os.path.exists(cert_file):
            with open(cert_file, 'rb') as f:
                data = f.read()
            # If cert file contains a base64 blob which decodes to a PEM, replace it.
            m = re.search(b'-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----', data, re.S)
            if m:
                inner = m.group(1).strip()
                try:
                    dec = base64.b64decode(inner)
                    if b'-----BEGIN CERTIFICATE-----' in dec:
                        with open(cert_file, 'wb') as f:
                            f.write(dec)
                        logger.info('Double-encoded PEM detected and normalized for %s', cert_file)
                except Exception:
                    pass
    except Exception:
        logger.debug('PEM normalization failed', exc_info=True)


def ensure_self_signed_cert(
    cert_file: str,
    key_file: str,
    logger: logging.Logger,
    extra_ips: list[str] | None = None,
    force: bool = False,
) -> None:
    if os.path.exists(cert_file) and os.path.exists(key_file) and not force:
        return
    os.makedirs(os.path.dirname(cert_file), exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "ŞifreKasam")]
    )
    valid_from = utc_now()
    san_entries: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv6Address("::1")),
    ]
    for raw_ip in extra_ips or []:
        try:
            san_entries.append(x509.IPAddress(ipaddress.ip_address(raw_ip)))
        except ValueError:
            logger.debug("Sertifika SAN'ina eklenemeyen IP: %s", raw_ip)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(valid_from)
        .not_valid_after(valid_from + timedelta(days=365 * 10))
        .add_extension(
            x509.SubjectAlternativeName(san_entries),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    with open(cert_file, "wb") as certificate_handle:
        certificate_handle.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_file, "wb") as key_handle:
        key_handle.write(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            )
        )
    _restrict_private_permissions(cert_file, key_file, logger)
    logger.info(
        "Self-signed SSL sertifikasi %s (SAN: %s)",
        "yenilendi" if force else "olusturuldu",
        ", ".join(
            entry.value if isinstance(entry, x509.DNSName) else str(entry.value)
            for entry in san_entries
        ),
    )


def _restrict_private_permissions(
    cert_file: str,
    key_file: str,
    logger: logging.Logger,
) -> None:
    """Özel anahtar dizinini ve dosyalarını yalnızca kullanıcıya görünür yapar."""
    try:
        os.chmod(os.path.dirname(cert_file), 0o700)
        os.chmod(cert_file, 0o600)
        os.chmod(key_file, 0o600)
    except OSError:
        # Windows'ta chmod sınırlıdır; en iyi çaba modu olarak sessizce geç.
        logger.debug("SSL dosya izinleri ayarlanamadi", exc_info=True)
