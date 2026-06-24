"""
OTA update system — checks GitHub for new commits, applies updates in the background.
"""
import threading
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.deps import require_auth

router = APIRouter(prefix="/api/ota", tags=["ota"])

INSTALL_DIR  = Path("/opt/litelayer")
UPDATE_LOG   = Path("/var/log/litelayer/update.log")
REPO_URL     = "https://github.com/MeridianAlgo/LiteLayer.git"
BRANCH       = "main"
INSTALL_URL  = "https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/install.sh"

_update_running = False
_update_lock    = threading.Lock()


def _run(cmd: list[str], cwd=None, timeout=30) -> tuple[int, str]:
    import subprocess
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
    return r.returncode, (r.stdout + r.stderr).strip()


def _current_version() -> str:
    f = INSTALL_DIR / "VERSION"
    return f.read_text().strip() if f.exists() else "unknown"


def _is_major_update(current_sha: Optional[str], latest_sha: Optional[str]) -> bool:
    """Heuristic: check if VERSION file changes between HEAD and origin/main."""
    if not current_sha or not latest_sha:
        return False
    code, out = _run(
        ["git", "-C", str(INSTALL_DIR), "diff", current_sha, f"origin/{BRANCH}", "--name-only"],
        timeout=10,
    )
    if code != 0:
        return False
    return "install.sh" in out or "requirements.txt" in out


def _sha(ref: str) -> str | None:
    code, out = _run(["git", "-C", str(INSTALL_DIR), "rev-parse", ref])
    return out[:40] if code == 0 and len(out) >= 7 else None


def _fetch() -> bool:
    code, _ = _run(
        ["git", "-C", str(INSTALL_DIR), "fetch", "origin", BRANCH, "--quiet"],
        timeout=20,
    )
    return code == 0


@router.get("/status")
def ota_status(_: str = Depends(require_auth)):
    reachable = _fetch()
    current = _sha("HEAD")
    latest  = _sha(f"origin/{BRANCH}") if reachable else None
    update_available = bool(current and latest and current != latest)
    return {
        "current_version":  _current_version(),
        "current_sha":      current[:8] if current else None,
        "latest_sha":       latest[:8]  if latest  else None,
        "update_available": update_available,
        "is_major":         _is_major_update(current, latest) if update_available else False,
        "update_running":   _update_running,
        "github_reachable": reachable,
        "changelog_url":    f"{REPO_URL.removesuffix('.git')}/commits/{BRANCH}",
    }


class UpdateRequest(BaseModel):
    reinstall: bool = False


def _do_update() -> None:
    global _update_running
    try:
        UPDATE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(UPDATE_LOG, "a") as log:
            import subprocess, datetime
            log.write(f"\n--- update started {datetime.datetime.now().isoformat()} ---\n")

            def run(cmd, **kw):
                r = subprocess.run(cmd, stdout=log, stderr=log, text=True, **kw)
                return r.returncode

            if run(["git", "-C", str(INSTALL_DIR), "pull", "origin", BRANCH]) != 0:
                log.write("git pull failed — aborting\n")
                return

            tag = f"applied-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
            run(["git", "-C", str(INSTALL_DIR), "tag", tag])
            log.write(f"--- tagged {tag} ---\n")

            run([str(INSTALL_DIR / "venv/bin/pip"), "install", "-q",
                 "-r", str(INSTALL_DIR / "requirements.txt")])

            log.write("--- restarting service ---\n")
            run(["systemctl", "restart", "litelayer"])
    finally:
        _update_running = False


def _do_reinstall() -> None:
    """Re-run the full installer — used for major updates."""
    global _update_running
    try:
        UPDATE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(UPDATE_LOG, "a") as log:
            import subprocess, datetime
            log.write(f"\n--- FULL REINSTALL started {datetime.datetime.now().isoformat()} ---\n")
            # curl the installer and pipe to bash (same as the one-liner)
            r = subprocess.run(
                f"curl -fsSL {INSTALL_URL} | bash",
                shell=True, stdout=log, stderr=log, text=True, timeout=300,
            )
            log.write(f"--- reinstall exit {r.returncode} ---\n")
    finally:
        _update_running = False


@router.post("/update")
def trigger_update(body: UpdateRequest = UpdateRequest(), _: str = Depends(require_auth)):
    global _update_running
    with _update_lock:
        if _update_running:
            raise HTTPException(409, "Update already in progress")
        _update_running = True

    target = _do_reinstall if body.reinstall else _do_update
    t = threading.Thread(target=target, daemon=True, name="ota-update")
    t.start()
    return {"status": "update_started", "logs_endpoint": "/api/ota/logs"}


@router.get("/logs")
def get_logs(lines: int = 100, _: str = Depends(require_auth)):
    if not UPDATE_LOG.exists():
        return {"logs": "No update history yet."}
    text = UPDATE_LOG.read_text().splitlines()
    return {"logs": "\n".join(text[-lines:])}
