import secrets
import time
from app.config import SESSION_TTL_HOURS

# token -> (username, expires_at)
_sessions: dict[str, tuple[str, float]] = {}


def create_session(username: str) -> str:
    token = secrets.token_hex(32)
    _sessions[token] = (username, time.time() + SESSION_TTL_HOURS * 3600)
    return token


def validate_session(token: str) -> str | None:
    entry = _sessions.get(token)
    if not entry:
        return None
    username, expires = entry
    if time.time() > expires:
        del _sessions[token]
        return None
    return username


def delete_session(token: str) -> None:
    _sessions.pop(token, None)


def invalidate_user(username: str) -> None:
    for t in [t for t, (u, _) in _sessions.items() if u == username]:
        _sessions.pop(t, None)
