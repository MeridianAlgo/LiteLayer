import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.config import CORS_ORIGINS, COOKIE_SECURE, DEV_UI_PATH, SESSION_TTL_HOURS
from app.deps import require_auth
from app.routers import drives, files, ota, programs
from auth import sessions, store as auth_store, devices, twofa
from app import audit, throttle

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

from urllib.parse import urlparse

# Hosts allowed to make cookie-authenticated, state-changing requests (CSRF guard).
_ALLOWED_ORIGIN_HOSTS = {urlparse(o).netloc for o in CORS_ORIGINS}


@app.middleware("http")
async def _security_and_cache(request: Request, call_next):
    # CSRF: a cross-site page can't read our token, but it can ride the session cookie
    # on a state-changing request. Reject those unless the Origin is us (or an allowed
    # dev origin). Bearer-token callers carry no cookie and set Origin themselves, so
    # they're unaffected; cookie-less requests (no session to abuse) pass through.
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.cookies.get("litelayer_session") \
            and not (request.headers.get("authorization", "").startswith("Bearer ")):
        # When a browser sends Origin/Referer (always, on a cross-site fetch), reject a
        # mismatch. A missing header is left to pass: non-browser cookie clients omit it,
        # and SameSite=Lax already stops a cross-site page from having the cookie sent.
        origin = request.headers.get("origin") or request.headers.get("referer")
        host = urlparse(origin).netloc if origin else ""
        if host and host != request.url.netloc and host not in _ALLOWED_ORIGIN_HOSTS:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Cross-origin request blocked"}, status_code=403)

    resp = await call_next(request)
    # Defense in depth: Caddy sets these, but the Cloudflare Tunnel path proxies
    # straight to localhost:8000 and never sees Caddy — so set them here too.
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    # Pragmatic CSP: the UI relies on inline handlers/styles and a few CDN scripts
    # (xterm, viewers) + Google Fonts, so 'unsafe-inline'/https: stay for now. Still
    # blocks plugins, framing and <base> hijacking. Upgrade path: vendor the CDN
    # assets and drop the inline-handler attributes, then tighten to 'self'.
    resp.headers.setdefault("Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' https:; "
        "style-src 'self' 'unsafe-inline' https:; font-src 'self' https: data:; "
        "img-src 'self' data: blob: https:; connect-src 'self' https: wss:; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
    # Never cache the dev UI — otherwise the browser keeps stale JS after an update
    # (e.g. new index.html referencing a function the old cached JS lacks).
    p = request.url.path
    if p == "/" or p.startswith("/assets"):
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    return resp


app.include_router(drives.router)
app.include_router(files.router)
app.include_router(ota.router)
app.include_router(programs.router)
app.include_router(programs.proxy)   # /apps/<name>/ — global web access to programs


class LoginRequest(BaseModel):
    username: str
    password: str
    code: Optional[str] = None   # TOTP 2FA code, when the account has 2FA on


import time as _time


from app.netutil import client_ip as _client_ip   # single non-spoofable source of truth


def _is_https(request: Request) -> bool:
    """True when the client reached us over TLS — directly or via Caddy/the tunnel."""
    return request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https" \
        or request.url.scheme == "https"


def _device_label(request: Request) -> str:
    """A human label for a device, guessed from its user-agent (best-effort)."""
    ua = request.headers.get("user-agent", "")
    osys = next((n for k, n in (
        ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"),
        ("Windows", "Windows"), ("Mac", "macOS"), ("Linux", "Linux")) if k in ua), "Device")
    br = next((n for k, n in (
        ("Edg", "Edge"), ("OPR", "Opera"), ("Firefox", "Firefox"),
        ("Chrome", "Chrome"), ("Safari", "Safari")) if k in ua), "")
    return f"{br} on {osys}".strip() if br else osys


@app.post("/api/login")
def login(req: LoginRequest, request: Request, response: Response):
    ip = _client_ip(request)
    secure = COOKIE_SECURE or _is_https(request)

    wait = throttle.retry_after(f"login:{ip}")
    if wait:
        raise HTTPException(429, f"Too many failed logins. Try again in {wait // 60 + 1} min.")
    if not auth_store.verify_password(req.username, req.password):
        throttle.record_failure(f"login:{ip}")
        audit.log("login.fail", user=req.username, ip=ip, detail="bad password")
        raise HTTPException(401, "Invalid credentials")

    # Second factor, if the account has it on. Done before the device gate so a
    # missing code can't be used to probe device-trust state.
    if twofa.is_enabled(req.username) and not twofa.verify(req.username, req.code or ""):
        if not req.code:
            raise HTTPException(401, "2fa_required")          # UI shows the code field
        throttle.record_failure(f"login:{ip}")
        audit.log("login.fail", user=req.username, ip=ip, detail="bad 2FA code")
        raise HTTPException(401, "Invalid 2FA code")

    # Trusted-device gate: even with the right password, an unrecognized device is
    # refused when enforcement is on. After the password so it can't probe which
    # devices exist.
    device_id = request.cookies.get("ll_device")
    if devices.enforce_enabled() and not devices.is_trusted(device_id):
        audit.log("login.blocked", user=req.username, ip=ip, detail="untrusted device")
        raise HTTPException(
            403,
            "This device isn't approved to sign in. Approve it from a trusted device, "
            "or turn off the trusted-device restriction in Settings.",
        )
    if not device_id:
        device_id = devices.new_id()
        response.set_cookie(
            key="ll_device", value=device_id, httponly=True, samesite="lax",
            secure=secure, max_age=365 * 24 * 3600,
        )
    devices.remember(device_id, _device_label(request), ip)

    throttle.clear(f"login:{ip}")
    token = sessions.create_session(req.username, device=device_id, ip=ip)
    audit.log("login.ok", user=req.username, ip=ip)
    response.set_cookie(
        key="litelayer_session",
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure,   # auto-on over HTTPS/tunnel; LITELAYER_COOKIE_SECURE=1 forces it
        max_age=SESSION_TTL_HOURS * 3600,
    )
    return {"token": token, "username": req.username}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get("litelayer_session")
    if token:
        user = sessions.validate_session(token)
        sessions.delete_session(token)
        if user:
            audit.log("logout", user=user, ip=_client_ip(request))
    response.delete_cookie("litelayer_session")
    return {"status": "ok"}


@app.get("/api/me")
def me(username: str = Depends(require_auth)):
    """Quick auth check — 401 if not logged in, username otherwise."""
    return {"username": username}


# ── Trusted devices ───────────────────────────────────────────────────────────
# An allowlist of devices that may sign in. See auth/devices.py.

@app.get("/api/devices")
def list_devices(request: Request, _: str = Depends(require_auth)):
    return devices.listing(request.cookies.get("ll_device"))


class EnforceRequest(BaseModel):
    enabled: bool


@app.post("/api/devices/enforce")
def set_devices_enforce(req: EnforceRequest, request: Request, username: str = Depends(require_auth)):
    # Don't let someone lock themselves out: this device must be trusted before
    # we start refusing every untrusted one.
    if req.enabled and not devices.is_trusted(request.cookies.get("ll_device")):
        raise HTTPException(400, "Sign in once on this device first so it's on the trusted list.")
    devices.set_enforce(req.enabled)
    audit.log("devices.enforce", user=username, ip=_client_ip(request),
              detail="on" if req.enabled else "off")
    return {"enforce": req.enabled}


class DeviceLabelRequest(BaseModel):
    label: str


@app.post("/api/devices/{device_id}/rename")
def rename_device(device_id: str, req: DeviceLabelRequest, _: str = Depends(require_auth)):
    if not devices.rename(device_id, req.label.strip()):
        raise HTTPException(404, "Device not found")
    return {"status": "ok"}


@app.delete("/api/devices/{device_id}")
def remove_device(device_id: str, request: Request, username: str = Depends(require_auth)):
    # Removing the device you're on while enforcement is on would lock you out.
    if device_id == request.cookies.get("ll_device") and devices.enforce_enabled():
        raise HTTPException(400, "Can't remove the device you're using while the restriction is on.")
    devices.remove(device_id)
    audit.log("devices.remove", user=username, ip=_client_ip(request), detail=device_id[:8])
    return {"status": "ok"}


# ── Sessions, 2FA, audit ──────────────────────────────────────────────────────

@app.get("/api/sessions")
def list_sessions(request: Request, username: str = Depends(require_auth)):
    token = request.cookies.get("litelayer_session") or ""
    return {"sessions": sessions.list_for_user(username, token)}


@app.post("/api/auth/signout-others")
def signout_others(request: Request, username: str = Depends(require_auth)):
    token = request.cookies.get("litelayer_session") or ""
    n = sessions.delete_others(username, token)
    audit.log("session.signout_others", user=username, ip=_client_ip(request), detail=f"{n} ended")
    return {"ended": n}


@app.get("/api/auth/2fa")
def twofa_status(username: str = Depends(require_auth)):
    return {"enabled": twofa.is_enabled(username)}


class PasswordOnly(BaseModel):
    password: str


@app.post("/api/auth/2fa/setup")
def twofa_setup(req: PasswordOnly, username: str = Depends(require_auth)):
    if not auth_store.verify_password(username, req.password):
        raise HTTPException(401, "Password incorrect")
    if twofa.is_enabled(username):
        raise HTTPException(409, "2FA is already on")
    return twofa.begin_setup(username)


class CodeOnly(BaseModel):
    code: str


@app.post("/api/auth/2fa/confirm")
def twofa_confirm(req: CodeOnly, request: Request, username: str = Depends(require_auth)):
    if not twofa.confirm(username, req.code):
        raise HTTPException(400, "That code didn't match — try the current one.")
    audit.log("2fa.enabled", user=username, ip=_client_ip(request))
    return {"enabled": True}


@app.post("/api/auth/2fa/disable")
def twofa_disable(req: PasswordOnly, request: Request, username: str = Depends(require_auth)):
    if not auth_store.verify_password(username, req.password):
        raise HTTPException(401, "Password incorrect")
    twofa.disable(username)
    audit.log("2fa.disabled", user=username, ip=_client_ip(request))
    return {"enabled": False}


@app.get("/api/audit")
def get_audit(_: str = Depends(require_auth)):
    return {"events": audit.recent(100)}


# ── Cross-device UI settings (encrypted at rest) ──────────────────────────────
# The browser owns the live copy in localStorage; this is the synced copy so a
# second device pulls the same theme/look on login. See app/settings_store.py.
from app import settings_store


@app.get("/api/settings")
def get_settings(_: str = Depends(require_auth)):
    return {"settings": settings_store.load()}


class SettingsRequest(BaseModel):
    settings: dict


@app.put("/api/settings")
def put_settings(req: SettingsRequest, _: str = Depends(require_auth)):
    # Cap size so a hijacked session can't write an unbounded blob to disk.
    if len(json.dumps(req.settings)) > 64_000:
        raise HTTPException(413, "Settings payload too large")
    settings_store.save(req.settings)
    return {"status": "ok"}


class UpdateCredentialsRequest(BaseModel):
    current_password: str
    new_username: Optional[str] = None
    new_password: Optional[str] = None


@app.post("/api/auth/update-credentials")
def update_credentials(req: UpdateCredentialsRequest, request: Request, username: str = Depends(require_auth)):
    if not auth_store.verify_password(username, req.current_password):
        raise HTTPException(401, "Current password is incorrect")
    audit.log("credentials.update", user=username, ip=_client_ip(request))
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

    cf_domain = _cloudflare_domain() if any(v["name"] == "Cloudflare Tunnel" for v in vpns) else None
    return {"hostname": hostname, "vpns": vpns, "cloudflare_domain": cf_domain}


def _cloudflare_domain() -> "str | None":
    """The Cloudflare Tunnel's public hostname — a named tunnel's config hostname,
    else the quick-tunnel *.trycloudflare.com URL from the service journal."""
    import re, subprocess
    for cfg in ("/etc/cloudflared/config.yml", "/etc/cloudflared/config.yaml"):
        try:
            m = re.search(r"hostname:\s*([\w.-]+)", Path(cfg).read_text())
            if m:
                return m.group(1)
        except Exception:
            pass
    try:
        out = subprocess.run(["journalctl", "-u", "litelayer-cloudflare", "--no-pager", "-n", "200"],
                             capture_output=True, text=True, timeout=5).stdout
        urls = re.findall(r"https://[\w.-]+\.trycloudflare\.com", out)
        if urls:
            return urls[-1]
    except Exception:
        pass
    return None


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
    """Disable + stop every VPN except the chosen one. Switching is exclusive —
    one VPN at a time — so the System/About pages never show a stale 'in use'
    (e.g. ZeroTier left running after you switch to the Cloudflare Tunnel)."""
    import subprocess
    units = {name: unit for name, (_tool, unit) in _VPN_UNITS.items()}
    units["Cloudflare Tunnel"] = "litelayer-cloudflare"
    for name, unit in units.items():
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
        # ponytail: install the .deb straight from GitHub releases keyed off arch.
        # The apt repo (pkg.cloudflare.com) only ships a few codenames and has no
        # Release file for e.g. Debian trixie / Raspberry Pi OS, so it breaks there.
        'ARCH=$(dpkg --print-architecture); case "$ARCH" in armhf) A=arm;; i386) A=386;; *) A=$ARCH;; esac; '
        'curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A.deb" && '
        'apt-get install -y /tmp/cloudflared.deb && rm -f /tmp/cloudflared.deb',
    ],
    "WireGuard":          ["apt-get install -y --no-install-recommends wireguard wireguard-tools"],
}
# Command that produces a sign-in URL (run detached; we scrape its output).
_VPN_SIGNIN = {
    "Tailscale": "tailscale up --accept-routes",
}
_AUTH_URL_RE = _re.compile(r"https://(?:login\.tailscale\.com|[\w.-]*netbird[\w.-]*|[\w.-]*trycloudflare\.com)\S*")

