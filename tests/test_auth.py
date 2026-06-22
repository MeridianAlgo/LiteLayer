"""Auth endpoints — no root required."""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def anon_client():
    from app.main import app
    return TestClient(app, raise_server_exceptions=True)


def test_login_success(anon_client, admin_credentials):
    r = anon_client.post("/api/login", json=admin_credentials)
    assert r.status_code == 200
    assert "token" in r.json()


def test_login_wrong_password(anon_client, admin_credentials):
    r = anon_client.post("/api/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401


def test_login_unknown_user(anon_client):
    r = anon_client.post("/api/login", json={"username": "hacker", "password": "x"})
    assert r.status_code == 401


def test_drives_requires_auth(anon_client):
    r = anon_client.get("/api/drives")
    assert r.status_code == 401


def test_files_requires_auth(anon_client):
    r = anon_client.get("/api/files?drive=abc&path=/")
    assert r.status_code == 401


def test_download_requires_auth(anon_client):
    r = anon_client.get("/api/files/download?drive=abc&path=/x")
    assert r.status_code == 401


def test_bearer_token_auth(anon_client, admin_credentials):
    r = anon_client.post("/api/login", json=admin_credentials)
    token = r.json()["token"]

    r2 = anon_client.get("/api/drives", headers={"Authorization": f"Bearer {token}"})
    # 200 (empty list) — not 401
    assert r2.status_code == 200


def test_cookie_auth(anon_client, admin_credentials):
    # TestClient carries cookies across requests
    r = anon_client.post("/api/login", json=admin_credentials)
    assert r.status_code == 200
    r2 = anon_client.get("/api/drives")
    assert r2.status_code == 200


def test_logout_clears_session(anon_client, admin_credentials):
    anon_client.post("/api/login", json=admin_credentials)
    anon_client.post("/api/logout")
    r = anon_client.get("/api/drives")
    assert r.status_code == 401


def test_me_endpoint(anon_client, admin_credentials):
    anon_client.post("/api/login", json=admin_credentials)
    r = anon_client.get("/api/me")
    assert r.status_code == 200
    assert r.json()["username"] == "admin"
