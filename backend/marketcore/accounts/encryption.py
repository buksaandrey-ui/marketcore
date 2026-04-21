import base64

from cryptography.fernet import Fernet

from marketcore.config import settings


def _get_fernet() -> Fernet:
    key = settings.encryption_key.encode("utf-8")
    # Fernet требует 32-байтный ключ в base64url формате
    padded = key.ljust(32)[:32]
    b64_key = base64.urlsafe_b64encode(padded)
    return Fernet(b64_key)


def encrypt_api_key(api_key: str) -> bytes:
    return _get_fernet().encrypt(api_key.encode("utf-8"))


def decrypt_api_key(cipher: bytes) -> str:
    return _get_fernet().decrypt(cipher).decode("utf-8")
