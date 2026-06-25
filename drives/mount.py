"""
Mount / unmount logic. All privileged drive operations live here.
Safety invariants enforced at this layer:
  - System disk is never touched.
  - hfsplus and squashfs/iso9660 are always mounted read-only.
  - Mount point is under MOUNT_ROOT only.
"""
import re
import shutil
import subprocess

from pathlib import Path
from drives.registry import Drive
from app.config import MOUNT_ROOT

# These filesystems are always read-only regardless of user toggle.
ALWAYS_RO = {"hfsplus", "hfs", "squashfs", "iso9660", "erofs"}

# Filesystem-specific mount options appended after the rw/ro flag.
_FS_OPTS: dict[str, list[str]] = {
    "ntfs":    ["windows_names", "uid=0", "gid=0"],
    "exfat":   ["uid=0", "gid=0"],
    "vfat":    ["uid=0", "gid=0", "codepage=437", "iocharset=utf8", "shortname=mixed"],
    "fat32":   ["uid=0", "gid=0", "codepage=437", "iocharset=utf8"],
    "msdos":   ["uid=0", "gid=0"],
    "hfsplus": ["force", "uid=0", "gid=0"],
    "hfs":     ["uid=0", "gid=0"],
    "udf":     ["uid=0", "gid=0"],
}

# Map userspace fs name -> kernel module name.
_FS_TYPE_MAP: dict[str, str] = {
    "ntfs":  "ntfs3",   # in-kernel NTFS driver (kernel 5.15+)
    "fat32": "vfat",
    "fat16": "vfat",
    "msdos": "vfat",
    "hfs":   "hfsplus",
}

_sys_devs_cache: set[str] | None = None


def _get_sys_devs() -> set[str]:
    global _sys_devs_cache
    if _sys_devs_cache is not None:
        return _sys_devs_cache
    result: set[str] = set()
    try:
        out = subprocess.run(
            ["findmnt", "-n", "-o", "SOURCE", "/"],
            capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if out:
            result.add(out)
            dev = out.removeprefix("/dev/")
            parent = re.sub(r'p?\d+$', '', dev)
            result.add(f"/dev/{parent}")
            for i in range(1, 16):
                result.add(f"/dev/{parent}{i}")
                result.add(f"/dev/{parent}p{i}")
    except Exception:
        pass
    _sys_devs_cache = result
    return result


def _assert_external(device: str) -> None:
    if device in _get_sys_devs():
        raise PermissionError(f"Refusing to touch system device: {device}")


def _try_mount(device: str, mp: Path, fstype: str, opts: list[str]) -> tuple[bool, str]:
    """Attempt mount, return (success, stderr)."""
    cmd = ["mount", "-t", fstype, "-o", ",".join(opts), device, str(mp)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode == 0, r.stderr


def mount(drive: Drive, read_write: bool = False) -> str:
    """Mount drive read-only (or rw if read_write=True and fs supports it).
    Returns the mount point path."""
    _assert_external(drive.device)

    fstype_raw = drive.fstype.lower()
    force_ro = fstype_raw in ALWAYS_RO
    ro = True if force_ro else not read_write

    mp = MOUNT_ROOT / drive.id
    mp.mkdir(parents=True, exist_ok=True)

    kernel_type = _FS_TYPE_MAP.get(fstype_raw, fstype_raw)
    base_opts = ["ro" if ro else "rw", "noexec", "nosuid", "nodev", "noatime"]
    extra_opts = _FS_OPTS.get(fstype_raw, [])
    opts = base_opts + extra_opts

    # Try with explicit kernel type first
    ok, err1 = _try_mount(drive.device, mp, kernel_type, opts)
    if ok:
        return str(mp)

    # ntfs3 might not be available (older kernel) — try ntfs-3g as fallback
    if kernel_type == "ntfs3":
        ok, err2 = _try_mount(drive.device, mp, "ntfs-3g", opts)
        if ok:
            return str(mp)

    # Last resort: let the kernel auto-detect (catches exotic filesystems)
    auto_opts = base_opts  # skip fs-specific opts for auto
    r = subprocess.run(
        ["mount", "-o", ",".join(auto_opts), drive.device, str(mp)],
        capture_output=True, text=True
    )
    if r.returncode == 0:
        return str(mp)

    raise RuntimeError(
        f"All mount attempts failed for {drive.device} ({drive.fstype}): {err1.strip()} / {r.stderr.strip()}"
    )


def unmount(drive: Drive) -> None:
    """Unmount a drive. Tries normal then lazy unmount."""
    _assert_external(drive.device)

    if not drive.mount_point:
        return

    # Soft eject: flush dirty buffers to disk first so nothing is lost.
    subprocess.run(["sync"], capture_output=True, text=True)

    r = subprocess.run(["umount", drive.mount_point], capture_output=True, text=True)
    if r.returncode == 0:
        return

    # Lazy unmount — detaches immediately, cleans up when last user closes fd
    r2 = subprocess.run(["umount", "-l", drive.mount_point], capture_output=True, text=True)
    if r2.returncode != 0:
        raise RuntimeError(f"Unmount failed: {r.stderr.strip()}")


def remount_rw(drive: Drive) -> None:
    """Remount an already-mounted drive as read-write."""
    _assert_external(drive.device)
    if drive.fstype.lower() in ALWAYS_RO:
        raise PermissionError(f"{drive.fstype} cannot be mounted read-write")
    if not drive.mount_point:
        raise RuntimeError("Drive is not mounted")
    r = subprocess.run(
        ["mount", "-o", "remount,rw", drive.mount_point],
        capture_output=True, text=True
    )
    if r.returncode == 0:
        return
    # FUSE filesystems (ntfs-3g, exfat-fuse) — the usual format for USB drives —
    # don't support `remount,rw`. Cycle the mount instead: unmount, re-mount rw.
    # This was why upload/rename/delete silently failed on NTFS/exFAT drives.
    subprocess.run(["umount", drive.mount_point], capture_output=True, text=True)
    mount(drive, read_write=True)


def get_usage(mp: str) -> tuple[int, int]:
    try:
        u = shutil.disk_usage(mp)
        return u.used, u.free
    except Exception:
        return 0, 0
