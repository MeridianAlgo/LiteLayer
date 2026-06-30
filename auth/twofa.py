"""
TOTP two-factor auth (RFC 6238) — a second gate beyond the password for sign-in.

A per-user secret is stored here; enrollment is two-step (generate → confirm a live
code) so a wrong setup can't lock you out. The QR is rendered server-side as inline
SVG (no PIL, no external service — the secret never leaves the Pi).

ponytail: one JSON file, in-process lock. pyotp does the crypto.
"""
import json
import os
import threading

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
    rec = _load().get(username)
    if not rec or not rec.get("active"):
        return True  # 2FA not on → nothing to check
    return verify_code(rec["secret"], code)


def verify_code(secret: str, code: str) -> bool:
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
    assert verify(u, pyotp.TOTP(info["secret"]).now()) is True
    assert verify(u, "000000") is False
    disable(u)
    assert is_enabled(u) is False
    print("twofa self-check OK")
