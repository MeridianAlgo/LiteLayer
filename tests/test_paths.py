"""Path confinement — no root required."""
import os
import tempfile
from pathlib import Path
import pytest
from fastapi import HTTPException


def _safe_path(drive_root: Path, user_path: str) -> Path:
    # Mirror the function from app/routers/files.py
    target = (drive_root / user_path.lstrip("/")).resolve()
    if not target.is_relative_to(drive_root.resolve()):
        raise HTTPException(403, "Path escape rejected")
    return target


@pytest.fixture
def root(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "readme.txt").write_text("hello")
    (tmp_path / "photos").mkdir()
    return tmp_path


def test_normal_path(root):
    p = _safe_path(root, "/docs/readme.txt")
    assert p == (root / "docs" / "readme.txt").resolve()


def test_root_path(root):
    p = _safe_path(root, "/")
    assert p == root.resolve()


def test_dotdot_escape_rejected(root):
    with pytest.raises(HTTPException) as exc:
        _safe_path(root, "/../etc/passwd")
    assert exc.value.status_code == 403


def test_dotdot_in_middle_rejected(root):
    with pytest.raises(HTTPException):
        _safe_path(root, "/docs/../../etc/shadow")


def test_absolute_escape_rejected(root):
    with pytest.raises(HTTPException):
        _safe_path(root, "/etc/passwd")


def test_symlink_escape_rejected(root):
    """A symlink inside the drive that points outside must be rejected after resolve."""
    link = root / "evil"
    link.symlink_to("/etc")
    with pytest.raises(HTTPException):
        _safe_path(root, "/evil/passwd")


def test_nested_valid_path(root):
    deep = root / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (deep / "file.txt").write_text("x")
    p = _safe_path(root, "/a/b/c/file.txt")
    assert p.exists()


def test_leading_slash_stripped(root):
    p = _safe_path(root, "docs/readme.txt")
    assert p == (root / "docs" / "readme.txt").resolve()
