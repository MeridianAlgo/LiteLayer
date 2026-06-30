"""
Trusted-device allowlist — "only my devices can sign in, nobody else."

Each device that signs in gets a long-lived random id in the `ll_device` cookie and
a record here (label from its user-agent, last-seen IP + time). When enforcement is
ON, login is refused for any device whose cookie isn't already in this list — so even
someone with the right password can't get in from an unrecognized device.

Identity is the device cookie, not the IP: it survives DHCP changes and works the same
on the LAN and through the Cloudflare tunnel (where every request shares one egress IP).
The last-seen IP is kept only so you can recognize a device in the list.

ponytail: one JSON file, in-process lock. Bootstrapping is by trust-on-first-use —
devices are recorded as they log in while enforcement is off; flip it on once your
devices are listed. Add a new one later by toggling enforcement off briefly.
"""
import json
import os
import secrets
import threading
import time

from app.config import DEVICES_FILE

_lock = threading.Lock()
_DEFAULT = {"enforce": False, "devices": {}}


def _load() -> dict:
    try:
        return {**_DEFAULT, **json.loads(DEVICES_FILE.read_text())}
    except Exception:
        return {"enforce": False, "devices": {}}


def _save(d: dict) -> None:
    try:
        DEVICES_FILE.parent.mkdir(parents=True, exist_ok=True)
        DEVICES_FILE.write_text(json.dumps(d))
        os.chmod(DEVICES_FILE, 0o600)
    except OSError:
        pass  # dev box without the real config dir


def new_id() -> str:
    return secrets.token_hex(16)


def is_trusted(device_id: str | None) -> bool:
    if not device_id:
        return False
    with _lock:
        return device_id in _load()["devices"]


def enforce_enabled() -> bool:
    with _lock:
        return bool(_load()["enforce"])


def set_enforce(enabled: bool) -> None:
    with _lock:
        d = _load()
        d["enforce"] = bool(enabled)
        _save(d)


def remember(device_id: str, label: str, ip: str) -> None:
    """Record (or refresh) a device on successful login."""
    now = time.time()
    with _lock:
        d = _load()
        rec = d["devices"].get(device_id, {"label": label, "created": now})
        rec.update(last_seen=now, last_ip=ip)
        if not rec.get("label"):
            rec["label"] = label
        d["devices"][device_id] = rec
        _save(d)


def rename(device_id: str, label: str) -> bool:
    with _lock:
        d = _load()
        if device_id not in d["devices"]:
            return False
        d["devices"][device_id]["label"] = label[:64]
        _save(d)
        return True


def remove(device_id: str) -> None:
    with _lock:
        d = _load()
        if d["devices"].pop(device_id, None) is not None:
            _save(d)


def listing(current_id: str | None) -> dict:
    with _lock:
        d = _load()
    devices = [
        {"id": did, "current": did == current_id, **rec}
        for did, rec in sorted(d["devices"].items(), key=lambda kv: kv[1].get("last_seen", 0), reverse=True)
    ]
    return {"enforce": bool(d["enforce"]), "current_id": current_id, "devices": devices}


# ── self-check ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import tempfile
    from pathlib import Path
    from app import config
    config.DEVICES_FILE = globals()["DEVICES_FILE"] = Path(tempfile.mkdtemp()) / "devices.json"

    a, b = new_id(), new_id()
    assert not is_trusted(a)
    assert not enforce_enabled()
    remember(a, "Chrome on Windows", "192.168.1.5")
    assert is_trusted(a)
    assert not is_trusted(b)              # never logged in → not trusted
    set_enforce(True)
    assert enforce_enabled()
    lst = listing(a)
    assert lst["enforce"] and lst["devices"][0]["current"]
    assert rename(a, "My laptop") and listing(a)["devices"][0]["label"] == "My laptop"
    remove(a)
    assert not is_trusted(a)
    print("devices self-check OK")
