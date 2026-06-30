"""
Brute-force throttle with escalating, persisted lockout.

One bucket per key (an IP for login, a drive id for PIN). Each failure is recorded;
once failures in the window reach the limit the key is locked, and the lockout grows
with repeated lockouts (1m, 2m, 4m, … capped) so a patient attacker can't just wait
out a fixed window. State is persisted so a process restart doesn't wipe an attacker's
strikes.

ponytail: one JSON file, in-process lock. Single process, so that's enough.
"""
import json
import threading
import time

from app.config import CREDENTIALS_FILE

THROTTLE_FILE = CREDENTIALS_FILE.parent / "throttle.json"

_lock = threading.Lock()
_WINDOW = 300          # seconds a failure counts toward the limit
_LIMIT = 5             # failures within the window before lockout
_BASE = 60             # first lockout, seconds
_MAX = 3600            # cap a single lockout at 1 hour


def _load() -> dict:
    try:
        return json.loads(THROTTLE_FILE.read_text())
    except Exception:
        return {}


def _save(d: dict) -> None:
    try:
        THROTTLE_FILE.parent.mkdir(parents=True, exist_ok=True)
        THROTTLE_FILE.write_text(json.dumps(d))
    except OSError:
        pass


def retry_after(key: str) -> int:
    """Seconds the caller must wait, or 0 if not locked out right now."""
    now = time.time()
    with _lock:
        b = _load().get(key)
        if not b:
            return 0
        return max(0, int(b.get("until", 0) - now))


def record_failure(key: str) -> int:
    """Log a failed attempt. Returns the lockout (seconds) now in effect, or 0."""
    now = time.time()
    with _lock:
        d = _load()
        b = d.get(key, {"fails": [], "strikes": 0, "until": 0})
        b["fails"] = [t for t in b["fails"] if now - t < _WINDOW] + [now]
        if len(b["fails"]) >= _LIMIT:
            b["strikes"] = b.get("strikes", 0) + 1
            lock = min(_BASE * (2 ** (b["strikes"] - 1)), _MAX)
            b["until"] = now + lock
            b["fails"] = []
            d[key] = b
            _save(d)
            return lock
        b["until"] = b.get("until", 0)
        d[key] = b
        _save(d)
        return max(0, int(b["until"] - now))


def clear(key: str) -> None:
    """Wipe a key's strikes on a successful auth."""
    with _lock:
        d = _load()
        if d.pop(key, None) is not None:
            _save(d)


# ── self-check ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import tempfile
    from pathlib import Path
    globals()["THROTTLE_FILE"] = Path(tempfile.mkdtemp()) / "throttle.json"

    k = "1.2.3.4"
    assert retry_after(k) == 0
    for _ in range(_LIMIT - 1):
        assert record_failure(k) == 0           # under the limit, no lockout yet
    lock1 = record_failure(k)                    # hits the limit
    assert lock1 == _BASE, lock1
    assert retry_after(k) > 0
    clear(k)
    assert retry_after(k) == 0                   # success wipes it
    # Escalation: the second lockout must be longer than the first.
    globals()["THROTTLE_FILE"] = Path(tempfile.mkdtemp()) / "t2.json"
    for _ in range(_LIMIT - 1):
        record_failure(k)
    lock_a = record_failure(k)                   # first lockout
    assert lock_a == _BASE, lock_a
    for _ in range(_LIMIT):
        record_failure(k)                        # rack up to a second lockout
    lock_b = record_failure(k)
    assert lock_b > lock_a, (lock_a, lock_b)     # escalated
    print("throttle self-check OK")
