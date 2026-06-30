"""2FA login, session↔device binding, and sign-out-everywhere."""
import pyotp
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_config, admin_credentials):
    from app.main import app
    c = TestClient(app, raise_server_exceptions=True)
    c.post("/api/login", json=admin_credentials)
    return c


def _anon(tmp_config):
    from app.main import app
    return TestClient(app, raise_server_exceptions=True)


# ── session ↔ device binding ────────────────────────────────────────────────────

def test_session_bound_to_device(client):
    assert client.get("/api/drives").status_code == 200      # works on its device
    client.cookies.set("ll_device", "some-other-device")     # cookie from elsewhere
    assert client.get("/api/drives").status_code == 401      # session no longer valid


def test_bearer_token_not_device_bound(tmp_config, admin_credentials):
    c = _anon(tmp_config)
    token = c.post("/api/login", json=admin_credentials).json()["token"]
    c.cookies.clear()  # no device cookie at all
    r = c.get("/api/drives", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200                              # bearer isn't device-bound


# ── TOTP 2FA ────────────────────────────────────────────────────────────────────

def _enable_2fa(client, password="testpassword123"):
    secret = client.post("/api/auth/2fa/setup", json={"password": password}).json()["secret"]
    code = pyotp.TOTP(secret).now()
    assert client.post("/api/auth/2fa/confirm", json={"code": code}).status_code == 200
    return secret


def test_2fa_required_after_enable(client, admin_credentials, tmp_config):
    secret = _enable_2fa(client)
    fresh = _anon(tmp_config)
    # password alone → "2fa_required"
    r = fresh.post("/api/login", json=admin_credentials)
    assert r.status_code == 401 and r.json()["detail"] == "2fa_required"
    # password + code → in
    ok = fresh.post("/api/login", json={**admin_credentials, "code": pyotp.TOTP(secret).now()})
    assert ok.status_code == 200


def test_2fa_setup_requires_password(client):
    assert client.post("/api/auth/2fa/setup", json={"password": "wrong"}).status_code == 401


# ── sign out everywhere ─────────────────────────────────────────────────────────

def test_signout_others(client, admin_credentials, tmp_config):
    other = _anon(tmp_config)
    other.post("/api/login", json=admin_credentials)
    assert other.get("/api/me").status_code == 200
    # From the first session, end all others.
    assert client.post("/api/auth/signout-others").json()["ended"] >= 1
    assert other.get("/api/me").status_code == 401   # the other session is dead
    assert client.get("/api/me").status_code == 200  # current one survives
