import threading
from dataclasses import dataclass
from typing import Optional

@dataclass
class Drive:
    id: str            # UUID from blkid, or "nouuid-<devname>"
    device: str        # /dev/sda1
    label: str
    fstype: str
    size_bytes: int
    used_bytes: int
    free_bytes: int
    state: str         # unmounted | mounted_ro | mounted_rw
    mount_point: Optional[str] = None

_lock = threading.Lock()
_drives: dict[str, Drive] = {}


def get_all() -> list[Drive]:
    with _lock:
        return list(_drives.values())


def get(drive_id: str) -> Optional[Drive]:
    with _lock:
        return _drives.get(drive_id)


def update(drive: Drive) -> None:
    with _lock:
        _drives[drive.id] = drive


def remove(drive_id: str) -> None:
    with _lock:
        _drives.pop(drive_id, None)


def replace_all(drives: list[Drive]) -> None:
    with _lock:
        _drives.clear()
        for d in drives:
            _drives[d.id] = d
