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
