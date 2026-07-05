"""
Cross-device UI settings, encrypted at rest.

The browser keeps the live copy in localStorage (theme, accent, custom colors,
single-click, stat pills, boot-drive view). This stores one signed-in copy on
the Pi so a second device — phone, laptop — pulls the same look on login.

Single user, so one blob, no per-user keying. Encrypted at rest with Fernet
(AES-128-CBC + HMAC); the key lives beside the credentials file, mode 0600.

ponytail: one encrypted file, no DB. Module lock is enough — single process.
"""
import json
import os
import threading

from cryptography.fernet import Fernet, InvalidToken

from app.config import CREDENTIALS_FILE

_CONFIG_DIR = CREDENTIALS_FILE.parent
_KEY_FILE = _CONFIG_DIR / "settings.key"
_DATA_FILE = _CONFIG_DIR / "settings.enc"

_lock = threading.Lock()
# Dev fallback: if we can't write a key file (no /etc/litelayer on a dev box),
# keep a process-lifetime key so the feature still works in-session.
_mem_key: bytes | None = None


def _key() -> bytes:
    global _mem_key
    try:
        if _KEY_FILE.exists():
            return _KEY_FILE.read_bytes()
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        k = Fernet.generate_key()
        # 0600 before any bytes land so the key is never briefly world-readable.
        fd = os.open(_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(k)
        return k
    except OSError:
        if _mem_key is None:
            _mem_key = Fernet.generate_key()
        return _mem_key


def fernet() -> Fernet:
    """The app-wide at-rest cipher — shared by other stores (e.g. the Photo
    Inbox config, which holds an IMAP app-password)."""
    return Fernet(_key())


def load() -> dict:
    with _lock:
        try:
            token = _DATA_FILE.read_bytes()
            return json.loads(Fernet(_key()).decrypt(token))
        except (OSError, InvalidToken, ValueError):
            return {}


def save(settings: dict) -> None:
    with _lock:
        token = Fernet(_key()).encrypt(json.dumps(settings).encode())
        try:
            _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            _DATA_FILE.write_bytes(token)
        except OSError:
            pass  # dev box without the real config dir — just won't persist


if __name__ == "__main__":  # ponytail: round-trip self-check
    import tempfile, pathlib
    d = pathlib.Path(tempfile.mkdtemp())
    _CONFIG_DIR, _KEY_FILE, _DATA_FILE = d, d / "settings.key", d / "settings.enc"
    save({"ll-theme": "light", "ll-accent": "teal"})
    assert load()["ll-accent"] == "teal", "round-trip failed"
    assert _DATA_FILE.read_bytes()[:1] == b"g", "blob should be Fernet ciphertext"  # Fernet tokens start 'gAAAA'
    assert b"teal" not in _DATA_FILE.read_bytes(), "plaintext leaked into the file!"
    print("ok: encrypt/decrypt round-trips, plaintext not on disk")
