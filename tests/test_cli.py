"""End-to-end CLI test: run the real app on a socket via uvicorn and drive the
stdlib CLI against it — exercising the actual HTTP/multipart/streaming wire code,
not a mocked transport. A fake mounted-rw drive on a temp dir stands in for real
hardware, so no root and no privileged mount calls are needed."""
import os
import pathlib
import socket
import stat
import threading
import time

import pytest

CLI_DIR = pathlib.Path(__file__).resolve().parent.parent / "cli"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def cli():
    import sys
    sys.path.insert(0, str(CLI_DIR))
    import litelayer
    return litelayer


@pytest.fixture
def live_server(tmp_config, admin_credentials, tmp_path, monkeypatch):
    from drives import registry
    mp = tmp_path / "mnt"
    (mp / "sub").mkdir(parents=True)
    (mp / "hello.txt").write_text("hi there")
    (mp / "sub" / "n.txt").write_text("nested")
    registry.replace_all([registry.Drive(
        id="drv-1", device="/dev/sda1", label="MyDrive", fstype="ext4",
        size_bytes=1000, used_bytes=100, free_bytes=900,
        state="mounted_rw", mount_point=str(mp),
    )])
    import drives.hotplug as hp
    monkeypatch.setattr(hp, "start", lambda: None)  # no real hardware scan on startup

    import uvicorn
    from app.main import app
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"
    yield {"url": f"http://127.0.0.1:{port}", "mp": mp}
    server.should_exit = True
    t.join(timeout=5)


def test_cli_end_to_end(cli, live_server, tmp_path, monkeypatch, capsys):
    cfgdir = tmp_path / "cfg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfgdir))
    monkeypatch.delenv("LITELAYER_URL", raising=False)
    monkeypatch.delenv("LITELAYER_TOKEN", raising=False)
    url = live_server["url"]
    mp = live_server["mp"]

    # login (prompts) → saves a 0600 config with the Bearer token
    monkeypatch.setattr("builtins.input", lambda *_: "admin")
    monkeypatch.setattr(cli.getpass, "getpass", lambda *_: "testpassword123")
    cli.main(["login", "--url", url])
    cfgfile = cfgdir / "litelayer" / "config.json"
    assert cfgfile.exists()
    if os.name == "posix":
        assert stat.S_IMODE(cfgfile.stat().st_mode) == 0o600

    # drives — resolves and lists
    cli.main(["drives"])
    assert "MyDrive" in capsys.readouterr().out

    # ls by label (not just UUID)
    cli.main(["ls", "MyDrive"])
    out = capsys.readouterr().out
    assert "hello.txt" in out and "sub/" in out

    # put (streaming multipart upload)
    lf = tmp_path / "up.txt"
    lf.write_text("uploaded-body")
    cli.main(["put", "MyDrive", "/", str(lf)])
    assert (mp / "up.txt").read_text() == "uploaded-body"

    # get (streaming download)
    dest = tmp_path / "down.txt"
    cli.main(["get", "MyDrive", "/hello.txt", "-o", str(dest)])
    assert dest.read_text() == "hi there"

    # mkdir — path is split into parent + basename
    cli.main(["mkdir", "MyDrive", "/newdir"])
    assert (mp / "newdir").is_dir()

    # mv — last arg is the destination folder
    cli.main(["mv", "MyDrive", "/up.txt", "/newdir"])
    assert (mp / "newdir" / "up.txt").exists()
    assert not (mp / "up.txt").exists()

    # find — recursive search
    cli.main(["find", "MyDrive", "hello"])
    assert "/hello.txt" in capsys.readouterr().out

    # rm
    cli.main(["rm", "MyDrive", "/hello.txt"])
    assert not (mp / "hello.txt").exists()

    # logout wipes the local token file
    cli.main(["logout"])
    assert not cfgfile.exists()


def test_get_recursive(cli, live_server, tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    monkeypatch.delenv("LITELAYER_URL", raising=False)
    monkeypatch.delenv("LITELAYER_TOKEN", raising=False)
    monkeypatch.setattr("builtins.input", lambda *_: "admin")
    monkeypatch.setattr(cli.getpass, "getpass", lambda *_: "testpassword123")
    cli.main(["login", "--url", live_server["url"]])

    out = tmp_path / "pulled"
    cli.main(["get", "MyDrive", "/sub", "-r", "-o", str(out)])
    assert (out / "n.txt").read_text() == "nested"


def test_unauth_command_exits(cli, tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "empty"))
    monkeypatch.delenv("LITELAYER_TOKEN", raising=False)
    with pytest.raises(SystemExit) as e:
        cli.main(["drives"])
    assert e.value.code == 1


def test_config_saved_0600(cli, tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "c"))
    cli._save_config({"url": "http://x", "token": "secret"})
    p = pathlib.Path(cli._config_path())
    assert p.exists()
    if os.name == "posix":
        assert stat.S_IMODE(p.stat().st_mode) == 0o600
