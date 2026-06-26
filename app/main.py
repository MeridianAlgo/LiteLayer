import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
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

@app.middleware("http")
async def _no_cache_ui(request: Request, call_next):
    """Never cache the dev UI — otherwise the browser keeps stale JS after an
    update (e.g. new index.html referencing a function the old cached JS lacks)."""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.startswith("/assets"):
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    return resp


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


# ── Live CPU / temp / power for the header pills ──────────────────────────────
_cpu_prev = {"total": 0, "idle": 0}


def _cpu_percent() -> float | None:
    """Busy % since the last call, from /proc/stat. First call returns None."""
    try:
        parts = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
        nums = [int(x) for x in parts]
        total, idle = sum(nums), nums[3] + (nums[4] if len(nums) > 4 else 0)
        dt, di = total - _cpu_prev["total"], idle - _cpu_prev["idle"]
        _cpu_prev["total"], _cpu_prev["idle"] = total, idle
        if dt <= 0:
            return None
        return round((1 - di / dt) * 100, 1)
    except Exception:
        return None


def _cpu_temp() -> float | None:
    try:
        return round(int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000, 1)
    except Exception:
        return None


def _vcgencmd(*args: str) -> str:
    """Run vcgencmd, resolving its path — the systemd unit's PATH may not include
    /usr/bin, which would make every call silently fail (e.g. blank power pill)."""
    import shutil, subprocess
    exe = shutil.which("vcgencmd") or "/usr/bin/vcgencmd"
    return subprocess.run([exe, *args], capture_output=True, text=True, timeout=3).stdout


def _undervoltage() -> bool:
    """Pi power health: bit 0 of vcgencmd get_throttled = under-voltage now."""
    try:
        val = int(_vcgencmd("get_throttled").strip().split("=")[1], 16)
        return bool(val & 0x1)
    except Exception:
        return False


def _power_watts() -> float | None:
    """Total board draw in watts, summed across the Pi 5 PMIC rails (volts × amps).
    Returns None on Pi 4 / older where pmic_read_adc isn't available."""
    import re
    try:
        out = _vcgencmd("pmic_read_adc")
    except Exception:
        return None
    volts: dict[str, float] = {}
    amps: dict[str, float] = {}
    # lines like "VDD_CORE_A current(7)=2.48A" / "VDD_CORE_V volt(8)=0.72V"
    for rail, kind, val in re.findall(r"(\w+?)_([AV])\s+\w+\(\d+\)=([\d.]+)", out):
        (amps if kind == "A" else volts)[rail] = float(val)
    watts = sum(volts[r] * amps[r] for r in amps if r in volts)
    return round(watts, 1) if watts else None


