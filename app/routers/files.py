import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from drives import registry
from app.deps import require_auth

router = APIRouter(prefix="/api/files", tags=["files"])


def _safe_path(drive_root: Path, user_path: str) -> Path:
    """Resolve path and verify it stays within drive_root. Rejects .. and symlink escapes."""
    target = (drive_root / user_path.lstrip("/")).resolve()
    if not target.is_relative_to(drive_root.resolve()):
        raise HTTPException(403, "Path escape rejected")
    return target


class FileEntry(BaseModel):
    name: str
    path: str       # relative to drive root, starts with /
    is_dir: bool
    size_bytes: int
    modified: float


class DirListing(BaseModel):
    drive_id: str
    path: str
    entries: list[FileEntry]


@router.get("", response_model=DirListing)
def list_dir(
    drive: str = Query(..., description="Drive UUID"),
    path: str = Query(default="/", description="Path relative to drive root"),
    _: str = Depends(require_auth),
):
    d = registry.get(drive)
    if not d:
        raise HTTPException(404, "Drive not found")
    if not d.mount_point:
        raise HTTPException(409, "Drive not mounted — mount it first")

    root = Path(d.mount_point)
    target = _safe_path(root, path)

    if not target.exists():
        raise HTTPException(404, "Path not found")
    if not target.is_dir():
        raise HTTPException(400, "Not a directory")

    entries: list[FileEntry] = []
    try:
        items = sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.casefold()))
    except PermissionError:
        raise HTTPException(403, "Permission denied")

    for item in items:
        try:
            stat = item.stat(follow_symlinks=False)
            rel = item.relative_to(root)
            entries.append(FileEntry(
                name=item.name,
                path="/" + str(rel).replace("\\", "/"),
                is_dir=item.is_dir(),
                size_bytes=stat.st_size,
                modified=stat.st_mtime,
            ))
        except (PermissionError, OSError):
            continue

    display_path = "/" + str(target.relative_to(root)).replace("\\", "/") if target != root else "/"
    return DirListing(drive_id=drive, path=display_path, entries=entries)


@router.get("/download")
def download_file(
    drive: str = Query(...),
    path: str = Query(...),
    _: str = Depends(require_auth),
):
    d = registry.get(drive)
    if not d:
        raise HTTPException(404, "Drive not found")
    if not d.mount_point:
        raise HTTPException(409, "Drive not mounted")

    root = Path(d.mount_point)
    target = _safe_path(root, path)

    if not target.exists():
        raise HTTPException(404, "File not found")
    if target.is_dir():
        raise HTTPException(400, "Target is a directory")

    mime, _ = mimetypes.guess_type(str(target))
    mime = mime or "application/octet-stream"
    size = target.stat().st_size

    def stream():
        with open(target, "rb") as f:
            while chunk := f.read(1024 * 1024):  # 1 MB chunks
                yield chunk

    return StreamingResponse(
        stream(),
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="{target.name}"',
            "Content-Length": str(size),
        },
    )


@router.post("/upload")
async def upload_file(
    drive: str = Query(...),
    path: str = Query(default="/"),
    file: UploadFile = File(...),
    _: str = Depends(require_auth),
):
    d = registry.get(drive)
    if not d:
        raise HTTPException(404, "Drive not found")
    if not d.mount_point:
        raise HTTPException(409, "Drive not mounted")
    root = Path(d.mount_point)
    target_dir = _safe_path(root, path)
    if not target_dir.is_dir():
        raise HTTPException(400, "Not a directory")
    safe_name = Path(file.filename or "upload").name
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(400, "Invalid filename")
    dest = (target_dir / safe_name).resolve()
    if not dest.is_relative_to(root.resolve()):
        raise HTTPException(403, "Filename escape rejected")
    try:
        with open(dest, "wb") as f:
            while chunk := await file.read(1 << 20):
                f.write(chunk)
    except OSError as exc:
        raise HTTPException(500, str(exc))
    return {"name": safe_name, "size": dest.stat().st_size}


@router.post("/mkdir")
def mkdir(_: str = Depends(require_auth)):
    raise HTTPException(501, "mkdir not yet implemented")


class RenameRequest(BaseModel):
    drive: str
    path: str          # current path relative to drive root
    new_name: str      # new basename only


@router.post("/rename")
def rename(req: RenameRequest, _: str = Depends(require_auth)):
    d = registry.get(req.drive)
    if not d:
        raise HTTPException(404, "Drive not found")
    if not d.mount_point:
        raise HTTPException(409, "Drive not mounted")
    if d.state == "mounted_ro":
        raise HTTPException(409, "Drive is read-only — enable write first")

    root = Path(d.mount_point)
    src = _safe_path(root, req.path)
    if not src.exists():
        raise HTTPException(404, "File not found")

    new_name = Path(req.new_name).name
    if not new_name or new_name in (".", ".."):
        raise HTTPException(400, "Invalid name")
    dest = (src.parent / new_name).resolve()
    if not dest.is_relative_to(root.resolve()):
        raise HTTPException(403, "Rename escape rejected")
    if dest.exists():
        raise HTTPException(409, "A file with that name already exists")
    try:
        src.rename(dest)
    except OSError as exc:
        raise HTTPException(500, str(exc))
    return {"name": new_name, "path": "/" + str(dest.relative_to(root)).replace("\\", "/")}


class DeleteRequest(BaseModel):
    drive: str
    paths: list[str]   # paths relative to drive root


@router.delete("")
def delete(req: DeleteRequest, _: str = Depends(require_auth)):
    import shutil
    d = registry.get(req.drive)
    if not d:
        raise HTTPException(404, "Drive not found")
    if not d.mount_point:
        raise HTTPException(409, "Drive not mounted")
    if d.state == "mounted_ro":
        raise HTTPException(409, "Drive is read-only — enable write first")

    root = Path(d.mount_point)
    deleted = []
    for p in req.paths:
        target = _safe_path(root, p)
        if target == root.resolve():
            raise HTTPException(400, "Refusing to delete the drive root")
        if not target.exists():
            continue
        try:
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
            deleted.append(p)
        except OSError as exc:
            raise HTTPException(500, str(exc))
    return {"deleted": deleted, "count": len(deleted)}
