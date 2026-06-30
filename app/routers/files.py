import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from drives import registry, pinlock
from app.deps import require_auth, current_token

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
    tok: str = Depends(current_token),
):
    pinlock.assert_access(drive, tok)
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
    tok: str = Depends(current_token),
):
    pinlock.assert_access(drive, tok)
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

    # A filename can contain quotes/newlines on disk — never interpolate it raw
    # into the header (CRLF would let it inject other headers). ASCII-only token
    # for the legacy field, RFC 5987 filename* carries the real (UTF-8) name.
    from urllib.parse import quote
    ascii_name = "".join(c for c in target.name if 32 <= ord(c) < 127 and c != '"') or "download"
    disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(target.name)}"

    return StreamingResponse(
        stream(),
        media_type=mime,
        headers={
            "Content-Disposition": disposition,
            "Content-Length": str(size),
        },
    )


@router.post("/upload")
async def upload_file(
    drive: str = Query(...),
    path: str = Query(default="/"),
    file: UploadFile = File(...),
    tok: str = Depends(current_token),
):
    pinlock.assert_access(drive, tok)
    d = registry.get(drive)
    if not d:
        raise HTTPException(404, "Drive not found")
    if not d.mount_point:
        raise HTTPException(409, "Drive not mounted")
    root = Path(d.mount_point)
    target_dir = _safe_path(root, path)
    # Folder uploads target subdirs ("folder/sub") that may not exist yet — create
    # them (within the safe root) so the whole tree lands in one pass.
    if not target_dir.exists():
        _ensure_writable(d)
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise HTTPException(500, f"Could not create folder: {exc}")
    if not target_dir.is_dir():
        raise HTTPException(400, "Not a directory")
    safe_name = Path(file.filename or "upload").name
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(400, "Invalid filename")
    dest = (target_dir / safe_name).resolve()
    if not dest.is_relative_to(root.resolve()):
        raise HTTPException(403, "Filename escape rejected")

    import shutil

    def _write() -> None:
        # Stream from the upload's spooled temp file straight to disk — never load
        # the whole (potentially multi-GB) file into RAM. seek(0) lets us retry.
        file.file.seek(0)
        with open(dest, "wb") as out:
            shutil.copyfileobj(file.file, out, 1024 * 1024)

    try:
        _write()
    except OSError as exc:
        # Drive is mounted read-only — remount it rw and try again. Drives are
        # ro by default for safety; uploading is an explicit opt-in to write.
        import errno
        if exc.errno not in (errno.EROFS, errno.EACCES):
            raise HTTPException(500, str(exc))
        from drives.mount import remount_rw, ALWAYS_RO
        if d.fstype.lower() in ALWAYS_RO:
            raise HTTPException(409, f"{d.fstype} drives are read-only")
        try:
            remount_rw(d)
            d.state = "mounted_rw"
            registry.update(d)
            _write()
        except OSError as exc2:
            raise HTTPException(500, f"Could not write (drive read-only): {exc2}")
        except Exception as exc2:  # noqa: BLE001
            raise HTTPException(500, f"Could not enable write: {exc2}")
    return {"name": safe_name, "size": dest.stat().st_size}


def _ensure_writable(d) -> None:
    """Remount a drive read-write on demand — drives are RO by default, so any
    write action (mkdir/move) opts in explicitly. Raises on read-only filesystems."""
    if d.state != "mounted_ro":
        return
    from drives.mount import remount_rw, ALWAYS_RO
    if d.fstype.lower() in ALWAYS_RO:
        raise HTTPException(409, f"{d.fstype} drives are read-only")
    try:
        remount_rw(d)
        d.state = "mounted_rw"
        registry.update(d)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Could not enable write: {exc}")


class MkdirRequest(BaseModel):
    drive: str
    path: str = "/"     # parent directory
    name: str           # new folder basename


@router.post("/mkdir")
def mkdir(req: MkdirRequest, tok: str = Depends(current_token)):
    pinlock.assert_access(req.drive, tok)
    d = registry.get(req.drive)
    if not d:
        raise HTTPException(404, "Drive not found")
    if not d.mount_point:
        raise HTTPException(409, "Drive not mounted")
    name = Path(req.name).name
    if not name or name in (".", ".."):
        raise HTTPException(400, "Invalid folder name")
    root = Path(d.mount_point)
    parent = _safe_path(root, req.path)
    if not parent.is_dir():
        raise HTTPException(400, "Parent is not a directory")
    dest = _safe_path(root, str((parent / name).relative_to(root.resolve())))
    if dest.exists():
        raise HTTPException(409, "A file or folder with that name already exists")
    _ensure_writable(d)
    try:
        dest.mkdir()
    except OSError as exc:
        raise HTTPException(500, str(exc))
    return {"name": name, "path": "/" + str(dest.relative_to(root)).replace("\\", "/")}


class MoveRequest(BaseModel):
    drive: str
    paths: list[str]    # items to move (relative to drive root)
    dest: str           # destination folder (relative to drive root)


