"""Trusted-device allowlist: with enforcement on, only remembered devices may sign in
— even with the right password."""
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def devices_file(tmp_config, monkeypatch):
    from auth import devices
    importlib.reload(devices)
    f = tmp_config["creds"].parent / "devices.json"
    monkeypatch.setattr(devices, "DEVICES_FILE", f)
    return f


@pytest.fixture
def app_module(devices_file):
    from app.main import app
    return app


def _client(app):
    return TestClient(app, raise_server_exceptions=True)


def test_device_remembered_on_login(app_module, admin_credentials):
    c = _client(app_module)
    assert c.post("/api/login", json=admin_credentials).status_code == 200
    d = c.get("/api/devices").json()
    assert len(d["devices"]) == 1
    assert d["devices"][0]["current"] is True
    assert d["enforce"] is False


def test_enforcement_blocks_unknown_device(app_module, admin_credentials):
    trusted = _client(app_module)
    trusted.post("/api/login", json=admin_credentials)
    # Turn on the restriction from the (now trusted) device.
    assert trusted.post("/api/devices/enforce", json={"enabled": True}).status_code == 200

    # A brand-new device (no ll_device cookie) is refused despite correct creds.
    stranger = _client(app_module)
    r = stranger.post("/api/login", json=admin_credentials)
    assert r.status_code == 403

    # The trusted device still gets in.
    assert trusted.post("/api/login", json=admin_credentials).status_code == 200


def test_cannot_enforce_without_a_trusted_device(app_module, admin_credentials):
    # Log in via bearer token only (no device cookie carried), then try to enforce.
    c = TestClient(app_module, raise_server_exceptions=True)
    token = c.post("/api/login", json=admin_credentials).json()["token"]
    c.cookies.clear()  # drop the device + session cookies; use the bearer token instead
    r = c.post("/api/devices/enforce", json={"enabled": True},
               headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 400  # this (cookieless) device isn't on the list


def test_cannot_remove_current_device_while_enforced(app_module, admin_credentials):
    c = _client(app_module)
    c.post("/api/login", json=admin_credentials)
    did = c.get("/api/devices").json()["devices"][0]["id"]
    c.post("/api/devices/enforce", json={"enabled": True})
    assert c.delete(f"/api/devices/{did}").status_code == 400
