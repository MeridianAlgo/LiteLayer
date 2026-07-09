"""
Programs — import runnable programs from GitHub and keep them running.

Each program is a git clone under /opt/litelayer/programs/<name> wrapped in its
own systemd unit (litelayer-prog-<name>) with Restart=always, so it runs
continuously in the background and survives reboots. A program that serves a
web UI on a port gets two links: the LAN address, and — when the Cloudflare
tunnel or Tailscale is up — a global path (/apps/<name>/) reverse-proxied
through LiteLayer so it's reachable away from home (Cloudflare: anyone with the
link; Tailscale: any device on your tailnet, via Caddy on 443).

ponytail: one JSON registry file, no DB; stdlib urllib reverse proxy, no new
dependency. Upgrade path if a program needs WebSockets through the global
link: swap the proxy for httpx/websockets streaming.
"""
import json
import re
import shlex
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.config import CREDENTIALS_FILE
from app.deps import require_auth
from auth.sessions import validate_session

router = APIRouter(prefix="/api/programs", tags=["programs"])
proxy = APIRouter(tags=["programs"])

REGISTRY_FILE = CREDENTIALS_FILE.parent / "programs.json"
PROGRAMS_DIR = Path("/opt/litelayer/programs")
UNIT_DIR = Path("/etc/systemd/system")
# Per-program secrets, injected as environment variables (systemd EnvironmentFile).
# Never inside the cloned repo, so a program's own `git pull` can't expose them.
ENV_DIR = Path("/etc/litelayer/program-env")

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,40}$")
# GitHub HTTPS repos only — no arbitrary hosts/flags smuggled into `git clone`.
_REPO_RE = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?(\.git)?/?$")
_SHORT_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")   # owner/repo shorthand

_lock = threading.Lock()
# name -> {"phase": "cloning"|"installing"|"starting", "error": str|None}
_imports: dict[str, dict] = {}

_UNIT_TEMPLATE = """\
[Unit]
Description=LiteLayer program: {name}
After=network-online.target

[Service]
Type=simple
WorkingDirectory={workdir}
{env_line}EnvironmentFile=-{env_file}
ExecStart=/bin/bash -lc {cmd}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=litelayer-prog-{name}

[Install]
WantedBy=multi-user.target
"""


def _run(cmd: list[str], cwd=None, timeout=60) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as exc:  # noqa: BLE001 — dev box without git/systemctl
        return -1, str(exc)


def _load() -> dict:
    try:
        return json.loads(REGISTRY_FILE.read_text())
    except Exception:
        return {}


def _save(d: dict) -> None:
    try:
        REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        REGISTRY_FILE.write_text(json.dumps(d, indent=2))
    except OSError:
        pass


def _unit(name: str) -> str:
    return f"litelayer-prog-{name}"


def _unit_state(name: str) -> str:
    code, out = _run(["systemctl", "is-active", _unit(name)], timeout=5)
    return out if code >= 0 and out in ("active", "inactive", "failed", "activating") else "unknown"


def _write_unit(name: str, prog: dict) -> None:
    cmd = shlex.quote(prog["start_command"])
    env_line = f"Environment=PORT={prog['web_port']}\n" if prog.get("web_port") else ""
    (UNIT_DIR / f"{_unit(name)}.service").write_text(_UNIT_TEMPLATE.format(
        name=name, workdir=prog["dir"], env_line=env_line,
        env_file=ENV_DIR / f"{name}.env", cmd=cmd))
    _run(["systemctl", "daemon-reload"], timeout=15)


