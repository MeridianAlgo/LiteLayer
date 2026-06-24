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
    "Cloudflare Tunnel":  ("cloudflared",  "cloudflared"),
}


def _sysctl(*args: str) -> str:
    import subprocess
    try:
        return subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


@app.get("/api/system/vpns")
def list_vpns(_: str = Depends(require_auth)):
    import shutil
    out = []
    for name, (tool, unit) in _VPN_UNITS.items():
        if not shutil.which(tool):
            continue
        out.append({
            "name": name,
            "unit": unit,
            "enabled": _sysctl("is-enabled", unit) == "enabled",
            "active":  _sysctl("is-active", unit) == "active",
        })
    return {"vpns": out}


class VpnSwitchRequest(BaseModel):
    name: str


@app.post("/api/system/vpn/switch")
def switch_vpn(req: VpnSwitchRequest, _: str = Depends(require_auth)):
    """Make the chosen VPN the boot default (enable it, disable the others),
    then reboot the whole system so it comes up on the selected VPN."""
    import subprocess, threading
    if req.name not in _VPN_UNITS:
        raise HTTPException(400, f"Unknown VPN: {req.name}")
    chosen_unit = _VPN_UNITS[req.name][1]
    for name, (_tool, unit) in _VPN_UNITS.items():
        action = "enable" if name == req.name else "disable"
        subprocess.run(["systemctl", action, unit], capture_output=True, text=True)
    # Reboot shortly after responding so the client gets a reply first.
    threading.Timer(2.0, lambda: subprocess.run(["reboot"])).start()
    return {"status": "rebooting", "vpn": req.name, "unit": chosen_unit}


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
