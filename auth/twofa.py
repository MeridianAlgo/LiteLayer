"""
TOTP two-factor auth (RFC 6238) — a second gate beyond the password for sign-in.

A per-user secret is stored here; enrollment is two-step (generate → confirm a live
code) so a wrong setup can't lock you out. The QR is rendered server-side as inline
SVG (no PIL, no external service — the secret never leaves the Pi).

ponytail: one JSON file, in-process lock. pyotp does the crypto.
"""
import hmac
import json
import os
import threading
import time

import pyotp
import qrcode
import qrcode.image.svg

from app.config import CREDENTIALS_FILE

TWOFA_FILE = CREDENTIALS_FILE.parent / "twofa.json"
_ISSUER = "LiteLayer"
_lock = threading.Lock()


def _load() -> dict:
    try:
        return json.loads(TWOFA_FILE.read_text())
    except Exception:
        return {}


def _save(d: dict) -> None:
    TWOFA_FILE.parent.mkdir(parents=True, exist_ok=True)
    TWOFA_FILE.write_text(json.dumps(d))
    os.chmod(TWOFA_FILE, 0o600)


def is_enabled(username: str) -> bool:
    rec = _load().get(username)
    return bool(rec and rec.get("active"))


def begin_setup(username: str) -> dict:
    """Create a pending (not-yet-active) secret and return it + a provisioning QR."""
    secret = pyotp.random_base32()
    with _lock:
        d = _load()
        d[username] = {"secret": secret, "active": False}
        _save(d)
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=username, issuer_name=_ISSUER)
    factory = qrcode.image.svg.SvgPathImage
    import io
    buf = io.BytesIO()
    qrcode.make(uri, image_factory=factory).save(buf)
    return {"secret": secret, "uri": uri, "qr_svg": buf.getvalue().decode()}


def confirm(username: str, code: str) -> bool:
    """Activate 2FA only once the user proves a working code."""
    with _lock:
        d = _load()
        rec = d.get(username)
        if not rec or rec.get("active"):
            return False
        if not verify_code(rec["secret"], code):
            return False
        rec["active"] = True
        _save(d)
        return True


def disable(username: str) -> None:
    with _lock:
        d = _load()
        if d.pop(username, None) is not None:
            _save(d)


def verify(username: str, code: str) -> bool:
    """Verify a login code, rejecting replays.

    pyotp.verify() will accept the same code repeatedly for the whole ±1-step
    window — and if the Pi's clock has drifted, that window sits in the past, so
    an old code keeps working. We record the highest TOTP step ever accepted for
    this user and refuse anything at or before it: each code is good exactly once.
    """
    code = (code or "").strip().replace(" ", "")
    with _lock:
        d = _load()
        rec = d.get(username)
        if not rec or not rec.get("active"):
            return True  # 2FA not on → nothing to check
        if not code:
            return False
        totp = pyotp.TOTP(rec["secret"])
        step = int(time.time()) // 30
        last = rec.get("last_step", -1)
        for offset in (-1, 0, 1):                 # ±1 step tolerates real clock skew
            s = step + offset
            if s <= last:
                continue                          # already spent → replay, reject
            if hmac.compare_digest(totp.at(s * 30), code):
                rec["last_step"] = s
                _save(d)
                return True
        return False


def verify_code(secret: str, code: str) -> bool:
    """One-off check used only for enrollment confirmation (no replay state yet)."""
    if not code:
        return False
    return pyotp.TOTP(secret).verify(code.strip().replace(" ", ""), valid_window=1)


# ── self-check ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import tempfile
    from pathlib import Path
    from app import config
    config.TWOFA_FILE = TWOFA_FILE = globals()["TWOFA_FILE"] = Path(tempfile.mkdtemp()) / "twofa.json"

    u = "admin"
    assert is_enabled(u) is False
    assert verify(u, "") is True                  # not enabled → passes
    info = begin_setup(u)
    assert info["secret"] and "<svg" in info["qr_svg"]
    assert confirm(u, "000000") is False          # wrong code can't activate
    assert is_enabled(u) is False
    assert confirm(u, pyotp.TOTP(info["secret"]).now()) is True   # right code activates
    assert is_enabled(u) is True
    now_code = pyotp.TOTP(info["secret"]).now()
    assert verify(u, now_code) is True
    assert verify(u, now_code) is False          # replay of the same code is rejected
    assert verify(u, "000000") is False
    old_code = pyotp.TOTP(info["secret"]).at(time.time() - 3 * 3600)
    assert verify(u, old_code) is False          # a stale code never works
    disable(u)
    assert is_enabled(u) is False
    print("twofa self-check OK")