def _detect_start_command(repo_dir: Path) -> Optional[str]:
    """Best-effort run command from the repo's own conventions."""
    pkg = repo_dir / "package.json"
    if pkg.exists():
        try:
            scripts = json.loads(pkg.read_text()).get("scripts", {})
            if "start" in scripts:
                return "npm start"
            if (repo_dir / "index.js").exists():
                return "node index.js"
        except ValueError:
            pass
    py = repo_dir / ".venv/bin/python"
    python = str(py) if py.exists() else "python3"
    for entry in ("main.py", "app.py", "server.py"):
        if (repo_dir / entry).exists():
            return f"{python} {entry}"
    if (repo_dir / "index.js").exists():
        return "node index.js"
    return None


def _install_deps(name: str, repo_dir: Path) -> Optional[str]:
    """Install declared dependencies; returns an error string or None."""
    if (repo_dir / "requirements.txt").exists():
        _imports[name]["phase"] = "installing"
        code, out = _run(["python3", "-m", "venv", str(repo_dir / ".venv")], timeout=120)
        if code != 0:
            return f"venv failed: {out[-300:]}"
        code, out = _run([str(repo_dir / ".venv/bin/pip"), "install", "-q",
                          "-r", str(repo_dir / "requirements.txt")], timeout=600)
        if code != 0:
            return f"pip install failed: {out[-300:]}"
    if (repo_dir / "package.json").exists():
        _imports[name]["phase"] = "installing"
        code, out = _run(["npm", "install", "--omit=dev", "--no-audit", "--no-fund"],
                         cwd=str(repo_dir), timeout=600)
        if code != 0:
            return f"npm install failed: {out[-300:]}"
    return None


def _import_worker(name: str, repo_url: str, start_command: Optional[str],
                   web_port: Optional[int]) -> None:
    repo_dir = PROGRAMS_DIR / name
    try:
        code, out = _run(["git", "clone", "--depth", "1", repo_url, str(repo_dir)], timeout=300)
        if code != 0:
            raise RuntimeError(f"git clone failed: {out[-300:]}")

        err = _install_deps(name, repo_dir)
        if err:
            raise RuntimeError(err)

        cmd = start_command or _detect_start_command(repo_dir)
        with _lock:
            d = _load()
            prog = d[name]
            prog["start_command"] = cmd
            prog["status"] = "ready" if cmd else "needs_command"
            _save(d)

        if cmd:
            _imports[name]["phase"] = "starting"
            _write_unit(name, prog)
            _run(["systemctl", "enable", "--now", _unit(name)], timeout=30)
        _imports.pop(name, None)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(repo_dir, ignore_errors=True)
        with _lock:
            d = _load()
            if name in d:
                d[name]["status"] = "error"
                d[name]["error"] = str(exc)
                _save(d)
        _imports.pop(name, None)


def _global_base() -> tuple[Optional[str], Optional[str]]:
    """(public https origin, via) — Cloudflare tunnel first, else Tailscale.
    Tailscale links go through Caddy on :443, so they work on any tailnet device."""
    try:
        from app.main import _cloudflare_domain   # lazy — avoids circular import
        dom = _cloudflare_domain()
        if dom:
            return (dom if dom.startswith("http") else f"https://{dom}"), "cloudflare"
    except Exception:
        pass
    code, out = _run(["tailscale", "status", "--json"], timeout=5)
    if code == 0:
        try:
            st = json.loads(out)
            if st.get("BackendState") == "Running":
                host = (st.get("Self", {}).get("DNSName") or "").rstrip(".") \
                    or next(iter(st.get("Self", {}).get("TailscaleIPs") or []), None)
                if host:
                    return f"https://{host}", "tailscale"
        except ValueError:
            pass
    return None, None


def _listing() -> list[dict]:
    base, via = _global_base()
    out = []
    with _lock:
        d = _load()
    for name, prog in sorted(d.items()):
        importing = _imports.get(name)
        status = prog.get("status", "ready")
        if importing:
            status = "importing"
        elif status == "importing":
            status = "error"   # app restarted mid-import — the worker is gone
        elif status == "ready":
            status = _unit_state(name)   # active | inactive | failed | unknown
        out.append({
            "name": name,
            "repo_url": prog["repo_url"],
            "start_command": prog.get("start_command"),
            "web_port": prog.get("web_port"),
            "public": prog.get("public", True),
            "ota": prog.get("ota", "github"),
            "status": status,
            "phase": importing["phase"] if importing else None,
            "error": prog.get("error"),
            "created": prog.get("created"),
            "global_url": f"{base}/apps/{name}/" if base and prog.get("web_port") else None,
            "global_via": via if base and prog.get("web_port") else None,
        })
    return out


