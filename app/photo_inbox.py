"""
Photo Inbox: email photos from any phone straight onto the Pi.

No app needed — every phone's share sheet already knows how to email a photo.
A background thread polls an IMAP mailbox; image attachments from allowed
senders are saved onto a chosen drive, and (optionally) sorted into folders
by the on-device CLIP model (app/photo_ai.py).

Bluetooth/AirDrop was consciously skipped: iPhones can't send files over
Bluetooth to non-Apple hardware at all, so email is the transfer path that
works on every phone with zero setup.

Config is one Fernet-encrypted JSON (it holds the IMAP app-password), stored
next to the credentials file. ponytail: one thread, stdlib imaplib/email.
"""
import email
import email.header
import imaplib
import json
import os
import re
import threading
import time
from email.utils import parseaddr
from pathlib import Path

from app import settings_store
from app.config import CREDENTIALS_FILE

CONFIG_FILE = Path(os.environ.get("LITELAYER_PHOTO_CFG",
                                  str(CREDENTIALS_FILE.parent / "photo_inbox.enc")))

DEFAULTS = {
    "enabled": False,
    "imap_host": "imap.gmail.com",
    "imap_port": 993,
    "imap_user": "",
    "imap_password": "",       # an app password, never the account password
    "allowed_senders": [],     # empty = only mail you send yourself (to your own address)
    # From: alone is spoofable, so two harder gates ride on top of the allowlist:
    "require_verified": True,  # sender must pass the provider's DKIM/SPF check
    "devices": [],             # registered phones: [{"name","code","created","last_used"}]
                               # non-empty = mail must carry a phone's code (via the
                               # user+code@ address or in the subject) or it's ignored
    "poll_seconds": 60,
    "drive": "",               # drive UUID (see /api/drives)
    "path": "/Photos",         # folder on that drive
    "ai_enabled": False,
    "categories": [],          # [{"name": "Family", "hint": "people and family gatherings"}]
}

IMAGE_EXTS = {"jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp",
              "tiff", "avif", "dng", "mp4", "mov"}   # live photos ride along as video

_status = {"last_check": 0.0, "last_error": None, "last_reject": None, "saved": 0, "recent": []}
_wake = threading.Event()
_started = False
_cfg_lock = threading.Lock()


# ── Config ────────────────────────────────────────────────────────────────────

def load_config() -> dict:
    with _cfg_lock:
        try:
            raw = settings_store.fernet().decrypt(CONFIG_FILE.read_bytes())
            return {**DEFAULTS, **json.loads(raw)}
        except Exception:  # noqa: BLE001  (missing file, bad key — start fresh)
            return dict(DEFAULTS)


def save_config(cfg: dict, wake: bool = True) -> None:
    with _cfg_lock:
        data = settings_store.fernet().encrypt(json.dumps(cfg).encode())
        try:
            CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
            CONFIG_FILE.write_bytes(data)
        except OSError:
            pass  # dev box without /etc/litelayer — feature just won't persist
    if wake:
        _wake.set()   # apply new settings immediately


def get_status() -> dict:
    return {**_status, "recent": list(_status["recent"])}


# ── Worker ────────────────────────────────────────────────────────────────────

def start() -> None:
    """Start the polling thread (idempotent). Cheap when disabled — it sleeps
    until save_config()/poke() wakes it."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="photo-inbox").start()


def poke() -> None:
    _wake.set()


def _loop() -> None:
    while True:
        cfg = load_config()
        if cfg["enabled"] and cfg["imap_user"] and cfg["imap_password"]:
            try:
                poll_once(cfg)
                _status["last_error"] = None
            except Exception as exc:  # noqa: BLE001
                _status["last_error"] = str(exc)
            _status["last_check"] = time.time()
            _wake.wait(timeout=max(30, int(cfg["poll_seconds"])))
        else:
            _wake.wait()   # nothing to do until the config changes
        _wake.clear()


def sender_verified(msg: email.message.Message) -> bool:
    """Did the receiving mail provider's own DKIM/SPF check pass? Gmail (and
    every serious provider) stamps an Authentication-Results header on inbound
    mail — we trust their crypto instead of redoing it. A spoofed From: fails
    this because the forger can't sign for the real domain."""
    for h in (msg.get_all("Authentication-Results", []) or []) \
           + (msg.get_all("ARC-Authentication-Results", []) or []):
        hl = str(h).lower()
        if "dkim=pass" in hl or "spf=pass" in hl:
            return True
    return False


