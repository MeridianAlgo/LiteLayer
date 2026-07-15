"""Programs: import validation, registry lifecycle, proxy gating."""
import pytest

from app.routers import programs


@pytest.fixture
def authed(client, admin_credentials):
    client.post("/api/login", json=admin_credentials)
    return client


@pytest.fixture(autouse=True)
def tmp_programs(tmp_path, monkeypatch):
    monkeypatch.setattr(programs, "REGISTRY_FILE", tmp_path / "programs.json")
    monkeypatch.setattr(programs, "PROGRAMS_DIR", tmp_path / "programs")
    monkeypatch.setattr(programs, "UNIT_DIR", tmp_path)
    monkeypatch.setattr(programs, "ENV_DIR", tmp_path / "program-env")
    monkeypatch.setattr(programs, "MONITOR_FILE", tmp_path / "monitor-program")
    # Never touch git/systemctl in tests; keep the import worker inert.
    monkeypatch.setattr(programs, "_run", lambda *a, **k: (0, ""))
    monkeypatch.setattr(programs, "_import_worker", lambda *a, **k: None)
    programs._imports.clear()


def test_requires_auth(client):
    assert client.get("/api/programs").status_code in (401, 403)


def test_rejects_non_github_repo(authed):
    r = authed.post("/api/programs", json={"repo_url": "https://evil.example/x/y.git"})
    assert r.status_code == 400


def test_rejects_litelayer_port(authed):
    r = authed.post("/api/programs", json={"repo_url": "owner/repo", "web_port": 8000})
    assert r.status_code == 400


def test_shorthand_import_and_duplicate(authed):
    r = authed.post("/api/programs", json={"repo_url": "Owner/My_App", "web_port": 3000})
    assert r.status_code == 200
    name = r.json()["name"]
    assert name == "my_app"

    listed = authed.get("/api/programs").json()["programs"]
    assert [p["name"] for p in listed] == [name]
    assert listed[0]["status"] == "importing"
    assert listed[0]["repo_url"] == "https://github.com/Owner/My_App"

    assert authed.post("/api/programs", json={"repo_url": "Owner/My_App"}).status_code == 409


def test_edit_and_delete(authed):
    authed.post("/api/programs", json={"repo_url": "o/app"})
    programs._imports.clear()   # pretend the import finished
    with programs._lock:
        d = programs._load()
        d["app"]["status"] = "needs_command"
        programs._save(d)

    r = authed.put("/api/programs/app", json={"start_command": "python3 main.py"})
    assert r.status_code == 200
    assert programs._load()["app"]["status"] == "ready"

    assert authed.delete("/api/programs/app").status_code == 200
    assert programs._load() == {}
    assert authed.delete("/api/programs/app").status_code == 404


def test_secrets_roundtrip(authed):
    authed.post("/api/programs", json={"repo_url": "o/app"})
    programs._imports.clear()

    r = authed.put("/api/programs/app/secrets", json={"env": "not a valid line"})
    assert r.status_code == 400

    r = authed.put("/api/programs/app/secrets", json={"env": "API_KEY=abc\n# note\nDB_URL=x"})
    assert r.status_code == 200
    env_file = programs.ENV_DIR / "app.env"
    assert "API_KEY=abc" in env_file.read_text()
    assert authed.get("/api/programs/app/secrets").json()["env"].startswith("API_KEY=abc")

    # Blank payload deletes the file; removing the program would too.
    authed.put("/api/programs/app/secrets", json={"env": ""})
    assert not env_file.exists()


def test_ota_modes_and_update_check(authed, monkeypatch):
    authed.post("/api/programs", json={"repo_url": "o/checked"})
    authed.post("/api/programs", json={"repo_url": "o/selfmanaged", "ota": "self"})
    programs._imports.clear()
    with programs._lock:
        d = programs._load()
        for p in d.values():
            p["status"] = "ready"
        programs._save(d)

    assert authed.post("/api/programs", json={"repo_url": "o/x", "ota": "nightly"}).status_code == 400

    def fake_run(cmd, **kw):
        if cmd[:2] == ["git", "-C"]:
            return 0, "aaaa111122223333"                     # local sha
        if cmd[:2] == ["git", "ls-remote"]:
            return 0, "bbbb444455556666\tHEAD"               # remote moved ahead
        return 0, ""
    monkeypatch.setattr(programs, "_run", fake_run)

    ups = authed.get("/api/programs/updates").json()["updates"]
    assert ups["checked"]["update_available"] is True
    assert "selfmanaged" not in ups                          # self-managed is skipped

    r = authed.put("/api/programs/selfmanaged", json={"ota": "github"})
    assert r.status_code == 200
    assert programs._load()["selfmanaged"]["ota"] == "github"