@router.get("")
def list_programs(_: str = Depends(require_auth)):
    return {"programs": _listing()}


@router.get("/updates")
def check_updates(_: str = Depends(require_auth)):
    """OTA check: compare each program's local commit with its GitHub HEAD.
    Programs on self-managed OTA are skipped — their own updater is in charge."""
    result = {}
    for name, prog in _load().items():
        if prog.get("ota", "github") == "self" or prog.get("status") == "importing":
            continue
        code, local = _run(["git", "-C", prog["dir"], "rev-parse", "HEAD"], timeout=10)
        if code != 0:
            continue
        code, remote = _run(["git", "ls-remote", prog["repo_url"], "HEAD"], timeout=20)
        if code != 0 or not remote:
            continue
        remote_sha = remote.split()[0]
        result[name] = {
            "update_available": local != remote_sha,
            "local": local[:8],
            "remote": remote_sha[:8],
        }
    return {"updates": result}


class AddProgramRequest(BaseModel):
    repo_url: str
    name: Optional[str] = None
    start_command: Optional[str] = None
    web_port: Optional[int] = None
    ota: str = "github"   # "github" = LiteLayer checks/pulls | "self" = app updates itself


def _clean_port(port: Optional[int]) -> Optional[int]:
    if port is None:
        return None
    if not (1024 <= port <= 65535) or port == 8000:
        raise HTTPException(400, "Web port must be 1024–65535 (and not 8000 — that's LiteLayer).")
    return port


@router.post("")
def add_program(req: AddProgramRequest, _: str = Depends(require_auth)):
    url = req.repo_url.strip()
    if _SHORT_RE.fullmatch(url):
        url = f"https://github.com/{url}"
    if not _REPO_RE.fullmatch(url):
        raise HTTPException(400, "Enter a GitHub repository URL (https://github.com/owner/repo).")
    url = url.rstrip("/")
    name = (req.name or url.rsplit("/", 1)[-1].removesuffix(".git")).lower()
    name = re.sub(r"[^a-z0-9._-]", "-", name).strip("-.")
    if not _NAME_RE.fullmatch(name):
        raise HTTPException(400, "Program name must be 1–41 chars: letters, digits, dot, dash.")
    port = _clean_port(req.web_port)
    if req.ota not in ("github", "self"):
        raise HTTPException(400, "ota must be 'github' or 'self'")
    with _lock:
        d = _load()
        if name in d:
            raise HTTPException(409, f"A program named '{name}' already exists.")
        import datetime
        d[name] = {
            "repo_url": url,
            "dir": str(PROGRAMS_DIR / name),
            "start_command": req.start_command,
            "web_port": port,
            "public": True,
            "ota": req.ota,
            "status": "importing",
            "created": datetime.datetime.now().isoformat(timespec="seconds"),
        }
        _save(d)
    _imports[name] = {"phase": "cloning"}
    threading.Thread(target=_import_worker, args=(name, url, req.start_command, port),
                     daemon=True, name=f"prog-import-{name}").start()
    return {"status": "importing", "name": name}


def _get(name: str) -> dict:
    if not _NAME_RE.fullmatch(name):
        raise HTTPException(400, "Invalid program name")
    d = _load()
    if name not in d:
        raise HTTPException(404, "Program not found")
    return d[name]


class ActionRequest(BaseModel):
    action: str   # start | stop | restart


