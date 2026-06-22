"""
OTA update system — checks GitHub for new commits, applies updates in the background.
"""
import threading
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from app.deps import require_auth

router = APIRouter(prefix="/api/ota", tags=["ota"])

INSTALL_DIR = Path("/opt/litelayer")
UPDATE_LOG  = Path("/var/log/litelayer/update.log")
REPO_URL    = "https://github.com/MeridianAlgo-Developer/LiteLayer.git"
BRANCH      = "main"

_update_running = False
_update_lock    = threading.Lock()


def _run(cmd: list[str], cwd=None, timeout=30) -> tuple[int, str]:
    import subprocess
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
    return r.returncode, (r.stdout + r.stderr).strip()


def _current_version() -> str:
    f = INSTALL_DIR / "VERSION"
    return f.read_text().strip() if f.exists() else "unknown"


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
    return {
        "current_version":  _current_version(),
        "current_sha":      current[:8] if current else None,
        "latest_sha":       latest[:8]  if latest  else None,
        "update_available": bool(current and latest and current != latest),
        "update_running":   _update_running,
        "github_reachable": reachable,
        "changelog_url":    f"{REPO_URL.removesuffix('.git')}/commits/{BRANCH}",
    }


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

            run([str(INSTALL_DIR / "venv/bin/pip"), "install", "-q",
                 "-r", str(INSTALL_DIR / "requirements.txt")])

            log.write("--- restarting service ---\n")
            run(["systemctl", "restart", "litelayer"])
    finally:
        _update_running = False


@router.post("/update")
def trigger_update(_: str = Depends(require_auth)):
    global _update_running
    with _update_lock:
        if _update_running:
            raise HTTPException(409, "Update already in progress")
        _update_running = True

    t = threading.Thread(target=_do_update, daemon=True, name="ota-update")
    t.start()
    return {"status": "update_started", "logs_endpoint": "/api/ota/logs"}


@router.get("/logs")
def get_logs(lines: int = 100, _: str = Depends(require_auth)):
    if not UPDATE_LOG.exists():
        return {"logs": "No update history yet."}
    text = UPDATE_LOG.read_text().splitlines()
    return {"logs": "\n".join(text[-lines:])}
