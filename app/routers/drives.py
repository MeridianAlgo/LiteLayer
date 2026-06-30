import shutil
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from fastapi import Request

from drives import registry, persist, pinlock
from drives.mount import mount as do_mount, unmount as do_unmount, remount_rw, get_usage, ALWAYS_RO
from app.deps import require_auth, current_token
from app import audit

router = APIRouter(prefix="/api/drives", tags=["drives"])


class AutoMountRequest(BaseModel):
    enabled: bool


@router.get("/auto-mount")
def get_auto_mount(_: str = Depends(require_auth)):
    return {"enabled": persist.is_auto_mount()}


@router.post("/auto-mount")
def set_auto_mount(req: AutoMountRequest, _: str = Depends(require_auth)):
    """Keep drives mounted: auto-mount (read-only) plugged-in drives and remount
    them after a reboot, unless the user ejected them."""
    persist.set_auto_mount(req.enabled)
    if req.enabled:
        from drives import hotplug
        hotplug._refresh()
    return {"enabled": req.enabled}


class DriveOut(BaseModel):
    id: str
    device: str
    label: str
    fstype: str
    size_bytes: int
    used_bytes: int
    free_bytes: int
    state: str
    mount_point: Optional[str]
    rw_capable: bool  # False for always-ro filesystems
    locked: bool      # a PIN is set on this drive
    unlocked: bool    # this session has entered the PIN


def _enrich(d, token: str) -> DriveOut:
    label = persist.get_labels().get(d.id, d.label)
    locked = pinlock.is_locked(d.id)
    return DriveOut(
        id=d.id,
        device=d.device,
        label=label,
        fstype=d.fstype,
        size_bytes=d.size_bytes,
        used_bytes=d.used_bytes,
        free_bytes=d.free_bytes,
        state=d.state,
        mount_point=d.mount_point,
        rw_capable=d.fstype.lower() not in ALWAYS_RO,
        locked=locked,
        unlocked=pinlock.is_unlocked(d.id, token),
    )


@router.get("", response_model=list[DriveOut])
def list_drives(token: str = Depends(current_token)):
    return [_enrich(d, token) for d in registry.get_all()]


class PinRequest(BaseModel):
    pin: str


@router.post("/{drive_id}/lock")
def lock_drive(drive_id: str, req: PinRequest, _: str = Depends(require_auth)):
    """Set a PIN on a drive. From here its files are refused until /unlock."""
    if not registry.get(drive_id):
        raise HTTPException(404, "Drive not found")
    if pinlock.is_locked(drive_id):
        raise HTTPException(409, "Drive is already locked")
    try:
        pinlock.set_pin(drive_id, req.pin)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"locked": True}


@router.post("/{drive_id}/unlock")
def unlock_drive(drive_id: str, req: PinRequest, request: Request, token: str = Depends(current_token)):
    """Grant THIS session access to a locked drive after a correct PIN."""
    if not registry.get(drive_id):
        raise HTTPException(404, "Drive not found")
    result = pinlock.unlock(drive_id, req.pin, token)
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "?")
    if result == "throttled":
        audit.log("pin.throttled", ip=ip, detail=drive_id[:12])
        raise HTTPException(429, "Too many wrong PINs. Wait a few minutes and try again.")
    if result != "ok":
        audit.log("pin.fail", ip=ip, detail=drive_id[:12])
        raise HTTPException(403, "Wrong PIN")
    return {"unlocked": True}


@router.delete("/{drive_id}/lock")
def remove_lock(drive_id: str, req: PinRequest, _: str = Depends(require_auth)):
    """Remove a drive's PIN — requires the current PIN."""
    if not registry.get(drive_id):
        raise HTTPException(404, "Drive not found")
    if not pinlock.remove_pin(drive_id, req.pin):
        raise HTTPException(403, "Wrong PIN")
    return {"locked": False}


class RenameDriveRequest(BaseModel):
    label: str


@router.post("/{drive_id}/rename")
def rename_drive(drive_id: str, req: RenameDriveRequest, _: str = Depends(require_auth)):
    """Set a UI nickname for a drive. Doesn't touch the filesystem label — safe,
    survives reboots. Empty string clears it back to the real label."""
    drive = registry.get(drive_id)
    if not drive:
        raise HTTPException(404, "Drive not found")
    label = req.label.strip()[:64]
    persist.set_label(drive_id, label)
    return {"id": drive_id, "label": label or drive.label}


@router.post("/{drive_id}/mount")
def mount_drive(drive_id: str, _: str = Depends(require_auth)):
    drive = registry.get(drive_id)
    if not drive:
        raise HTTPException(404, "Drive not found")
    if drive.state.startswith("mounted"):
        return {"status": "already_mounted", "mount_point": drive.mount_point}
    try:
        persist.mark_mounted(drive_id)   # clear any past eject before mounting
        mp = do_mount(drive, read_write=False)
        used, free = get_usage(mp)
        drive.used_bytes = used
        drive.free_bytes = free
        drive.state = "mounted_ro"
        drive.mount_point = mp
        registry.update(drive)
        return {"status": "mounted_ro", "mount_point": mp}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/{drive_id}/unmount")
def unmount_drive(drive_id: str, _: str = Depends(require_auth)):
    drive = registry.get(drive_id)
    if not drive:
        raise HTTPException(404, "Drive not found")
    if drive.state == "unmounted":
        return {"status": "already_unmounted"}
    try:
        persist.mark_ejected(drive_id)   # before unmount, so auto-mount won't race it back up
        do_unmount(drive)
        drive.state = "unmounted"
        drive.mount_point = None
        drive.used_bytes = 0
        drive.free_bytes = 0
        registry.update(drive)
        return {"status": "unmounted"}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/{drive_id}/enable-write")
def enable_write(drive_id: str, _: str = Depends(require_auth)):
    """Remount a mounted drive as read-write. Explicit opt-in required."""
    drive = registry.get(drive_id)
    if not drive:
        raise HTTPException(404, "Drive not found")
    if drive.fstype.lower() in ALWAYS_RO:
        raise HTTPException(400, f"{drive.fstype} is always read-only")
    if drive.state == "unmounted":
        # Mount directly as rw
        try:
            mp = do_mount(drive, read_write=True)
            used, free = get_usage(mp)
            drive.used_bytes = used
            drive.free_bytes = free
            drive.state = "mounted_rw"
            drive.mount_point = mp
            registry.update(drive)
            return {"status": "mounted_rw", "mount_point": mp}
        except Exception as exc:
            raise HTTPException(500, str(exc))
    if drive.state == "mounted_ro":
        try:
            remount_rw(drive)
            drive.state = "mounted_rw"
            registry.update(drive)
            return {"status": "mounted_rw"}
        except Exception as exc:
            raise HTTPException(500, str(exc))
    return {"status": drive.state}


@router.post("/{drive_id}/disable-write")
def disable_write(drive_id: str, _: str = Depends(require_auth)):
    """Remount as read-only."""
    from drives.mount import _assert_external
    import subprocess
    drive = registry.get(drive_id)
    if not drive:
        raise HTTPException(404, "Drive not found")
    if drive.state != "mounted_rw":
        return {"status": drive.state}
    _assert_external(drive.device)
    r = subprocess.run(
        ["mount", "-o", "remount,ro", drive.mount_point],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        raise HTTPException(500, r.stderr.strip())
    drive.state = "mounted_ro"
    registry.update(drive)
    return {"status": "mounted_ro"}