_vpn_state = {"running": False, "name": None, "auth_url": None, "error": None, "started": 0.0}
_vpn_lock = __import__("threading").Lock()


def _vpn_busy() -> bool:
    """True if a VPN worker is genuinely still running. A worker can never run
    longer than its 600s subprocess timeout, so anything older is a stale flag
    (e.g. the app restarted mid-op) — clear it so the UI isn't wedged on 409."""
    import time
    if not _vpn_state["running"]:
        return False
    if time.time() - _vpn_state.get("started", 0) > 600:
        _vpn_state["running"] = False
        return False
    return True


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
        if _vpn_busy():
            raise HTTPException(409, "A VPN operation is already running")
        _vpn_state.update(running=True, name=req.name, auth_url=None, error=None, started=__import__("time").time())
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
    # A ZeroTier network id is exactly 16 hex chars; reject anything else so it
    # can't smuggle flags/args into the `zerotier-cli join` call.
    if req.network_id and not _re.fullmatch(r"[0-9a-fA-F]{16}", req.network_id):
        raise HTTPException(400, "Invalid ZeroTier network ID (expected 16 hex characters)")
    with _vpn_lock:
        if _vpn_busy():
            raise HTTPException(409, "A VPN install is already running")
        _vpn_state.update(running=True, name=req.name, auth_url=None, error=None, started=__import__("time").time())
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


