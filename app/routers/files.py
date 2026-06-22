import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
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


# Write endpoints — stubbed, gated behind auth, not yet implemented
@router.post("/upload")
def upload(_: str = Depends(require_auth)):
    raise HTTPException(501, "Upload not yet implemented")


@router.post("/mkdir")
def mkdir(_: str = Depends(require_auth)):
    raise HTTPException(501, "mkdir not yet implemented")


@router.post("/rename")
def rename(_: str = Depends(require_auth)):
    raise HTTPException(501, "rename not yet implemented")


@router.delete("")
def delete(_: str = Depends(require_auth)):
    raise HTTPException(501, "delete not yet implemented")
