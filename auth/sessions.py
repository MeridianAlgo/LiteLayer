import secrets
import time
from app.config import SESSION_TTL_HOURS

# token -> {"user": str, "exp": float, "device": str|None, "created": float, "ip": str}
# A session is bound to the device (ll_device cookie) it was created on: a stolen
# session cookie is useless from a different device. Bearer-token API use carries no
# device cookie, so device checks are skipped there (the token is itself the secret).
_sessions: dict[str, dict] = {}


def _prune(now: float) -> None:
    for t in [t for t, s in _sessions.items() if s["exp"] <= now]:
        del _sessions[t]


def create_session(username: str, device: str | None = None, ip: str = "") -> str:
    now = time.time()
    _prune(now)
    token = secrets.token_hex(32)
    _sessions[token] = {"user": username, "exp": now + SESSION_TTL_HOURS * 3600,
                        "device": device, "created": now, "ip": ip}
    return token


def validate_session(token: str) -> str | None:
    s = _sessions.get(token)
    if not s:
        return None
    if time.time() > s["exp"]:
        del _sessions[token]
        return None
    return s["user"]


def session_device(token: str) -> str | None:
    s = _sessions.get(token)
    return s["device"] if s else None


def delete_session(token: str) -> None:
    _sessions.pop(token, None)


def invalidate_user(username: str) -> None:
    for t in [t for t, s in _sessions.items() if s["user"] == username]:
        _sessions.pop(t, None)


def delete_others(username: str, keep_token: str) -> int:
    """Sign out everywhere else — drop all of a user's sessions but the current one."""
    gone = [t for t, s in _sessions.items() if s["user"] == username and t != keep_token]
    for t in gone:
        _sessions.pop(t, None)
    return len(gone)


def list_for_user(username: str, current_token: str) -> list[dict]:
    now = time.time()
    _prune(now)
    out = []
    for t, s in _sessions.items():
        if s["user"] != username:
            continue
        out.append({"current": t == current_token, "device": s.get("device"),
                    "created": s.get("created", 0), "ip": s.get("ip", ""),
                    "expires": s["exp"]})
    return sorted(out, key=lambda x: x["created"], reverse=True)
