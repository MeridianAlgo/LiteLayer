"""
OTA update system — checks GitHub for new commits, applies updates in the background.
"""
import json
import re
import threading
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.deps import require_auth

router = APIRouter(prefix="/api/ota", tags=["ota"])

INSTALL_DIR  = Path("/opt/litelayer")
UPDATE_LOG   = Path("/var/log/litelayer/update.log")
RESULT_FILE  = Path("/var/log/litelayer/last_update.json")
REPO_URL     = "https://github.com/MeridianAlgo/LiteLayer.git"
BRANCH       = "main"
# install.sh lives under installer/ — the old root path 404'd, which is why
# "Full Reinstall" silently did nothing (curl 404 → empty pipe → bash exit 0).
INSTALL_URL  = "https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh"

_update_running = False
_update_lock    = threading.Lock()


def _run(cmd: list[str], cwd=None, timeout=30) -> tuple[int, str]:
    import subprocess
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)
    return r.returncode, (r.stdout + r.stderr).strip()


def _current_version() -> str:
    # --match=v* skips applied-* local tags so only semantic version tags show
    code, out = _run(
        ["git", "-C", str(INSTALL_DIR), "describe", "--tags", "--always", "--match=v*"],
        timeout=5,
    )
    if code == 0 and out:
        out = out.lstrip("v")  # UI adds its own "v" — don't double it (vv0.1.0)
        # "0.1.0-4-g069d35e" (4 commits past the v0.1.0 tag) → clean "0.1.4".
        m = re.match(r"(\d+)\.(\d+)\.(\d+)-(\d+)-g[0-9a-f]+$", out)
        if m:
            maj, mnr, pat, n = (int(x) for x in m.groups())
            return f"{maj}.{mnr}.{pat + n}"
        return out
    f = INSTALL_DIR / "VERSION"
    return f.read_text().strip().lstrip("v") if f.exists() else "unknown"


def _version_at(ref: str) -> Optional[str]:
    code, out = _run(["git", "-C", str(INSTALL_DIR), "show", f"{ref}:VERSION"], timeout=5)
    return out.strip() if code == 0 and out else None


def _semver(v: Optional[str]) -> Optional[tuple[int, int, int]]:
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", v or "")
    return tuple(int(x) for x in m.groups()) if m else None  # type: ignore[return-value]


def _classify_update(cur_ver: Optional[str], latest_ver: Optional[str]) -> str:
    """major = major/minor semver bump (re-run installer); minor = patch bump
    (git pull + restart); none = same/older."""
    a, b = _semver(cur_ver), _semver(latest_ver)
    if not a or not b:
        return "unknown"
    if b[:2] > a[:2]:
        return "major"
    if b > a:
        return "minor"
    return "none"


def _is_major_update(current_sha: Optional[str], latest_sha: Optional[str]) -> bool:
    """Major if the major/minor version bumped, or installer/deps changed."""
    if _classify_update(_version_at("HEAD"), _version_at(f"origin/{BRANCH}")) == "major":
        return True
    if not current_sha or not latest_sha:
        return False
    code, out = _run(
        ["git", "-C", str(INSTALL_DIR), "diff", current_sha, f"origin/{BRANCH}", "--name-only"],
        timeout=10,
    )
    if code != 0:
        return False
    return "install.sh" in out or "requirements.txt" in out


def _write_result(ok: bool, message: str, frm: Optional[str] = None, to: Optional[str] = None) -> None:
    import datetime
    try:
        RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)
        RESULT_FILE.write_text(json.dumps({
            "ok": ok, "message": message, "from": frm, "to": to,
            "at": datetime.datetime.now().isoformat(timespec="seconds"),
        }))
    except OSError:
        pass


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
    latest_ver = _version_at(f"origin/{BRANCH}") if reachable else None
    return {
        "current_version":  _current_version(),
        "latest_version":   latest_ver,
        "update_type":      _classify_update(_version_at("HEAD"), latest_ver) if update_available else "none",
        "current_sha":      current[:8] if current else None,
        "latest_sha":       latest[:8]  if latest  else None,
        "update_available": update_available,
        "is_major":         _is_major_update(current, latest) if update_available else False,
        "update_running":   _update_running,
        "github_reachable": reachable,
        "changelog_url":    f"{REPO_URL.removesuffix('.git')}/commits/{BRANCH}",
    }


@router.get("/result")
def last_result(_: str = Depends(require_auth)):
    """Outcome of the most recent update — lets the UI flag 'update did nothing'."""
    if not RESULT_FILE.exists():
        return {"ok": None}
    try:
        return json.loads(RESULT_FILE.read_text())
    except (OSError, ValueError):
        return {"ok": None}