# ── Cloudflare Tunnel: one-click public URL ───────────────────────────────────
# The only VPN safe to fully drive from the UI: it's an outbound connection, so
# it can never break the LAN/SSH path the way flipping Tailscale/WireGuard can.
# Enabling it is an exclusive switch like the others — any mesh VPN is stopped.
# Two modes — a free quick tunnel (random *.trycloudflare.com, no account) or a
# named tunnel run from a token you paste from the Cloudflare dashboard (your own
# stable domain). We (re)write the unit each enable so the token mode always works
# even on an older installed copy.
CF_UNIT = Path("/etc/systemd/system/litelayer-cloudflare.service")
CF_ENV = Path("/etc/litelayer/cloudflare.env")
_CF_TOKEN_RE = _re.compile(r"^[A-Za-z0-9_\-./+=]{20,3000}$")
_CF_UNIT_TEMPLATE = """\
[Unit]
Description=LiteLayer Cloudflare Tunnel
After=network-online.target litelayer.service
Wants=network-online.target
Requires=litelayer.service

[Service]
Type=simple
Environment="CF_TUNNEL_ARGS=--url http://localhost:8000"
EnvironmentFile=-/etc/litelayer/cloudflare.env
ExecStart=/usr/bin/cloudflared tunnel $CF_TUNNEL_ARGS
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=litelayer-cloudflare

[Install]
WantedBy=multi-user.target
"""