@router.post("/{name}/action")
def program_action(name: str, req: ActionRequest, _: str = Depends(require_auth)):
    prog = _get(name)
    if req.action not in ("start", "stop", "restart"):
        raise HTTPException(400, "action must be start, stop or restart")
    if not prog.get("start_command"):
        raise HTTPException(409, "Set a start command first.")
    verb = {"start": ["enable", "--now"], "stop": ["disable", "--now"],
            "restart": ["restart"]}[req.action]
    code, out = _run(["systemctl", *verb, _unit(name)], timeout=30)
    if code != 0:
        raise HTTPException(500, f"systemctl {req.action} failed: {out[-300:]}")
    return {"status": _unit_state(name)}


class EditProgramRequest(BaseModel):
    start_command: Optional[str] = None
    web_port: Optional[int] = None
    public: Optional[bool] = None
    ota: Optional[str] = None
    clear_port: bool = False


@router.put("/{name}")
def edit_program(name: str, req: EditProgramRequest, _: str = Depends(require_auth)):
    _get(name)
    with _lock:
        d = _load()
        prog = d[name]
        if req.start_command is not None:
            prog["start_command"] = req.start_command.strip() or None
            if prog["start_command"] and prog.get("status") == "needs_command":
                prog["status"] = "ready"
        if req.clear_port:
            prog["web_port"] = None
        elif req.web_port is not None:
            prog["web_port"] = _clean_port(req.web_port)
        if req.public is not None:
            prog["public"] = bool(req.public)
        if req.ota is not None:
            if req.ota not in ("github", "self"):
                raise HTTPException(400, "ota must be 'github' or 'self'")
            prog["ota"] = req.ota
        _save(d)
    if prog.get("start_command"):
        _write_unit(name, prog)
        if _unit_state(name) == "active":
            _run(["systemctl", "restart", _unit(name)], timeout=30)
    return {"status": "ok"}


@router.post("/{name}/update")
def update_program(name: str, _: str = Depends(require_auth)):
    """git pull the latest, reinstall declared deps, restart the unit."""
    prog = _get(name)
    repo_dir = Path(prog["dir"])
    code, out = _run(["git", "-C", str(repo_dir), "pull", "--ff-only"], timeout=120)
    if code != 0:
        raise HTTPException(500, f"git pull failed: {out[-300:]}")
    _imports.setdefault(name, {"phase": "installing"})
    err = _install_deps(name, repo_dir)
    _imports.pop(name, None)
    if err:
        raise HTTPException(500, err)
    if prog.get("start_command"):
        _run(["systemctl", "restart", _unit(name)], timeout=30)
    return {"status": "updated", "detail": out[-200:]}


@router.delete("/{name}")
def remove_program(name: str, _: str = Depends(require_auth)):
    prog = _get(name)
    _run(["systemctl", "disable", "--now", _unit(name)], timeout=30)
    try:
        (UNIT_DIR / f"{_unit(name)}.service").unlink()
    except OSError:
        pass
    _run(["systemctl", "daemon-reload"], timeout=15)
    shutil.rmtree(prog["dir"], ignore_errors=True)
    try:
        (ENV_DIR / f"{name}.env").unlink()   # secrets die with the program
    except OSError:
        pass
    with _lock:
        d = _load()
        d.pop(name, None)
        _save(d)
    return {"status": "removed"}


@router.get("/{name}/logs")
def program_logs(name: str, lines: int = 80, _: str = Depends(require_auth)):
    _get(name)
    code, out = _run(["journalctl", "-u", _unit(name), "--no-pager", "-n", str(min(lines, 400))],
                     timeout=10)
    return {"logs": out if code == 0 else "No logs available."}


# ── Secrets ───────────────────────────────────────────────────────────────────
# KEY=VALUE lines stored at /etc/litelayer/program-env/<name>.env (mode 0600,
# root-only) and handed to the program as environment variables at start.
# GitHub repository secrets never leave GitHub — this is the on-Pi equivalent.