@app.get("/api/system/stats")
def system_stats(_: str = Depends(require_auth)):
    return {"cpu_percent": _cpu_percent(), "temp_c": _cpu_temp(),
            "watts": _power_watts(), "undervoltage": _undervoltage()}


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

    # ZeroTier (zt*) and WireGuard (wg*) — match by interface name. WireGuard
    # links report state UNKNOWN (not UP), so don't gate on UP or it shows "None"
    # while a tunnel is actually connected.
    code, out = _run(["ip", "-brief", "addr"])
    if code == 0:
        for line in out.splitlines():
            parts = line.split()
            if not parts:
                continue
            iface = parts[0].split("@")[0]
            name = "ZeroTier" if iface.startswith("zt") else "WireGuard" if re.match(r"wg\d*$", iface) else None
            if not name:
                continue
            ip = next((p.split("/")[0] for p in parts[2:] if "." in p), None)
            vpns.append({"name": name, "ip": ip})

    # Cloudflare Tunnel — cloudflared process
    code, _ = _run(["pgrep", "-x", "cloudflared"], timeout=3)
    if code == 0:
        vpns.append({"name": "Cloudflare Tunnel", "ip": None})

    # Also trust systemd: any VPN unit that's active counts even if we couldn't
    # spot its interface — keeps this in sync with the System tab (which is why
    # ZeroTier showed there but "None" here).
    present = {v["name"] for v in vpns}
    for name, (_tool, unit) in _VPN_UNITS.items():
        if name not in present and _sysctl("is-active", unit) == "active":
            vpns.append({"name": name, "ip": None})

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
    import os, subprocess
    if req.name not in _VPN_UNITS:
        raise HTTPException(400, f"Unknown VPN: {req.name}")
    tool, unit = _VPN_UNITS[req.name]
    if not _vpn_installed(tool, unit):
        raise HTTPException(409, f"{req.name} is not installed on this device")
    # WireGuard can't start without a tunnel config — fail with a clear message
    # instead of a raw systemd 500.
    if req.name == "WireGuard" and not os.path.exists("/etc/wireguard/wg0.conf"):
        raise HTTPException(409, "WireGuard needs /etc/wireguard/wg0.conf — add a tunnel config first (see docs/vpn.md).")
    r = subprocess.run(["systemctl", "enable", "--now", unit], capture_output=True, text=True)
    if r.returncode != 0:
        detail = (r.stderr or r.stdout or "").strip()
        status = _sysctl("status", unit, "--no-pager", "-n", "20")
        raise HTTPException(500, f"Could not start {req.name}: {detail}\n\n{status[-800:]}")
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
    import os, subprocess, datetime
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    try:
        _vlog(f"\n--- install {name} {datetime.datetime.now().isoformat(timespec='seconds')} ---")
        for cmd in _VPN_INSTALL.get(name, []):
            _vlog(f"$ {cmd}")
            r = subprocess.run("set -o pipefail; " + cmd, shell=True, executable="/bin/bash",
                               capture_output=True, text=True, timeout=600, env=env)
            _vlog(r.stdout + r.stderr)
            if r.returncode != 0:
                tail = (r.stderr or r.stdout or "").strip().splitlines()[-4:]
                _vpn_state["error"] = f"Install failed (exit {r.returncode}): " + " | ".join(tail)
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


# Shell steps to fully remove each VPN.
_VPN_UNINSTALL = {
    "Tailscale":          ["tailscale down || true", "apt-get remove -y tailscale || true"],
    "ZeroTier":           ["apt-get remove -y zerotier-one || true"],
    "Cloudflare Tunnel":  ["rm -f /etc/systemd/system/litelayer-cloudflare.service", "systemctl daemon-reload", "apt-get remove -y cloudflared || true"],
    "WireGuard":          ["apt-get remove -y wireguard wireguard-tools || true"],
}


def _vpn_uninstall_worker(name: str) -> None:
    import os, subprocess, datetime
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    tool, unit = _VPN_UNITS[name]
    try:
        _vlog(f"\n--- uninstall {name} {datetime.datetime.now().isoformat(timespec='seconds')} ---")
        subprocess.run(["systemctl", "disable", "--now", unit], capture_output=True, text=True)
        for cmd in _VPN_UNINSTALL.get(name, []):
            _vlog(f"$ {cmd}")
            r = subprocess.run(cmd, shell=True, executable="/bin/bash",
                               capture_output=True, text=True, timeout=300, env=env)
            _vlog(r.stdout + r.stderr)
        _vlog(f"--- {name} removed ---")
    except Exception as exc:  # noqa: BLE001
        _vpn_state["error"] = f"Uninstall error: {exc}"
        _vlog(f"ERROR: {exc}")
    finally:
        _vpn_state["running"] = False


class VpnNameRequest(BaseModel):
    name: str


@app.post("/api/system/vpn/uninstall")
def uninstall_vpn(req: VpnNameRequest, _: str = Depends(require_auth)):
    import threading
    if req.name not in _VPN_UNITS:
        raise HTTPException(400, f"Unknown VPN: {req.name}")
    with _vpn_lock:
        if _vpn_state["running"]:
            raise HTTPException(409, "A VPN operation is already running")
        _vpn_state.update(running=True, name=req.name, auth_url=None, error=None)
    threading.Thread(target=_vpn_uninstall_worker, args=(req.name,),
                     daemon=True, name="vpn-uninstall").start()
    return {"status": "uninstalling", "name": req.name}


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
    import subprocess
    active = None
    for name, (_tool, unit) in _VPN_UNITS.items():
        if _sysctl("is-active", unit) == "active":
            active = name
            break
    # ZeroTier node id — handy when wiring the laptop to the same network.
    zt_node = None
    if _vpn_installed(*_VPN_UNITS["ZeroTier"]):
        try:
            out = subprocess.run(["zerotier-cli", "info"], capture_output=True, text=True, timeout=5).stdout.split()
            if len(out) >= 3:
                zt_node = out[2]
        except Exception:
            pass
    log = ""
    if VPN_LOG.exists():
        try:
            log = "\n".join(VPN_LOG.read_text().splitlines()[-30:])
        except OSError:
            pass
    return {**_vpn_state, "active": active, "zt_node": zt_node, "log": log}