def _cf_mode() -> "str | None":
    """'token' if a named-tunnel token is configured, else 'quick' if the unit is
    enabled, else None."""
    if not _sysctl("is-enabled", "litelayer-cloudflare") == "enabled" \
       and not _sysctl("is-active", "litelayer-cloudflare") == "active":
        return None
    try:
        if "--token" in CF_ENV.read_text():
            return "token"
    except OSError:
        pass
    return "quick"


def _cf_configure(mode: str, token: "str | None") -> None:
    """Write the unit + env for the chosen mode, then (re)start it."""
    import subprocess
    CF_UNIT.write_text(_CF_UNIT_TEMPLATE)
    CF_ENV.parent.mkdir(parents=True, exist_ok=True)
    if mode == "token":
        # Token goes into an env file (never a shell), and is charset-validated by
        # the caller — so it can't smuggle extra args or a newline into the unit.
        CF_ENV.write_text(f"CF_TUNNEL_ARGS=run --token {token}\n")
    else:
        try:
            CF_ENV.unlink()
        except FileNotFoundError:
            pass
    _sysctl("daemon-reload")
    subprocess.run(["systemctl", "enable", "--now", "litelayer-cloudflare"],
                   capture_output=True, text=True)


def _cf_enable_worker(mode: str, token: "str | None") -> None:
    import os, subprocess, datetime, time
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    try:
        _vlog(f"\n--- cloudflare enable ({mode}) {datetime.datetime.now().isoformat(timespec='seconds')} ---")
        if not _vpn_installed(*_VPN_UNITS["Cloudflare Tunnel"]):
            for cmd in _VPN_INSTALL["Cloudflare Tunnel"]:
                _vlog(f"$ {cmd}")
                r = subprocess.run("set -o pipefail; " + cmd, shell=True, executable="/bin/bash",
                                   capture_output=True, text=True, timeout=600, env=env)
                _vlog(r.stdout + r.stderr)
                if r.returncode != 0:
                    tail = (r.stderr or r.stdout or "").strip().splitlines()[-4:]
                    _vpn_state["error"] = "cloudflared install failed: " + " | ".join(tail)
                    return
        _cf_configure(mode, token)
        _stop_other_vpns("Cloudflare Tunnel")   # exclusive switch — turn mesh VPNs off
        # The tunnel takes a few seconds to connect. Wait for the unit to go active
        # (quick mode also waits for the *.trycloudflare.com URL to hit the journal),
        # so the UI gets a real answer instead of giving up mid-startup.
        for _ in range(30):
            time.sleep(1)
            if _sysctl("is-active", "litelayer-cloudflare") == "active" \
               and (mode != "quick" or _cloudflare_domain()):
                break
        # If it still isn't up, surface the journal tail so the user sees *why*
        # rather than a toggle that silently stays off with no link.
        if _sysctl("is-active", "litelayer-cloudflare") != "active":
            jr = subprocess.run(["journalctl", "-u", "litelayer-cloudflare", "--no-pager", "-n", "15"],
                                capture_output=True, text=True).stdout
            tail = " | ".join(jr.strip().splitlines()[-6:])
            _vpn_state["error"] = "Cloudflare tunnel didn't start: " + (tail or "run: journalctl -u litelayer-cloudflare")
        _vlog("--- cloudflare tunnel enabled ---")
    except Exception as exc:  # noqa: BLE001
        _vpn_state["error"] = str(exc)
        _vlog(f"ERROR: {exc}")
    finally:
        _vpn_state["running"] = False