@router.post("/move")
def move_files(req: MoveRequest, tok: str = Depends(current_token)):
    """Move files/folders into a folder on the SAME drive (instant rename).
    Cross-drive transfers go through /transfer."""
    import shutil
    pinlock.assert_access(req.drive, tok)
    d = registry.get(req.drive)
    if not d:
        raise HTTPException(404, "Drive not found")
    if not d.mount_point:
        raise HTTPException(409, "Drive not mounted")
    if not req.paths:
        raise HTTPException(400, "Nothing to move")
    root = Path(d.mount_point)
    dst_dir = _safe_path(root, req.dest)
    if not dst_dir.is_dir():
        raise HTTPException(400, "Destination is not a directory")
    _ensure_writable(d)
    moved = []
    for p in req.paths:
        src = _safe_path(root, p)
        if not src.exists() or src == root.resolve():
            continue
        # Don't move a folder into itself or one of its own descendants.
        if src.is_dir() and dst_dir.resolve().is_relative_to(src.resolve()):
            raise HTTPException(400, "Can't move a folder into itself")
        if src.parent == dst_dir.resolve():
            continue  # already there
        dest = _unique(dst_dir / src.name)
        try:
            shutil.move(str(src), str(dest))
            moved.append(p)
        except OSError as exc:
            raise HTTPException(500, str(exc))
    return {"moved": moved, "count": len(moved)}


class RenameRequest(BaseModel):
    drive: str
    path: str          # current path relative to drive root
    new_name: str      # new basename only


@router.post("/rename")
def rename(req: RenameRequest, tok: str = Depends(current_token)):
    pinlock.assert_access(req.drive, tok)
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


# ── Drive-to-drive transfer ───────────────────────────────────────────────────
# One transfer at a time; the UI polls /transfer/status for progress.
import threading

_transfer = {"running": False, "done": 0, "total": 0, "file": "", "error": None,
             "copied": 0, "count": 0}
_transfer_lock = threading.Lock()


def _dir_size(p: Path) -> int:
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file() and not f.is_symlink():
                total += f.stat().st_size
        except OSError:
            pass
    return total


def _unique(dest: Path) -> Path:
    """Avoid clobbering an existing name at the destination."""
    if not dest.exists():
        return dest
    stem, suf = dest.stem, dest.suffix
    for i in range(1, 1000):
        cand = dest.with_name(f"{stem} (copy{'' if i == 1 else ' ' + str(i)}){suf}")
        if not cand.exists():
            return cand
    return dest.with_name(f"{stem}-{os.getpid()}{suf}")


def _transfer_worker(src_root: Path, dst_root: Path, rel_paths: list[str], move: bool) -> None:
    import shutil
    try:
        srcs = [_safe_path(src_root, p) for p in rel_paths]
        srcs = [s for s in srcs if s.exists()]
        _transfer["total"] = sum(
            (_dir_size(s) if s.is_dir() else s.stat().st_size) for s in srcs
        ) or 1
        _transfer["count"] = len(srcs)

        def _cp(src: Path, dst: Path):
            if src.is_dir():
                dst.mkdir(exist_ok=True)
                for child in src.iterdir():
                    _cp(child, _unique(dst / child.name) if not (dst / child.name).is_dir() else dst / child.name)
            else:
                _transfer["file"] = src.name
                with open(src, "rb") as fi, open(dst, "wb") as fo:
                    while chunk := fi.read(4 * 1024 * 1024):
                        fo.write(chunk)
                        _transfer["done"] += len(chunk)
                shutil.copystat(src, dst, follow_symlinks=False)

        for s in srcs:
            _cp(s, _unique(dst_root / s.name))
            _transfer["copied"] += 1
            if move:
                if s.is_dir():
                    shutil.rmtree(s)
                else:
                    s.unlink()
    except Exception as exc:  # noqa: BLE001
        _transfer["error"] = str(exc)
    finally:
        _transfer["running"] = False


class TransferRequest(BaseModel):
    src_drive: str
    paths: list[str]          # relative to src drive root
    dst_drive: str
    dst_path: str = "/"       # folder on dst drive
    move: bool = False


@router.post("/transfer")
def transfer(req: TransferRequest, tok: str = Depends(current_token)):
    pinlock.assert_access(req.src_drive, tok)
    pinlock.assert_access(req.dst_drive, tok)
    src = registry.get(req.src_drive)
    dst = registry.get(req.dst_drive)
    if not src or not dst:
        raise HTTPException(404, "Drive not found")
    if not src.mount_point or not dst.mount_point:
        raise HTTPException(409, "Both drives must be mounted")
    if src.id == dst.id:
        raise HTTPException(400, "Pick a different destination drive")
    if not req.paths:
        raise HTTPException(400, "Nothing selected")

    src_root = Path(src.mount_point)
    dst_root = _safe_path(Path(dst.mount_point), req.dst_path)
    if not dst_root.is_dir():
        raise HTTPException(400, "Destination is not a directory")

    # Destination must be writable. Enable write on demand (like upload does).
    if dst.state == "mounted_ro":
        from drives.mount import remount_rw, ALWAYS_RO
        if dst.fstype.lower() in ALWAYS_RO:
            raise HTTPException(409, f"{dst.fstype} destination is read-only")
        try:
            remount_rw(dst)
            dst.state = "mounted_rw"
            registry.update(dst)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(500, f"Could not enable write on destination: {exc}")

    with _transfer_lock:
        if _transfer["running"]:
            raise HTTPException(409, "A transfer is already running")
        _transfer.update(running=True, done=0, total=0, file="", error=None,
                         copied=0, count=len(req.paths))
    threading.Thread(target=_transfer_worker,
                     args=(src_root, dst_root, req.paths, req.move),
                     daemon=True, name="ll-transfer").start()
    return {"status": "started"}


@router.get("/transfer/status")
def transfer_status(_: str = Depends(require_auth)):
    return dict(_transfer)


@router.delete("")
def delete(req: DeleteRequest, tok: str = Depends(current_token)):
    import shutil
    pinlock.assert_access(req.drive, tok)
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
