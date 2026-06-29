"""Cross-device settings: stored encrypted, auth-gated, round-trips per account."""
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_config, admin_credentials):
    # Encrypted blob + key land in the temp config dir, not the real /etc path.
    import app.settings_store as ss
    importlib.reload(ss)
    from app.main import app
    c = TestClient(app, raise_server_exceptions=True)
    c.post("/api/login", json=admin_credentials)
    return c


def test_requires_auth(tmp_config):
    from app.main import app
    anon = TestClient(app)
    assert anon.get("/api/settings").status_code == 401
    assert anon.put("/api/settings", json={"settings": {}}).status_code == 401


def test_round_trip(client):
    assert client.get("/api/settings").json()["settings"] == {}
    client.put("/api/settings", json={"settings": {"ll-theme": "light", "ll-accent": "teal"}})
    assert client.get("/api/settings").json()["settings"]["ll-accent"] == "teal"


def test_stored_ciphertext_not_plaintext(client, tmp_config):
    client.put("/api/settings", json={"settings": {"ll-accent": "teal"}})
    blob = (tmp_config["creds"].parent / "settings.enc").read_bytes()
    assert b"teal" not in blob, "settings must be encrypted at rest"


def test_oversized_rejected(client):
    big = {"x": "a" * 70_000}
    assert client.put("/api/settings", json={"settings": big}).status_code == 413


def test_cloudflare_token_validated(client):
    # A bogus token is rejected before anything touches systemd.
    r = client.post("/api/system/cloudflare", json={"action": "enable", "mode": "token", "token": "no spaces; rm -rf"})
    assert r.status_code == 400
