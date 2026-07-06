"""OTA update channel: stable↔beta switch, persistence, validation."""
import pytest

from app.routers import ota


@pytest.fixture
def authed(client, admin_credentials):
    client.post("/api/login", json=admin_credentials)
    return client


@pytest.fixture(autouse=True)
def tmp_channel(tmp_path, monkeypatch):
    monkeypatch.setattr(ota, "CHANNEL_FILE", tmp_path / "ota-channel")


def test_defaults_to_stable():
    assert ota._channel() == "stable"
    assert ota._branch() == "main"


def test_garbage_file_falls_back_to_stable():
    ota.CHANNEL_FILE.write_text("nightly-lol")
    assert ota._channel() == "stable"


def test_switch_to_beta_persists_and_flips_branch(authed):
    r = authed.post("/api/ota/channel", json={"channel": "beta"})
    assert r.status_code == 200
    assert r.json() == {"channel": "beta", "branch": "testing"}
    assert ota.CHANNEL_FILE.read_text() == "beta"
    assert ota._branch() == "testing"

    r = authed.post("/api/ota/channel", json={"channel": "stable"})
    assert r.status_code == 200
    assert ota._branch() == "main"


def test_unknown_channel_rejected(authed):
    r = authed.post("/api/ota/channel", json={"channel": "yolo"})
    assert r.status_code == 400
    assert ota._channel() == "stable"


def test_channel_requires_auth(client):
    r = client.post("/api/ota/channel", json={"channel": "beta"})
    assert r.status_code in (401, 403)
