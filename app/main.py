import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.config import CORS_ORIGINS, DEV_UI_PATH
from app.deps import require_auth
from app.routers import drives, files, ota
from auth import sessions, store as auth_store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    from drives import hotplug
    hotplug.start()
    yield


_version_file = Path(__file__).parent.parent / "VERSION"
_VERSION = _version_file.read_text().strip() if _version_file.exists() else "dev"

app = FastAPI(
    title="LiteLayer",
    description="Secure self-hosted NAS backend for Raspberry Pi",
    version=_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(drives.router)
app.include_router(files.router)
app.include_router(ota.router)


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(req: LoginRequest, response: Response):
    if not auth_store.verify_password(req.username, req.password):
        raise HTTPException(401, "Invalid credentials")
    token = sessions.create_session(req.username)
    response.set_cookie(
        key="litelayer_session",
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,   # Caddy handles TLS termination; set True if serving HTTPS directly
        max_age=86400,
    )
    return {"token": token, "username": req.username}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get("litelayer_session")
    if token:
        sessions.delete_session(token)
    response.delete_cookie("litelayer_session")
    return {"status": "ok"}


@app.get("/api/me")
def me(request: Request):
    """Quick auth check — returns 401 if not logged in, username otherwise."""
    from app.deps import require_auth
    from fastapi import Cookie
    token = request.cookies.get("litelayer_session")
    auth = request.headers.get("authorization", "")
    if not token and auth.startswith("Bearer "):
        token = auth[7:]
    if not token:
        raise HTTPException(401, "Not authenticated")
    username = sessions.validate_session(token)
    if not username:
        raise HTTPException(401, "Session expired")
    return {"username": username}


class UpdateCredentialsRequest(BaseModel):
    current_password: str
    new_username: Optional[str] = None
    new_password: Optional[str] = None


@app.post("/api/auth/update-credentials")
def update_credentials(req: UpdateCredentialsRequest, username: str = Depends(require_auth)):
    if not auth_store.verify_password(username, req.current_password):
        raise HTTPException(401, "Current password is incorrect")
    new_pass = req.new_password or None
    if new_pass and len(new_pass) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    new_user = (req.new_username or "").strip() or username
    if new_user != username:
        auth_store.rename_user(username, new_user)
    if new_pass:
        auth_store.set_password(new_user, new_pass)
    if new_user != username:
        sessions.invalidate_user(username)
        return {"status": "ok", "relogin_required": True}
    return {"status": "ok", "relogin_required": False}


@app.get("/api/system/info")
def system_info(_: str = Depends(require_auth)):
    import re, shutil, socket, subprocess
    vpns = []

    def _run(cmd, timeout=5):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            return r.returncode, r.stdout
        except Exception:
            return -1, ""

    # Tailscale — tailscale0 interface
    code, out = _run(["ip", "addr", "show", "tailscale0"])
    if code == 0:
        m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", out)
        vpns.append({"name": "Tailscale", "ip": m.group(1) if m else None})

    # ZeroTier — any zt* interface
    code, out = _run(["ip", "-brief", "addr"])
    if code == 0:
        for line in out.splitlines():
            if re.match(r"zt\w+\s+UP", line):
                parts = line.split()
                ip = parts[2].split("/")[0] if len(parts) > 2 else None
                vpns.append({"name": "ZeroTier", "ip": ip})
                break

    # Cloudflare Tunnel — cloudflared process
    code, _ = _run(["pgrep", "-x", "cloudflared"], timeout=3)
    if code == 0:
        vpns.append({"name": "Cloudflare Tunnel", "ip": None})

    try:
        hostname = socket.gethostname()
    except Exception:
        hostname = "unknown"

    return {"hostname": hostname, "vpns": vpns}


# ── VPN switching (writes boot default + reboots) ─────────────────────────────
# name -> (cli tool to detect install, systemd unit to enable on boot)
_VPN_UNITS = {
    "Tailscale":          ("tailscale",    "tailscaled"),
    "WireGuard":          ("wg",           "wg-quick@wg0"),
    "ZeroTier":           ("zerotier-cli", "zerotier-one"),
    "Cloudflare Tunnel":  ("cloudflared",  "litelayer-cloudflare"),
}


def _sysctl(*args: str) -> str:
    import subprocess
    try:
        return subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def _vpn_installed(tool: str, unit: str) -> bool:
    # shutil.which misses tools in sbin when PATH is trimmed, and Cloudflare has no
    # CLI on PATH — so also accept "the systemd unit exists" as proof of install.
    import os, shutil
    if shutil.which(tool):
        return True
    for d in ("/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/bin", "/sbin"):
        if os.path.exists(os.path.join(d, tool)):
            return True
    return unit in _sysctl("list-unit-files", unit, "--no-legend")


@app.get("/api/system/vpns")
def list_vpns(_: str = Depends(require_auth)):
    # Always return all supported VPNs (with an `installed` flag) so the UI can
    # show them — an empty list was why you "couldn't select a VPN at all".
    out = []
    for name, (tool, unit) in _VPN_UNITS.items():
        out.append({
            "name": name,
            "unit": unit,
            "installed": _vpn_installed(tool, unit),
            "enabled": _sysctl("is-enabled", unit) == "enabled",
            "active":  _sysctl("is-active", unit) == "active",
        })
    return {"vpns": out}


class VpnSwitchRequest(BaseModel):
    name: str


def _stop_other_vpns(keep: str) -> None:
    """Disable + stop every VPN unit except the chosen one."""
    import subprocess
    for name, (_tool, unit) in _VPN_UNITS.items():
        if name == keep:
            continue
        subprocess.run(["systemctl", "disable", "--now", unit], capture_output=True, text=True)


@app.post("/api/system/vpn/switch")
def switch_vpn(req: VpnSwitchRequest, _: str = Depends(require_auth)):
    """Enable + start the chosen VPN now and turn the others off. No reboot."""
    import subprocess
    if req.name not in _VPN_UNITS:
        raise HTTPException(400, f"Unknown VPN: {req.name}")
    tool, unit = _VPN_UNITS[req.name]
    if not _vpn_installed(tool, unit):
        raise HTTPException(409, f"{req.name} is not installed on this device")
    r = subprocess.run(["systemctl", "enable", "--now", unit], capture_output=True, text=True)
    if r.returncode != 0:
        raise HTTPException(500, (r.stderr or r.stdout or "systemctl failed").strip())
    _stop_other_vpns(req.name)   # turn off any old VPN
    return {"status": "switched", "vpn": req.name, "unit": unit,
            "active": _sysctl("is-active", unit) == "active"}


# ── VPN install + sign-in from the UI ─────────────────────────────────────────
import re as _re

VPN_LOG = Path("/var/log/litelayer/vpn.log")
# Shell steps to install each VPN (mirrors installer/install.sh).
_VPN_INSTALL = {
    "Tailscale":          ["curl -fsSL https://tailscale.com/install.sh | sh"],
    "ZeroTier":           ["curl -fsSL https://install.zerotier.com | bash"],
    "Cloudflare Tunnel":  [
        "curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null",
        'echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo $VERSION_CODENAME) main" | tee /etc/apt/sources.list.d/cloudflared.list >/dev/null',
        "apt-get update -qq && apt-get install -y cloudflared",
    ],
    "WireGuard":          ["apt-get install -y --no-install-recommends wireguard wireguard-tools"],
}
# Command that produces a sign-in URL (run detached; we scrape its output).
_VPN_SIGNIN = {
    "Tailscale": "tailscale up --accept-routes",
}
_AUTH_URL_RE = _re.compile(r"https://(?:login\.tailscale\.com|[\w.-]*netbird[\w.-]*|[\w.-]*trycloudflare\.com)\S*")

_vpn_state = {"running": False, "name": None, "auth_url": None, "error": None}
_vpn_lock = __import__("threading").Lock()


def _vlog(msg: str) -> None:
    try:
        VPN_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(VPN_LOG, "a") as f:
            f.write(msg.rstrip() + "\n")
    except OSError:
        pass


def _vpn_install_worker(name: str, network_id: str | None) -> None:
    import subprocess, datetime
    try:
        _vlog(f"\n--- install {name} {datetime.datetime.now().isoformat(timespec='seconds')} ---")
        for cmd in _VPN_INSTALL.get(name, []):
            _vlog(f"$ {cmd}")
            r = subprocess.run(cmd, shell=True, executable="/bin/bash",
                               capture_output=True, text=True, timeout=600)
            _vlog(r.stdout + r.stderr)
            if r.returncode != 0:
                _vpn_state["error"] = f"Install step failed: {cmd}"
                return

        tool, unit = _VPN_UNITS[name]
        # ZeroTier: join the network the user supplied
        if name == "ZeroTier" and network_id:
            r = subprocess.run(["zerotier-cli", "join", network_id], capture_output=True, text=True)
            _vlog(r.stdout + r.stderr)

        # Sign-in step: launch detached, scrape the auth URL it prints.
        signin = _VPN_SIGNIN.get(name)
        if signin:
            _vlog(f"$ {signin} (detached)")
            subprocess.Popen(f"{signin} >> {VPN_LOG} 2>&1 &", shell=True, executable="/bin/bash")
            import time
            for _ in range(20):   # up to ~20s for the URL to appear
                time.sleep(1)
                try:
                    m = _AUTH_URL_RE.search(VPN_LOG.read_text())
                except OSError:
                    m = None
                if m:
                    _vpn_state["auth_url"] = m.group(0)
                    break

        subprocess.run(["systemctl", "enable", "--now", unit], capture_output=True, text=True)
        _stop_other_vpns(name)   # turn the previous VPN off
        _vlog(f"--- {name} enabled, others stopped ---")
    except Exception as exc:  # noqa: BLE001
        _vpn_state["error"] = str(exc)
        _vlog(f"ERROR: {exc}")
    finally:
        _vpn_state["running"] = False


class VpnInstallRequest(BaseModel):
    name: str
    network_id: Optional[str] = None   # ZeroTier network to join


@app.post("/api/system/vpn/install")
def install_vpn(req: VpnInstallRequest, _: str = Depends(require_auth)):
    import threading
    if req.name not in _VPN_UNITS:
        raise HTTPException(400, f"Unknown VPN: {req.name}")
    with _vpn_lock:
        if _vpn_state["running"]:
            raise HTTPException(409, "A VPN install is already running")
        _vpn_state.update(running=True, name=req.name, auth_url=None, error=None)
    threading.Thread(target=_vpn_install_worker, args=(req.name, req.network_id),
                     daemon=True, name="vpn-install").start()
    return {"status": "installing", "name": req.name}


@app.get("/api/system/vpn/status")
def vpn_status(_: str = Depends(require_auth)):
    active = None
    for name, (_tool, unit) in _VPN_UNITS.items():
        if _sysctl("is-active", unit) == "active":
            active = name
            break
    log = ""
    if VPN_LOG.exists():
        try:
            log = "\n".join(VPN_LOG.read_text().splitlines()[-30:])
        except OSError:
            pass
    return {**_vpn_state, "active": active, "log": log}


class BootDriveRequest(BaseModel):
    enabled: bool


@app.post("/api/system/boot-drive")
def toggle_boot_drive(req: BootDriveRequest, _: str = Depends(require_auth)):
    """Show/hide the live system (boot) drive as a writable drive. Off by default."""
    from drives import detect, hotplug
    detect.INCLUDE_SYSTEM = req.enabled
    hotplug._refresh()
    return {"enabled": req.enabled}


_assets_dir = DEV_UI_PATH / "assets"
if _assets_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")


@app.get("/", include_in_schema=False)
def serve_ui():
    ui = DEV_UI_PATH / "index.html"
    if ui.exists():
        return FileResponse(ui)
    return JSONResponse({"message": "LiteLayer API — dev UI not present"})
