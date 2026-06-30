"""
Server-side per-drive PIN lock — the real gate, not just the UI.

A locked drive's data is refused (HTTP 423 Locked) by every files endpoint until
the *session* presents the correct PIN to /unlock. PINs are argon2-hashed (the same
hasher login uses) and only the hash touches disk. Unlock grants live in memory and
are keyed by session token, so:

  - the PIN never persists in plaintext anywhere,
  - a server restart re-locks every drive (safe default),
  - one browser unlocking a drive does not unlock it for another session.

ponytail: in-memory grants, single process — a module lock is enough. Upgrade path:
zero-knowledge PIN proof (UniGroth Groth16) so the PIN never crosses the wire at all.
"""
import threading
import time

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from drives import persist
from app.config import SESSION_TTL_HOURS

_ph = PasswordHasher()
# Verify against a real hash when no PIN is set, so "wrong drive" and "wrong PIN"
# take the same time (no probing which drives are locked via timing).
_DUMMY_HASH = _ph.hash("litelayer-pin-dummy")

_lock = threading.Lock()
# token -> {drive_id: grant_expiry_ts}
_grants: dict[str, dict[str, float]] = {}
_GRANT_TTL = SESSION_TTL_HOURS * 3600


def is_locked(drive_id: str) -> bool:
    return drive_id in persist.get_drive_pins()


def locked_ids() -> set[str]:
    return set(persist.get_drive_pins())


def set_pin(drive_id: str, pin: str) -> None:
    """Lock a drive with a 4–6 digit PIN. Raises ValueError on a bad PIN."""
    if not (pin.isdigit() and 4 <= len(pin) <= 6):
        raise ValueError("PIN must be 4–6 digits")
    persist.set_drive_pin(drive_id, _ph.hash(pin))


def _verify(drive_id: str, pin: str) -> bool:
    pin_hash = persist.get_drive_pins().get(drive_id)
    try:
        _ph.verify(pin_hash or _DUMMY_HASH, pin)
    except (VerifyMismatchError, Exception):
        return False
    return pin_hash is not None


def unlock(drive_id: str, pin: str, token: str) -> str:
    """Verify the PIN and grant this session access until TTL.
    Returns 'ok' | 'wrong' | 'throttled' (too many recent wrong PINs).

    Throttle is the shared, persisted, escalating one (app.throttle), keyed per drive
    — the PIN is the secret, so a spoofed IP can't dodge it, and lockouts survive a
    restart and grow with repeat abuse."""
    from app import throttle
    key = f"pin:{drive_id}"
    if throttle.retry_after(key):
        return "throttled"
    if not _verify(drive_id, pin):
        throttle.record_failure(key)
        return "wrong"
    throttle.clear(key)
    with _lock:
        _grants.setdefault(token, {})[drive_id] = time.time() + _GRANT_TTL
    return "ok"


def remove_pin(drive_id: str, pin: str) -> bool:
    """Drop the lock — requires the current PIN, so a stolen session can't unlock-all."""
    if not _verify(drive_id, pin):
        return False
    persist.clear_drive_pin(drive_id)
    with _lock:
        for grants in _grants.values():
            grants.pop(drive_id, None)
    return True


def is_unlocked(drive_id: str, token: str) -> bool:
    if not is_locked(drive_id):
        return True
    now = time.time()
    with _lock:
        exp = _grants.get(token, {}).get(drive_id)
        if exp is None:
            return False
        if exp <= now:
            _grants[token].pop(drive_id, None)
            return False
        return True


def assert_access(drive_id: str, token: str) -> None:
    """Gate a data request. 423 Locked if this session hasn't unlocked the drive."""
    if not is_unlocked(drive_id, token):
        from fastapi import HTTPException
        raise HTTPException(423, "Drive is locked — unlock it with its PIN")


# ── self-check ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import tempfile
    from pathlib import Path
    # Redirect the persisted PIN store to a temp file (persist bound STATE_FILE at
    # import, so set it on the module, not on app.config).
    persist.STATE_FILE = Path(tempfile.mkdtemp()) / "state.json"

    d, tok, other = "drv-1", "tokA", "tokB"
    assert is_unlocked(d, tok)                       # not locked → open
    set_pin(d, "1234")
    assert is_locked(d)
    assert not is_unlocked(d, tok)                   # locked, no grant
    assert unlock(d, "9999", tok) == "wrong"         # wrong PIN
    assert not is_unlocked(d, tok)
    assert unlock(d, "1234", tok) == "ok"            # right PIN
    assert is_unlocked(d, tok)
    assert not is_unlocked(d, other)                 # grant is per-session
    try:
        set_pin(d, "abc")
        assert False, "non-digit PIN accepted"
    except ValueError:
        pass
    assert not remove_pin(d, "0000")                 # can't remove with wrong PIN
    assert remove_pin(d, "1234")
    assert not is_locked(d)

    # Throttle: after enough wrong PINs, further tries are refused outright (uses the
    # shared persisted throttle, so point it at a temp file for the check).
    from app import throttle as _t
    _t.THROTTLE_FILE = Path(tempfile.mkdtemp()) / "throttle.json"
    set_pin(d, "1234")
    seen_throttle = False
    for _ in range(_t._LIMIT + 1):
        if unlock(d, "0000", tok) == "throttled":
            seen_throttle = True
    assert seen_throttle, "throttle never engaged"
    assert unlock(d, "1234", tok) == "throttled"     # even the right PIN waits out the cooldown
    print("pinlock self-check OK")
