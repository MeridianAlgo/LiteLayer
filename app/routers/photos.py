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
        typ, data = M.select("INBOX", readonly=True)
        unseen = 0
        if typ == "OK":
            typ, res = M.search(None, "UNSEEN")
            if typ == "OK":
                unseen = len(res[0].split())
        M.logout()
        return {"ok": True, "unseen": unseen}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Could not sign in: {exc}")


@router.get("/status")
def status(_: str = Depends(require_auth)):
    return {**photo_inbox.get_status(), "ai": photo_ai.status()}


@router.post("/poll")
def poll_now(_: str = Depends(require_auth)):
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
