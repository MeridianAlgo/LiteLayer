"""
Tiny persisted state so mounts survive app restarts / Pi reboots.

  auto_mount: when True, any drive that isn't explicitly ejected gets mounted
              read-only on plug-in and on startup ("soft mount" — never writes,
              never formats, existing data is safe).
  ejected:    drives the user hit Eject on. We never auto-remount these until
              they mount again, otherwise the poll loop would fight the eject.

ponytail: one JSON file, no DB. Single process, so a module lock is enough.
"""
import json
import threading

from app.config import STATE_FILE

_lock = threading.Lock()
_DEFAULT = {"auto_mount": True, "ejected": []}


def _load() -> dict:
    try:
        d = json.loads(STATE_FILE.read_text())
        return {**_DEFAULT, **d}
    except Exception:
        return dict(_DEFAULT)


def _save(d: dict) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(d))
    except OSError:
        pass  # dev box without the real config dir — preference just won't persist


def is_auto_mount() -> bool:
    with _lock:
        return bool(_load()["auto_mount"])


def set_auto_mount(enabled: bool) -> None:
    with _lock:
        d = _load()
        d["auto_mount"] = bool(enabled)
        _save(d)


def is_ejected(uuid: str) -> bool:
    with _lock:
        return uuid in _load()["ejected"]


def mark_ejected(uuid: str) -> None:
    with _lock:
        d = _load()
        if uuid not in d["ejected"]:
            d["ejected"].append(uuid)
            _save(d)


def mark_mounted(uuid: str) -> None:
    """User mounted it — clear any past eject so auto-mount keeps it up."""
    with _lock:
        d = _load()
        if uuid in d["ejected"]:
            d["ejected"].remove(uuid)
            _save(d)
