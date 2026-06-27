import json
import os
from pathlib import Path
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from app.config import CREDENTIALS_FILE

_ph = PasswordHasher()


def _load() -> dict:
    if not CREDENTIALS_FILE.exists():
        return {}
    return json.loads(CREDENTIALS_FILE.read_text())


def _save(data: dict) -> None:
    CREDENTIALS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_FILE.write_text(json.dumps(data))
    os.chmod(CREDENTIALS_FILE, 0o600)


def verify_password(username: str, password: str) -> bool:
    data = _load()
    if username not in data:
        return False
    try:
        _ph.verify(data[username], password)
    except (VerifyMismatchError, Exception):
        return False
    # Transparently upgrade the stored hash if argon2's parameters have moved on.
    if _ph.check_needs_rehash(data[username]):
        set_password(username, password)
    return True


def set_password(username: str, password: str) -> None:
    data = _load()
    data[username] = _ph.hash(password)
    _save(data)


def rename_user(old: str, new: str) -> None:
    data = _load()
    if old not in data:
        raise KeyError(old)
    data[new] = data.pop(old)
    _save(data)


def has_any_user() -> bool:
    return bool(_load())
