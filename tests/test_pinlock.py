"""Server-side per-drive PIN lock: a locked drive's files are refused (423) until
the session unlocks it. The old lock was UI-only — the API served the data anyway."""
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_config, admin_credentials, monkeypatch, tmp_path):
    import drives.persist as persist
    importlib.reload(persist)
    state = tmp_config["creds"].parent / "state.json"
    monkeypatch.setattr(persist, "STATE_FILE", state)
    # pinlock reads persist dynamically, so no reload — just clear the in-memory grants
    # on the singleton the routers actually use.
    from drives import pinlock
    pinlock._grants.clear()

    # A real mounted drive backed by a temp dir with one file in it.
    from drives import registry
    mp = tmp_path / "mnt"
    mp.mkdir()
    (mp / "secret.txt").write_text("top secret")
    registry.replace_all([registry.Drive(
        id="drv-test", device="/dev/loop0", label="Test", fstype="ext4",
        size_bytes=100, used_bytes=10, free_bytes=90,
        state="mounted_ro", mount_point=str(mp),
    )])

    from app.main import app
    c = TestClient(app, raise_server_exceptions=True)
    c.post("/api/login", json=admin_credentials)
    return c


def test_locked_drive_blocks_data_until_unlocked(client):
    drv = "drv-test"
    # Open before locking.
    assert client.get("/api/files", params={"drive": drv}).status_code == 200

    # Lock with a PIN.
    assert client.post(f"/api/drives/{drv}/lock", json={"pin": "1234"}).status_code == 200

    # Data is now refused — the actual security fix.
    assert client.get("/api/files", params={"drive": drv}).status_code == 423
    assert client.get("/api/files/download",
                      params={"drive": drv, "path": "/secret.txt"}).status_code == 423

    # Wrong PIN doesn't unlock.
    assert client.post(f"/api/drives/{drv}/unlock", json={"pin": "9999"}).status_code == 403
    assert client.get("/api/files", params={"drive": drv}).status_code == 423

    # Right PIN unlocks for this session.
    assert client.post(f"/api/drives/{drv}/unlock", json={"pin": "1234"}).status_code == 200
    assert client.get("/api/files", params={"drive": drv}).status_code == 200

    # list reports the live lock state.
    d = next(x for x in client.get("/api/drives").json() if x["id"] == drv)
    assert d["locked"] and d["unlocked"]


def test_short_pin_rejected(client):
    assert client.post("/api/drives/drv-test/lock", json={"pin": "12"}).status_code == 400


def test_remove_lock_needs_pin(client):
    client.post("/api/drives/drv-test/lock", json={"pin": "4321"})
    assert client.request("DELETE", "/api/drives/drv-test/lock",
                          json={"pin": "0000"}).status_code == 403
    assert client.request("DELETE", "/api/drives/drv-test/lock",
                          json={"pin": "4321"}).status_code == 200
    assert client.get("/api/files", params={"drive": "drv-test"}).status_code == 200
