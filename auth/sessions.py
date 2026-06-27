import secrets
import time
from app.config import SESSION_TTL_HOURS

# token -> (username, expires_at)
_sessions: dict[str, tuple[str, float]] = {}


def create_session(username: str) -> str:
    now = time.time()
    # Drop expired tokens so the dict doesn't grow unbounded over the Pi's uptime.
    for t in [t for t, (_, exp) in _sessions.items() if exp <= now]:
        del _sessions[t]
    token = secrets.token_hex(32)
    _sessions[token] = (username, now + SESSION_TTL_HOURS * 3600)
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
