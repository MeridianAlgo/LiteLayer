"""
Drive enumeration via lsblk + blkid.
Never touches the system disk. Supports any filesystem the kernel will mount.
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

from drives.registry import Drive
from app.config import MOUNT_ROOT

# Filesystems we explicitly know how to handle; others fall back to kernel auto-detect.
# This list is for UI display info only — we never refuse based on it.
KNOWN_FS = {
    "ext4", "ext3", "ext2", "ext",
    "ntfs",
    "exfat",
    "vfat", "fat32", "fat16", "msdos",
    "btrfs",
    "xfs",
    "hfsplus", "hfs",
    "iso9660", "udf",
    "f2fs",
    "jfs",
    "reiserfs",
    "squashfs",
    "apfs",
    "zfs",
    "nilfs2",
    "erofs",
}

_system_devs_cache: set[str] | None = None


def _get_system_devs() -> set[str]:
    global _system_devs_cache
    if _system_devs_cache is not None:
        return _system_devs_cache

    result: set[str] = set()
    try:
        out = subprocess.run(
            ["findmnt", "-n", "-o", "SOURCE", "/"],
            capture_output=True, text=True, timeout=5
        ).stdout.strip()

        # e.g. /dev/mmcblk0p2 or /dev/sda1
        if out:
            result.add(out)
            dev = out.removeprefix("/dev/")
            # strip partition suffix: mmcblk0p2 -> mmcblk0, sda1 -> sda
            parent = re.sub(r'p\d+$', '', dev)   # mmcblk0p2 -> mmcblk0
            parent = re.sub(r'\d+$', '', parent)  # sda1 -> sda (already done above if no p)
            # regenerate without 'p' suffix too
            parent2 = re.sub(r'\d+$', '', dev)
            for p in {parent, parent2}:
                result.add(f"/dev/{p}")
                for i in range(1, 16):
                    result.add(f"/dev/{p}{i}")
                    result.add(f"/dev/{p}p{i}")
    except Exception:
        pass

    _system_devs_cache = result
    return result


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=10
        ).stdout.strip()
    except Exception:
        return ""


def _disk_usage(mp: str) -> tuple[int, int]:
    try:
        u = shutil.disk_usage(mp)
        return u.used, u.free
    except Exception:
        return 0, 0


def _truthy(val) -> bool:
    if isinstance(val, bool):
        return val
    return str(val).strip() in ("1", "true", "yes")


def _walk_lsblk(devices: list[dict], sys_devs: set[str]) -> list[dict]:
    """Flatten lsblk tree, returning partitions/disks that have a filesystem
    and are not part of the system disk."""
    results = []
    for dev in devices:
        name = dev.get("name", "")
        full = f"/dev/{name}"
        devtype = dev.get("type", "")
        fstype = (dev.get("fstype") or "").strip()

        # Skip system disk at any level
        if full in sys_devs:
            # Still walk children — they're also excluded below
            if "children" in dev:
                _walk_lsblk(dev["children"], sys_devs)
            continue

        # Include partitions or whole-disk devices that have a filesystem
        if devtype in ("part", "disk", "loop") and fstype:
            hotplug = _truthy(dev.get("hotplug", False)) or _truthy(dev.get("rm", False))
            tran = (dev.get("tran") or "").lower()
            is_external = hotplug or tran in ("usb", "ieee1394")

            # On a Pi, anything not the system disk and with a fs is fair game.
            # We include internal SATA/NVMe only if explicitly removable or USB.
            # mmcblk devices: include non-system ones (secondary SD/eMMC readers).
            if is_external or name.startswith("mmcblk") or tran == "":
                results.append({
                    "name": name,
                    "device": full,
                    "uuid": (dev.get("uuid") or "").strip() or f"nouuid-{name}",
                    "fstype": fstype,
                    "label": (dev.get("label") or "").strip() or name,
                    "size": int(dev.get("size") or 0),
                    "mountpoint": dev.get("mountpoint") or None,
                    "is_external": is_external,
                })

        if "children" in dev:
            results.extend(_walk_lsblk(dev["children"], sys_devs))

    return results


def enumerate_drives() -> list[Drive]:
    raw = _run([
        "lsblk", "-J", "-b",
        "-o", "NAME,UUID,FSTYPE,LABEL,SIZE,MOUNTPOINT,HOTPLUG,TYPE,TRAN,RM"
    ])
    if not raw:
        return []

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []

    sys_devs = _get_system_devs()
    devices = _walk_lsblk(data.get("blockdevices", []), sys_devs)

    drives: list[Drive] = []
    for dev in devices:
        uuid = dev["uuid"]
        mp = dev["mountpoint"]

        # Check if already mounted somewhere we manage
        our_mp = MOUNT_ROOT / uuid
        if not mp and our_mp.is_mount():
            mp = str(our_mp)

        if mp:
            used, free = _disk_usage(mp)
            state = "mounted_ro"  # conservative default; updated by mount module
        else:
            used, free = 0, 0
            state = "unmounted"

        drives.append(Drive(
            id=uuid,
            device=dev["device"],
            label=dev["label"],
            fstype=dev["fstype"],
            size_bytes=dev["size"],
            used_bytes=used,
            free_bytes=free,
            state=state,
            mount_point=mp,
        ))

    return drives
