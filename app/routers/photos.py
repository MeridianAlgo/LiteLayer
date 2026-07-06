"""Photo Inbox API — configure the email-to-Pi photo pipeline and its AI sorter."""
import imaplib
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app import audit, photo_ai, photo_inbox
from app.deps import require_auth
from app.netutil import client_ip

router = APIRouter(prefix="/api/photos", tags=["photos"])


def _masked(cfg: dict) -> dict:
    return {**cfg, "imap_password": "", "password_set": bool(cfg["imap_password"])}


@router.get("/config")
def get_config(_: str = Depends(require_auth)):
    return _masked(photo_inbox.load_config())


class Category(BaseModel):
    name: str
    hint: str = ""


class ConfigRequest(BaseModel):
    enabled: Optional[bool] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_user: Optional[str] = None
    imap_password: Optional[str] = None   # blank/omitted = keep the saved one
    allowed_senders: Optional[list[str]] = None
    require_verified: Optional[bool] = None
    poll_seconds: Optional[int] = None
    drive: Optional[str] = None
    path: Optional[str] = None
    ai_enabled: Optional[bool] = None
    categories: Optional[list[Category]] = None


@router.put("/config")
def put_config(req: ConfigRequest, request: Request, username: str = Depends(require_auth)):
    cfg = photo_inbox.load_config()
    updates = req.model_dump(exclude_none=True)
    if not updates.get("imap_password"):
        updates.pop("imap_password", None)          # blank means keep the saved one
    if "categories" in updates:
        cats = [{"name": c["name"].strip(), "hint": c["hint"].strip()}
                for c in updates["categories"] if c["name"].strip()]
        if len(cats) > 30:
            raise HTTPException(400, "Too many categories (max 30)")
        updates["categories"] = cats
    if "poll_seconds" in updates:
        updates["poll_seconds"] = max(30, min(3600, updates["poll_seconds"]))
    cfg.update(updates)
    photo_inbox.save_config(cfg)
    audit.log("photos.config", user=username, ip=client_ip(request))
    return _masked(cfg)


class TestRequest(BaseModel):
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_user: Optional[str] = None
    imap_password: Optional[str] = None   # blank = use the saved one


@router.post("/test")
def test_connection(req: TestRequest, _: str = Depends(require_auth)):
    cfg = photo_inbox.load_config()
    host = req.imap_host or cfg["imap_host"]
    port = req.imap_port or cfg["imap_port"]
    user = req.imap_user or cfg["imap_user"]
    password = req.imap_password or cfg["imap_password"]
    if not (host and user and password):
        raise HTTPException(400, "Fill in the mail server, address and app password first.")
    try:
        M = imaplib.IMAP4_SSL(host, int(port), timeout=15)
        M.login(user, password)

        def unseen_in(box: str):
            if M.select(box, readonly=True)[0] != "OK":
                return None   # folder doesn't exist on this provider
            typ, res = M.search(None, "UNSEEN")
            return len(res[0].split()) if typ == "OK" else None

        unseen = unseen_in("INBOX") or 0
        # A brand-new mailbox's first mail very often lands in Spam, which
        # IMAP INBOX doesn't include — check it so "0 unread" isn't a mystery.
        spam_unseen = 0
        for box in ("[Gmail]/Spam", "Spam", "Junk"):
            n = unseen_in(box)
            if n is not None:
                spam_unseen = n
                break
        M.logout()
        return {"ok": True, "unseen": unseen, "spam_unseen": spam_unseen}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Could not sign in: {exc}")


@router.get("/status")
def status(_: str = Depends(require_auth)):
    return {**photo_inbox.get_status(), "ai": photo_ai.status()}


@router.post("/poll")
def poll_now(_: str = Depends(require_auth)):
    cfg = photo_inbox.load_config()
    if not (cfg["enabled"] and cfg["imap_user"] and cfg["imap_password"]):
        return {"status": "off"}   # tell the UI why nothing will happen
    photo_inbox.poke()
    return {"status": "checking"}


@router.post("/ai/setup")
def ai_setup(username: str = Depends(require_auth)):
    if photo_ai.is_ready():
        return {"status": "ready"}
    if not photo_ai.start_setup():
        raise HTTPException(409, "Setup is already running")
    audit.log("photos.ai_setup", user=username, ip="")
    return {"status": "installing"}
