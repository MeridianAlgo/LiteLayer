"""Terminal enable/disable — re-enabling must require the account password."""
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_config, admin_credentials, monkeypatch):
    # Keep the terminal flag in the temp state file, not the real /etc path.
    import drives.persist as persist
    importlib.reload(persist)
    monkeypatch.setattr(persist, "STATE_FILE", tmp_config["creds"].parent / "state.json")
    from app.main import app
    c = TestClient(app, raise_server_exceptions=True)
    c.post("/api/login", json=admin_credentials)
    return c


def test_default_enabled(client):
    assert client.get("/api/system/terminal/status").json()["enabled"] is True


def test_disable_needs_no_password(client):
    r = client.post("/api/system/terminal/toggle", json={"enabled": False})
    assert r.status_code == 200
    assert client.get("/api/system/terminal/status").json()["enabled"] is False


def test_reenable_requires_password(client):
    client.post("/api/system/terminal/toggle", json={"enabled": False})
    bad = client.post("/api/system/terminal/toggle", json={"enabled": True, "password": "wrong"})
    assert bad.status_code == 401
    assert client.get("/api/system/terminal/status").json()["enabled"] is False  # still off

    ok = client.post("/api/system/terminal/toggle",
                     json={"enabled": True, "password": "testpassword123"})
    assert ok.status_code == 200
    assert client.get("/api/system/terminal/status").json()["enabled"] is True
