"""Photo Inbox: attachment extraction, config round-trip, API masking."""
from email.message import EmailMessage

import pytest

from app import photo_inbox


@pytest.fixture
def authed(client, admin_credentials):
    client.post("/api/login", json=admin_credentials)
    return client


def _mail(sender="me@example.com", attachments=()):
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = "pi@example.com"
    msg["Subject"] = "photos"
    msg.set_content("here you go")
    for name, mime in attachments:
        maintype, subtype = mime.split("/")
        msg.add_attachment(b"\xff\xd8fakebytes", maintype=maintype, subtype=subtype, filename=name)
    return msg


def test_extract_images_filters_non_photos():
    msg = _mail(attachments=[("IMG_0001.JPG", "image/jpeg"),
                             ("notes.txt", "text/plain"),
                             ("clip.mov", "video/quicktime"),
                             ("evil.exe", "application/octet-stream")])
    names = [n for n, _ in photo_inbox.extract_images(msg)]
    assert names == ["IMG_0001.JPG", "clip.mov"]


def test_extract_strips_paths_from_filenames():
    msg = _mail(attachments=[("../../escape.png", "image/png")])
    names = [n for n, _ in photo_inbox.extract_images(msg)]
    assert names == ["escape.png"]


def test_inline_image_without_filename_gets_one():
    msg = EmailMessage()
    msg["From"] = "me@example.com"
    msg.set_content("inline")
    msg.add_attachment(b"png", maintype="image", subtype="png")  # no filename
    out = photo_inbox.extract_images(msg)
    assert len(out) == 1 and out[0][0].endswith(".png")


def test_config_roundtrip_encrypted(tmp_config):
    cfg = photo_inbox.load_config()
    cfg.update(imap_user="pi@example.com", imap_password="secret-app-pass", enabled=True)
    photo_inbox.save_config(cfg)
    again = photo_inbox.load_config()
    assert again["imap_user"] == "pi@example.com"
    assert again["imap_password"] == "secret-app-pass"
    raw = photo_inbox.CONFIG_FILE.read_bytes()
    assert b"secret-app-pass" not in raw, "IMAP password leaked to disk in plaintext"


def test_api_masks_password_and_keeps_it_on_blank_update(authed):
    photo_inbox.save_config({**photo_inbox.DEFAULTS, "imap_password": "keepme"})
    r = authed.get("/api/photos/config")
    assert r.status_code == 200
    d = r.json()
    assert d["imap_password"] == "" and d["password_set"] is True
    # A save with a blank password must not wipe the stored one.
    r = authed.put("/api/photos/config", json={"imap_user": "new@example.com", "imap_password": ""})
    assert r.status_code == 200
    assert photo_inbox.load_config()["imap_password"] == "keepme"
    assert photo_inbox.load_config()["imap_user"] == "new@example.com"


def test_api_requires_auth():
    from fastapi.testclient import TestClient
    from app.main import app
    anon = TestClient(app)
    assert anon.get("/api/photos/config").status_code == 401
