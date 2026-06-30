"""Recursive drive-wide search: /api/files/search finds matches in every subfolder,
respects the PIN lock, and caps results."""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_config, admin_credentials, tmp_path):
    from drives import registry
    mp = tmp_path / "mnt"
    (mp / "a" / "b").mkdir(parents=True)
    (mp / "report.txt").write_text("x")
    (mp / "a" / "report-2.txt").write_text("x")
    (mp / "a" / "b" / "deep-report.log").write_text("x")
    (mp / "a" / "notes.md").write_text("x")
    registry.replace_all([registry.Drive(
        id="drv-s", device="/dev/loop0", label="S", fstype="ext4",
        size_bytes=100, used_bytes=10, free_bytes=90,
        state="mounted_ro", mount_point=str(mp),
    )])
    from app.main import app
    c = TestClient(app, raise_server_exceptions=True)
    c.post("/api/login", json=admin_credentials)
    return c


def test_search_finds_across_subfolders(client):
    r = client.get("/api/files/search", params={"drive": "drv-s", "q": "report"})
    assert r.status_code == 200
    paths = {e["path"] for e in r.json()["entries"]}
    # All three "report" files, each in a different folder depth.
    assert "/report.txt" in paths
    assert "/a/report-2.txt" in paths
    assert "/a/b/deep-report.log" in paths
    assert "/a/notes.md" not in paths


def test_search_is_case_insensitive(client):
    r = client.get("/api/files/search", params={"drive": "drv-s", "q": "REPORT"})
    assert len(r.json()["entries"]) == 3


def test_search_truncates_at_limit(client):
    r = client.get("/api/files/search", params={"drive": "drv-s", "q": "report", "limit": 2})
    body = r.json()
    assert len(body["entries"]) == 2
    assert body["truncated"] is True


def test_search_blocked_on_locked_drive(client):
    client.post("/api/drives/drv-s/lock", json={"pin": "1234"})
    assert client.get("/api/files/search", params={"drive": "drv-s", "q": "report"}).status_code == 423
    client.post("/api/drives/drv-s/unlock", json={"pin": "1234"})
    assert client.get("/api/files/search", params={"drive": "drv-s", "q": "report"}).status_code == 200