@app.get("/api/system/cloudflare")
def cloudflare_status(_: str = Depends(require_auth)):
    return {
        "installed": _vpn_installed(*_VPN_UNITS["Cloudflare Tunnel"]),
        "active": _sysctl("is-active", "litelayer-cloudflare") == "active",
        "mode": _cf_mode(),
        "url": _cloudflare_domain(),
    }


class CloudflareRequest(BaseModel):
    action: str                       # "enable" | "disable"
    mode: str = "quick"               # "quick" | "token"
    token: Optional[str] = None       # required for token mode


@app.post("/api/system/cloudflare")
def cloudflare_set(req: CloudflareRequest, _: str = Depends(require_auth)):
    import subprocess, threading
    if req.action == "disable":
        subprocess.run(["systemctl", "disable", "--now", "litelayer-cloudflare"],
                       capture_output=True, text=True)
        return {"status": "disabled"}
    if req.action != "enable":
        raise HTTPException(400, "action must be 'enable' or 'disable'")
    mode = req.mode if req.mode in ("quick", "token") else "quick"
    token = (req.token or "").strip()
    if mode == "token":
        if not _CF_TOKEN_RE.fullmatch(token):
            raise HTTPException(400, "That doesn't look like a Cloudflare tunnel token. Copy it from the dashboard's 'Install and run a connector' command.")
    else:
        token = None
    with _vpn_lock:
        if _vpn_busy():
            raise HTTPException(409, "A VPN operation is already running")
        _vpn_state.update(running=True, name="Cloudflare Tunnel", auth_url=None, error=None, started=__import__("time").time())
    threading.Thread(target=_cf_enable_worker, args=(mode, token),
                     daemon=True, name="cf-enable").start()
    return {"status": "enabling", "mode": mode}


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


