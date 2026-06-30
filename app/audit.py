"""
Security audit log — who did what, when, from where.

Append-only JSONL on disk plus an in-memory tail for the UI. Records auth events
(login ok/fail, logout), 2FA changes, device add/remove/enforce, PIN unlock failures,
credential changes and terminal access — the things you'd want after a break-in.

ponytail: one JSONL file, in-memory ring for the last N. No rotation; a NAS audit
log that grows slowly is fine — add logrotate if it ever matters.
"""
import json
import threading
import time
from collections import deque

from app.config import CREDENTIALS_FILE

AUDIT_FILE = CREDENTIALS_FILE.parent / "audit.log"

_lock = threading.Lock()
_recent: deque = deque(maxlen=500)


def log(event: str, *, user: str = "", ip: str = "", detail: str = "") -> None:
    rec = {"ts": time.time(), "event": event, "user": user, "ip": ip, "detail": detail}
    with _lock:
        _recent.append(rec)
        try:
            AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(AUDIT_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")
        except OSError:
            pass


def recent(limit: int = 100) -> list[dict]:
    with _lock:
        if not _recent:
            _hydrate()
        return list(_recent)[-limit:][::-1]


def _hydrate() -> None:
    """Warm the in-memory tail from disk after a restart (best effort)."""
    try:
        lines = AUDIT_FILE.read_text(encoding="utf-8").splitlines()[-_recent.maxlen:]
        for ln in lines:
            try:
                _recent.append(json.loads(ln))
            except ValueError:
                pass
    except OSError:
        pass