_ENV_LINE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$")


def _env_file(name: str) -> Path:
    return ENV_DIR / f"{name}.env"


@router.get("/{name}/secrets")
def get_secrets(name: str, _: str = Depends(require_auth)):
    _get(name)
    try:
        return {"env": _env_file(name).read_text()}
    except OSError:
        return {"env": ""}


class SecretsRequest(BaseModel):
    env: str   # KEY=VALUE per line; blank lines and #comments allowed


@router.put("/{name}/secrets")
def put_secrets(name: str, req: SecretsRequest, _: str = Depends(require_auth)):
    prog = _get(name)
    if len(req.env) > 32_000:
        raise HTTPException(413, "Secrets too large (32 KB max)")
    for i, line in enumerate(req.env.splitlines(), 1):
        line = line.strip()
        if line and not line.startswith("#") and not _ENV_LINE_RE.fullmatch(line):
            raise HTTPException(400, f"Line {i} isn't KEY=VALUE (keys: letters, digits, underscore).")
    path = _env_file(name)
    if req.env.strip():
        try:
            ENV_DIR.mkdir(parents=True, exist_ok=True)
            path.write_text(req.env if req.env.endswith("\n") else req.env + "\n")
            import os
            os.chmod(path, 0o600)
        except OSError as exc:
            raise HTTPException(500, f"Could not save secrets: {exc}")
    else:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    # A running program only sees new env on restart.
    if prog.get("start_command") and _unit_state(name) == "active":
        _run(["systemctl", "restart", _unit(name)], timeout=30)
        return {"status": "saved", "restarted": True}
    return {"status": "saved", "restarted": False}


# ── Global web access: /apps/<name>/… ─────────────────────────────────────────
# Reverse-proxies a program's web UI through LiteLayer, so the Cloudflare tunnel
# (which only points at port 8000) can reach it from anywhere in the world.
# Public programs need no login — that's the point of sharing the link; flip the
# program's "public" switch off to require a LiteLayer session instead.
# ponytail: stdlib urllib, buffered (no streaming/WebSockets); httpx if needed.

_HOP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "upgrade",
                "proxy-authorization", "te", "trailers", "host", "content-length"}


def _proxy_fetch(method: str, url: str, headers: dict, body: bytes):
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, data=body or None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:   # 4xx/5xx from the program are still answers
        return e.code, dict(e.headers), e.read()


@proxy.get("/apps/{name}", include_in_schema=False)
def apps_slash(name: str):
    return RedirectResponse(f"/apps/{name}/")


@proxy.api_route("/apps/{name}/{path:path}", include_in_schema=False,
                 methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
async def apps_proxy(name: str, path: str, request: Request):
    if not _NAME_RE.fullmatch(name):
        raise HTTPException(404, "Not found")
    prog = _load().get(name)
    if not prog or not prog.get("web_port"):
        raise HTTPException(404, "No such program, or it has no web UI.")
    if not prog.get("public", True):
        token = request.cookies.get("litelayer_session") \
            or request.headers.get("authorization", "").removeprefix("Bearer ")
        if not validate_session(token):
            raise HTTPException(401, "This program's link is private — sign in to LiteLayer first.")
    q = f"?{request.url.query}" if request.url.query else ""
    url = f"http://127.0.0.1:{prog['web_port']}/{path}{q}"
    fwd = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_HEADERS}
    body = await request.body()
    from starlette.concurrency import run_in_threadpool
    try:
        status, resp_headers, content = await run_in_threadpool(
            _proxy_fetch, request.method, url, fwd, body)
    except OSError:
        raise HTTPException(502, f"'{name}' isn't answering on port {prog['web_port']} — is it running?")
    out_headers = {k: v for k, v in resp_headers.items() if k.lower() not in _HOP_HEADERS}
    return Response(content=content, status_code=status, headers=out_headers)
