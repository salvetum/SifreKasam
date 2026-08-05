"""Self-signed localhost certificate generation."""

import ipaddress
import logging
import os
from datetime import timedelta

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from kasa_core.time_utils import utc_now


def ensure_self_signed_cert(
    cert_file: str,
    key_file: str,
    logger: logging.Logger,
) -> None:
    if os.path.exists(cert_file) and os.path.exists(key_file):
        return
    os.makedirs(os.path.dirname(cert_file), exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "ŞifreKasam")]
    )
    valid_from = utc_now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(valid_from)
        .not_valid_after(valid_from + timedelta(days=365 * 10))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                    x509.IPAddress(ipaddress.IPv6Address("::1")),
                ]
            ),
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
    logger.info("Self-signed SSL sertifikasi olusturuldu")


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