class ResetRequest(BaseModel):
    password: Optional[str] = None


@app.post("/api/system/reset")
def system_reset(req: ResetRequest, username: str = Depends(require_auth)):
    """Re-run the installer for a fresh latest LiteLayer, then reboot the Pi.
    Password-gated — a reboot + reinstall is too destructive to fire on one click."""
    if not auth_store.verify_password(username, req.password or ""):
        raise HTTPException(401, "Password is required to reset LiteLayer")
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
# The root shell is the app's biggest attack surface, so it can be switched off
# entirely from Settings. Re-enabling requires the account password (an attacker
# with a hijacked session still can't flip it back on without the password).
from drives import persist as _persist


@app.get("/api/system/terminal/status")
def terminal_status(_: str = Depends(require_auth)):
    return {"enabled": _persist.is_terminal_enabled()}


class TerminalToggleRequest(BaseModel):
    enabled: bool
    password: Optional[str] = None   # required only to re-enable


@app.post("/api/system/terminal/toggle")
def terminal_toggle(req: TerminalToggleRequest, request: Request, username: str = Depends(require_auth)):
    # Re-enabling is the sensitive direction — gate it behind the password.
    if req.enabled and not auth_store.verify_password(username, req.password or ""):
        raise HTTPException(401, "Password required to re-enable the terminal")
    _persist.set_terminal_enabled(req.enabled)
    audit.log("terminal.toggle", user=username, ip=_client_ip(request),
              detail="on" if req.enabled else "off")
    return {"enabled": req.enabled}


# Short-lived, single-use tickets to open the root shell. Opening it requires a fresh
# password (re-auth), so a hijacked session alone can't drop into a root shell.
_terminal_tickets: dict[str, float] = {}


@app.post("/api/system/terminal/ticket")
def terminal_ticket(req: PasswordOnly, request: Request, username: str = Depends(require_auth)):
    if not _persist.is_terminal_enabled():
        raise HTTPException(403, "Terminal is disabled")
    if not auth_store.verify_password(username, req.password):
        raise HTTPException(401, "Password incorrect")
    import secrets as _secrets
    now = _time.time()
    for t in [t for t, exp in _terminal_tickets.items() if exp <= now]:
        del _terminal_tickets[t]
    ticket = _secrets.token_hex(16)
    _terminal_tickets[ticket] = now + 30        # 30s to open the socket
    audit.log("terminal.open", user=username, ip=_client_ip(request))
    return {"ticket": ticket}


# A real PTY bridged over a websocket. Opening requires a one-time ticket (above) on
# top of a valid session, so re-auth is enforced even though a WS can't carry headers.
# Linux-only — uses os/pty.
# ponytail: shell runs as whatever user runs LiteLayer; this is the same
# privilege level the app already wields (remount, reset, boot-drive).
@app.websocket("/api/system/terminal")
async def terminal_ws(ws: WebSocket, token: str = Query(default=""), ticket: str = Query(default="")):
    import asyncio
    # Prefer the same-origin session cookie so the token never has to ride in the URL
    # (URLs leak into logs/history). The query token stays as a fallback for a
    # cross-origin API client that can't send the cookie.
    sess = token or ws.cookies.get("litelayer_session", "")
    if not sessions.validate_session(sess):
        await ws.close(code=4401)
        return
    # A cookie session is device-bound, same as deps.require_auth — a cookie lifted
    # to another device is refused. (The query-token path is an explicit API secret.)
    if not token:
        bound = sessions.session_device(sess)
        if bound and bound != ws.cookies.get("ll_device"):
            await ws.close(code=4401)
            return
    if _terminal_tickets.pop(ticket, 0) < _time.time():   # missing/expired → reject
        await ws.close(code=4401)
        return
    if not _persist.is_terminal_enabled():
        await ws.accept()
        await ws.send_text("\r\nTerminal is disabled. Re-enable it in Settings → System.\r\n")
        await ws.close(code=4403)
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