@router.get("/tags")
def list_tags(_: str = Depends(require_auth)):
    """Release tags (newest first) for the version picker — shows v0.1.0 etc.
    rather than raw commit shas."""
    _fetch()
    _run(["git", "-C", str(INSTALL_DIR), "fetch", "origin", "--tags", "--quiet"], timeout=20)
    code, out = _run(
        ["git", "-C", str(INSTALL_DIR), "tag", "-l", "v*", "--sort=-version:refname"],
        timeout=5,
    )
    if code != 0 or not out:
        return {"tags": []}
    cur = _sha("HEAD")
    tags = []
    for name in out.splitlines():
        name = name.strip()
        if not name:
            continue
        sha = _sha(name)
        tags.append({"name": name, "sha": sha, "current": bool(sha and cur and sha == cur)})
    return {"tags": tags}


class UpdateRequest(BaseModel):
    reinstall: bool = False
    sha: Optional[str] = None   # specific commit to install (None = latest)


def _do_update(sha: Optional[str] = None) -> None:
    global _update_running
    frm = _sha("HEAD")
    try:
        UPDATE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(UPDATE_LOG, "a") as log:
            import subprocess, datetime
            log.write(f"\n--- update started {datetime.datetime.now().isoformat()} ---\n")

            def run(cmd, **kw):
                r = subprocess.run(cmd, stdout=log, stderr=log, text=True, **kw)
                return r.returncode

            # fetch first so we can resolve any sha
            if run(["git", "-C", str(INSTALL_DIR), "fetch", "origin", BRANCH]) != 0:
                log.write("git fetch failed — aborting\n")
                _write_result(False, "Could not reach GitHub (git fetch failed).", frm, frm)
                return

            target = sha if sha else f"origin/{BRANCH}"
            log.write(f"--- resetting to {target} ---\n")
            if run(["git", "-C", str(INSTALL_DIR), "reset", "--hard", target]) != 0:
                log.write(f"git reset --hard {target} failed — aborting\n")
                _write_result(False, f"git reset to {target} failed.", frm, frm)
                return

            to = _sha("HEAD")
            if frm and to and frm == to and not sha:
                log.write("--- already at target, nothing changed ---\n")
                _write_result(False, "Update was available but the code did not change.", frm, to)
                return

            tag_ts = f"applied-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
            run(["git", "-C", str(INSTALL_DIR), "tag", tag_ts])
            log.write(f"--- tagged {tag_ts} ---\n")

            run([str(INSTALL_DIR / "venv/bin/pip"), "install", "-q",
                 "-r", str(INSTALL_DIR / "requirements.txt")])

            _write_result(True, f"Updated to {_current_version()}.", frm, to)
            log.write("--- restarting service ---\n")
            run(["systemctl", "restart", "litelayer"])
    except Exception as exc:  # noqa: BLE001
        _write_result(False, f"Update crashed: {exc}", frm, frm)
    finally:
        _update_running = False


def _do_reinstall() -> None:
    """Re-run the full installer — used for major updates."""
    global _update_running
    frm = _sha("HEAD")
    try:
        UPDATE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(UPDATE_LOG, "a") as log:
            import subprocess, datetime
            log.write(f"\n--- FULL REINSTALL started {datetime.datetime.now().isoformat()} ---\n")
            # pipefail so a curl 404 actually fails the run instead of silently
            # feeding an empty script to bash (which used to "succeed" doing nothing).
            r = subprocess.run(
                f"set -o pipefail; curl -fsSL {INSTALL_URL} | bash",
                shell=True, executable="/bin/bash",
                stdout=log, stderr=log, text=True, timeout=300,
            )
            log.write(f"--- reinstall exit {r.returncode} ---\n")
            to = _sha("HEAD")
            if r.returncode == 0:
                _write_result(True, f"Reinstalled to {_current_version()}.", frm, to)
            else:
                _write_result(False, f"Reinstall failed (exit {r.returncode}). See update log.", frm, to)
    except Exception as exc:  # noqa: BLE001
        _write_result(False, f"Reinstall crashed: {exc}", frm, frm)
    finally:
        _update_running = False


@router.post("/update")
def trigger_update(body: UpdateRequest = UpdateRequest(), _: str = Depends(require_auth)):
    global _update_running
    with _update_lock:
        if _update_running:
            raise HTTPException(409, "Update already in progress")
        _update_running = True

    if body.reinstall:
        t = threading.Thread(target=_do_reinstall, daemon=True, name="ota-update")
    else:
        t = threading.Thread(target=_do_update, kwargs={"sha": body.sha or None}, daemon=True, name="ota-update")
    t.start()
    return {"status": "update_started", "logs_endpoint": "/api/ota/logs"}


@router.get("/logs")
def get_logs(lines: int = 100, _: str = Depends(require_auth)):
    if not UPDATE_LOG.exists():
        return {"logs": "No update history yet."}
    text = UPDATE_LOG.read_text().splitlines()
    return {"logs": "\n".join(text[-lines:])}