# ── Factory reset: wipe + reinstall the latest LiteLayer ──────────────────────
RESET_LOG = Path("/var/log/litelayer/reset.log")
_RESET_URL = "https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh"


def _reset_worker() -> None:
    import subprocess, datetime
    try:
        RESET_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(RESET_LOG, "a") as log:
            log.write(f"\n--- RESET + reinstall {datetime.datetime.now().isoformat()} ---\n")
            log.flush()
            # Fresh pull of the latest installer; pipefail so a 404 fails loudly.
            subprocess.run(
                f"set -o pipefail; curl -fsSL {_RESET_URL} | bash",
                shell=True, executable="/bin/bash",
                stdout=log, stderr=log, text=True, timeout=600,
            )
            log.write("--- reinstall done, rebooting ---\n")
        subprocess.run(["reboot"])
    except Exception:  # noqa: BLE001
        pass


@app.post("/api/system/reset")
def system_reset(_: str = Depends(require_auth)):
    """Re-run the installer for a fresh latest LiteLayer, then reboot the Pi."""
    import threading
    threading.Thread(target=_reset_worker, daemon=True, name="ll-reset").start()
    return {"status": "resetting"}


class BootDriveRequest(BaseModel):
    enabled: bool


@app.post("/api/system/boot-drive")
def toggle_boot_drive(req: BootDriveRequest, _: str = Depends(require_auth)):
    """Show/hide the live system (boot) drive as a writable drive. Off by default."""
    from drives import detect, hotplug
    detect.INCLUDE_SYSTEM = req.enabled
    hotplug._refresh()
    return {"enabled": req.enabled}


# ── Web terminal (interactive shell on the Pi) ────────────────────────────────
# A real PTY bridged over a websocket. Auth via the session token in the query
# string (browsers can't set headers on a WebSocket). Linux-only — uses os/pty.
# ponytail: shell runs as whatever user runs LiteLayer; this is the same
# privilege level the app already wields (remount, reset, boot-drive). Auth-gated.
@app.websocket("/api/system/terminal")
async def terminal_ws(ws: WebSocket, token: str = Query(default="")):
    import asyncio
    if not sessions.validate_session(token):
        await ws.close(code=4401)
        return
    try:
        import fcntl, json, os, pty, signal, struct, termios
    except ImportError:
        await ws.accept()
        await ws.send_text("\r\nTerminal is only available on the Raspberry Pi (Linux).\r\n")
        await ws.close()
        return

    await ws.accept()
    pid, fd = pty.fork()
    if pid == 0:  # child → become the shell
        os.environ["TERM"] = "xterm-256color"
        os.execvp("bash", ["bash", "-l"])
        os._exit(1)

    loop = asyncio.get_running_loop()

    def _on_master_readable():
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            loop.remove_reader(fd)
            asyncio.ensure_future(ws.close())
            return
        asyncio.ensure_future(ws.send_bytes(data))

    loop.add_reader(fd, _on_master_readable)
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if (b := msg.get("bytes")) is not None:
                os.write(fd, b)
            elif (t := msg.get("text")) is not None:
                # control messages are JSON: {"resize":[cols,rows]}
                if t.startswith('{"resize"'):
                    cols, rows = json.loads(t)["resize"]
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                else:
                    os.write(fd, t.encode())
    except WebSocketDisconnect:
        pass
    finally:
        loop.remove_reader(fd)
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except OSError:
            pass
        os.close(fd)


_assets_dir = DEV_UI_PATH / "assets"
if _assets_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")


@app.get("/", include_in_schema=False)
def serve_ui():
    ui = DEV_UI_PATH / "index.html"
    if ui.exists():
        return FileResponse(ui)
    return JSONResponse({"message": "LiteLayer API — dev UI not present"})
