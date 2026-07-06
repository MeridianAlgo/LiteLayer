import json
import os
import tempfile
from pathlib import Path
import pytest


@pytest.fixture(autouse=True)
def tmp_config(tmp_path, monkeypatch):
    """Redirect credentials and mount root to temp dirs for all tests."""
    creds = tmp_path / "credentials.json"
    mounts = tmp_path / "mounts"
    mounts.mkdir()
    monkeypatch.setenv("LITELAYER_CREDENTIALS", str(creds))
    monkeypatch.setenv("LITELAYER_MOUNT_ROOT", str(mounts))
    # Re-import config so it picks up the new env vars
    import importlib
    import app.config as cfg
    importlib.reload(cfg)
    # Modules that captured these paths at import time — point them at this test's
    # tmp dir so state never leaks between tests (devices enforce, drive PINs, etc.).
    import auth.devices as devices
    import drives.persist as persist
    import app.throttle as throttle
    import app.audit as audit
    import auth.twofa as twofa
    monkeypatch.setattr(devices, "DEVICES_FILE", tmp_path / "devices.json")
    monkeypatch.setattr(persist, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(throttle, "THROTTLE_FILE", tmp_path / "throttle.json")
    monkeypatch.setattr(audit, "AUDIT_FILE", tmp_path / "audit.log")
    monkeypatch.setattr(twofa, "TWOFA_FILE", tmp_path / "twofa.json")
    import app.settings_store as settings_store
    monkeypatch.setattr(settings_store, "_CONFIG_DIR", tmp_path)
    monkeypatch.setattr(settings_store, "_KEY_FILE", tmp_path / "settings.key")
    monkeypatch.setattr(settings_store, "_DATA_FILE", tmp_path / "settings.enc")
    return {"creds": creds, "mounts": mounts}


@pytest.fixture
def admin_credentials(tmp_config):
    """Write a known-good admin/password credential pair."""
    from auth.store import set_password
    set_password("admin", "testpassword123")
    return {"username": "admin", "password": "testpassword123"}


@pytest.fixture
def client(admin_credentials):
    """Authenticated FastAPI TestClient."""
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app, raise_server_exceptions=True)