def match_device(msg: email.message.Message, devices: list[dict]) -> "dict | None":
    """Which registered phone sent this? Phones mail the plus-address
    (user+code@host) that Settings hands out — the code also counts in the
    subject line for providers without plus-addressing."""
    codes = {d["code"]: d for d in devices}
    rcpt = " ".join(str(msg.get(h, "")) for h in
                    ("To", "Cc", "Delivered-To", "X-Original-To", "Envelope-To")).lower()
    for m in re.finditer(r"\+([a-z0-9]{6,16})@", rcpt):
        if m.group(1) in codes:
            return codes[m.group(1)]
    subject = _decode(msg.get("Subject", "")).lower()
    for code, dev in codes.items():
        if code in subject:
            return dev
    return None


def poll_once(cfg: dict) -> int:
    """One IMAP pass: save every image attachment from unseen, allowed,
    verified mail. Returns how many files were saved."""
    allowed = {s.strip().lower() for s in cfg["allowed_senders"] if s.strip()}
    if not allowed:
        allowed = {cfg["imap_user"].strip().lower()}

    M = imaplib.IMAP4_SSL(cfg["imap_host"], int(cfg["imap_port"]), timeout=30)
    saved = 0
    devices_touched = False
    try:
        M.login(cfg["imap_user"], cfg["imap_password"])
        M.select("INBOX")
        typ, data = M.search(None, "UNSEEN")
        if typ != "OK":
            return 0
        for num in data[0].split():
            typ, msgdata = M.fetch(num, "(RFC822)")   # fetch marks it \Seen
            if typ != "OK" or not msgdata or msgdata[0] is None:
                continue
            msg = email.message_from_bytes(msgdata[0][1])
            sender = parseaddr(msg.get("From", ""))[1].lower()
            if sender not in allowed:
                _status["last_reject"] = f"{sender or 'unknown sender'}: not on the allowed list"
                continue
            if cfg.get("require_verified", True) and not sender_verified(msg):
                _status["last_reject"] = f"{sender}: failed the mail provider's DKIM/SPF check"
                continue
            device = None
            if cfg.get("devices"):
                device = match_device(msg, cfg["devices"])
                if not device:
                    _status["last_reject"] = f"{sender}: no registered phone code on the mail"
                    continue
                device["last_used"] = time.time()
                devices_touched = True
            for name, blob in extract_images(msg):
                try:
                    folder = _save(cfg, name, blob)
                    _status["saved"] += 1
                    saved += 1
                    _status["recent"] = ([{"name": name, "folder": folder,
                                           "device": device["name"] if device else "",
                                           "ts": time.time()}]
                                         + _status["recent"])[:20]
                except Exception as exc:  # noqa: BLE001
                    _status["last_error"] = f"{name}: {exc}"
        if devices_touched:
            save_config(cfg, wake=False)   # persist last_used without re-waking the loop
    finally:
        try:
            M.logout()
        except Exception:  # noqa: BLE001
            pass
    return saved


def _decode(value: str) -> str:
    """Decode an RFC 2047 header (encoded filenames from some mail apps)."""
    parts = email.header.decode_header(value)
    return "".join(p.decode(enc or "utf-8", "replace") if isinstance(p, bytes) else p
                   for p, enc in parts)


def extract_images(msg: email.message.Message) -> list[tuple[str, bytes]]:
    """Every image/video attachment in a message as (safe filename, bytes)."""
    out = []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        name = part.get_filename()
        if name:
            name = Path(_decode(name).replace("\\", "/")).name
        elif part.get_content_maintype() == "image":
            name = f"photo-{int(time.time())}.{part.get_content_subtype()}"
        else:
            continue
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in IMAGE_EXTS:
            continue
        blob = part.get_payload(decode=True)
        if blob:
            out.append((name, blob))
    return out


def _save(cfg: dict, name: str, blob: bytes) -> str:
    """Write one photo onto the configured drive; returns the folder it landed
    in ('' = the inbox root). AI sorting picks the subfolder when enabled."""
    from drives import registry
    from app.routers.files import _safe_path, _unique, _ensure_writable
    from app import photo_ai

    d = registry.get(cfg["drive"])
    if not d or not d.mount_point:
        raise RuntimeError("Destination drive is not mounted")
    _ensure_writable(d)
    root = Path(d.mount_point)
    base = _safe_path(root, cfg["path"])
    base.mkdir(parents=True, exist_ok=True)

    # Land the bytes first, classify after — CLIP wants a file on disk.
    tmp = base / f".ll-incoming-{os.getpid()}-{name}"
    tmp.write_bytes(blob)
    folder = ""
    try:
        if cfg["ai_enabled"] and cfg["categories"] and photo_ai.is_ready():
            folder = photo_ai.classify(tmp, cfg["categories"]) or "Unsorted"
    except Exception:  # noqa: BLE001 — a sort failure must never lose the photo
        folder = "Unsorted" if cfg["ai_enabled"] else ""
    dest_dir = base / folder if folder else base
    dest_dir.mkdir(exist_ok=True)
    tmp.rename(_unique(dest_dir / name))
    return folder