def test_monitor_kiosk(authed, monkeypatch):
    authed.post("/api/programs", json={"repo_url": "o/web", "web_port": 3000})
    authed.post("/api/programs", json={"repo_url": "o/headless"})
    programs._imports.clear()

    # No web UI → nothing to show.
    assert authed.post("/api/programs/headless/monitor", json={"on": True}).status_code == 409

    monkeypatch.setattr(programs, "_monitor_connected", lambda: False)
    assert authed.post("/api/programs/web/monitor", json={"on": True}).status_code == 409

    monkeypatch.setattr(programs, "_monitor_connected", lambda: True)
    monkeypatch.setattr(programs.shutil, "which", lambda b: f"/usr/bin/{b}")
    assert authed.post("/api/programs/web/monitor", json={"on": True}).status_code == 200
    unit = (programs.UNIT_DIR / "litelayer-kiosk.service").read_text()
    assert "http://127.0.0.1:3000/" in unit
    # Boot-friendly: starts after (and pulls in) the program's unit, and waits
    # for the port to answer before opening the browser.
    assert "Wants=litelayer-prog-web.service" in unit
    assert "/dev/tcp/127.0.0.1/3000" in unit

    listed = authed.get("/api/programs").json()
    assert listed["monitor"] == {"connected": True, "program": "web"}
    assert {p["name"]: p["on_monitor"] for p in listed["programs"]} == {"headless": False, "web": True}

    # Monitor command: saved via edit, baked into the kiosk unit as ExecStartPre.
    r = authed.put("/api/programs/web", json={"monitor_command": "./warmup.sh --once"})
    assert r.status_code == 200
    unit = (programs.UNIT_DIR / "litelayer-kiosk.service").read_text()
    assert "ExecStartPre=-/bin/bash -lc './warmup.sh --once'" in unit
    authed.put("/api/programs/web", json={"monitor_command": ""})   # empty clears
    assert "warmup.sh" not in (programs.UNIT_DIR / "litelayer-kiosk.service").read_text()
    assert programs._load()["web"]["monitor_command"] is None

    # Removing the program on the monitor turns the kiosk off too.
    assert authed.delete("/api/programs/web").status_code == 200
    assert not (programs.UNIT_DIR / "litelayer-kiosk.service").exists()
    assert authed.get("/api/programs").json()["monitor"]["program"] is None


def test_private_repo_token(authed, monkeypatch):
    assert authed.post("/api/programs",
                       json={"repo_url": "o/priv", "token": "bad token!"}).status_code == 400

    r = authed.post("/api/programs", json={"repo_url": "o/priv", "token": "ghp_abc123def456"})
    assert r.status_code == 200
    programs._imports.clear()
    with programs._lock:
        d = programs._load()
        d["priv"]["status"] = "ready"
        programs._save(d)

    # The token is stored but never returned by the API.
    p = authed.get("/api/programs").json()["programs"][0]
    assert p["has_token"] is True
    assert "token" not in p
    assert programs._load()["priv"]["token"] == "ghp_abc123def456"

    # git commands run with the auth header in env, not argv.
    seen = {}
    def fake_run(cmd, **kw):
        if cmd[:2] == ["git", "ls-remote"]:
            seen.update(kw.get("env") or {})
            return 0, "cafe000011112222\tHEAD"
        return 0, "cafe000011112222"
    monkeypatch.setattr(programs, "_run", fake_run)
    authed.get("/api/programs/updates")
    assert seen["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraheader"
    assert "AUTHORIZATION: basic " in seen["GIT_CONFIG_VALUE_0"]
    assert "ghp_abc123def456" not in seen["GIT_CONFIG_VALUE_0"]   # base64, not plaintext

    # Clearing via edit.
    assert authed.put("/api/programs/priv", json={"token": ""}).status_code == 200
    assert programs._load()["priv"]["token"] is None


def test_proxy_unknown_and_private(authed, client):
    assert client.get("/apps/nope/").status_code == 404

    with programs._lock:
        programs._save({"app": {"repo_url": "https://github.com/o/app", "dir": "/x",
                                "web_port": 3111, "public": False, "status": "ready"}})
    # Private program: no session → 401 before any proxying is attempted.
    from fastapi.testclient import TestClient
    from app.main import app
    anon = TestClient(app)
    assert anon.get("/apps/app/").status_code == 401
