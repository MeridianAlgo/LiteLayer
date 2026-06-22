"""
Mount logic unit tests — mock subprocess, no root needed.

For the real loopback integration test (needs root + Linux):
    sudo pytest tests/test_mount.py::test_loopback_integration -v
"""
import subprocess
import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path

from drives.registry import Drive


def _make_drive(device="/dev/sdb1", fstype="ext4", state="unmounted", mp=None):
    return Drive(
        id="test-uuid-1234",
        device=device,
        label="TestDrive",
        fstype=fstype,
        size_bytes=1_000_000_000,
        used_bytes=0,
        free_bytes=1_000_000_000,
        state=state,
        mount_point=mp,
    )


def test_system_disk_rejected(tmp_path, monkeypatch):
    """mount() must refuse if the device is the root filesystem device."""
    from drives import mount as m

    # Force _get_sys_devs to return our test device
    monkeypatch.setattr(m, "_sys_devs_cache", {"/dev/sdb1"})

    drive = _make_drive(device="/dev/sdb1")
    with pytest.raises(PermissionError, match="system device"):
        m.mount(drive)


def test_always_ro_filesystems(tmp_path, monkeypatch):
    """hfsplus must always mount read-only even if read_write=True."""
    from drives import mount as m

    monkeypatch.setattr(m, "_sys_devs_cache", set())

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        r = MagicMock()
        r.returncode = 0
        r.stderr = ""
        return r

    with patch("drives.mount.subprocess.run", side_effect=fake_run):
        with patch.object(Path, "mkdir"):
            drive = _make_drive(fstype="hfsplus")
            m.mount(drive, read_write=True)

    # Should have 'ro' in the options string
    opts_str = " ".join(calls[0])
    assert "ro" in opts_str
    assert "rw" not in opts_str


def test_ext4_mounts_ro_by_default(tmp_path, monkeypatch):
    from drives import mount as m

    monkeypatch.setattr(m, "_sys_devs_cache", set())

    captured = []

    def fake_run(cmd, **kwargs):
        captured.append(cmd)
        r = MagicMock(); r.returncode = 0; r.stderr = ""; return r

    with patch("drives.mount.subprocess.run", side_effect=fake_run):
        with patch.object(Path, "mkdir"):
            m.mount(_make_drive(fstype="ext4"), read_write=False)

    opts = captured[0]
    opts_str = " ".join(opts)
    assert "ro" in opts_str


def test_unmount_calls_umount(monkeypatch):
    from drives import mount as m
    monkeypatch.setattr(m, "_sys_devs_cache", set())

    calls = []
    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        r = MagicMock(); r.returncode = 0; r.stderr = ""; return r

    with patch("drives.mount.subprocess.run", side_effect=fake_run):
        drive = _make_drive(state="mounted_ro", mp="/srv/litelayer/mounts/test-uuid-1234")
        m.unmount(drive)

    assert calls[0][0] == "umount"


@pytest.mark.skipif(
    subprocess.run(["id", "-u"], capture_output=True).stdout.strip() != b"0",
    reason="needs root"
)
def test_loopback_integration(tmp_path):
    """
    Real mount: create a small ext4 loopback image, mount it, list a file, unmount.
    Requires root and Linux (run on the Pi).
    """
    import os
    from drives import mount as m, registry

    m._sys_devs_cache = set()  # don't let it think our loop is system disk

    img = tmp_path / "disk.img"
    mp  = tmp_path / "mnt"
    mp.mkdir()

    # Create 16 MB ext4 image
    subprocess.run(["dd", "if=/dev/zero", f"of={img}", "bs=1M", "count=16"], check=True)
    subprocess.run(["mkfs.ext4", "-q", str(img)], check=True)

    # Find a free loop device
    lo = subprocess.run(["losetup", "--find", "--show", str(img)],
                        capture_output=True, text=True, check=True).stdout.strip()
    try:
        drive = Drive(
            id="looptest", device=lo, label="LoopTest",
            fstype="ext4", size_bytes=16*1024*1024,
            used_bytes=0, free_bytes=16*1024*1024,
            state="unmounted",
        )

        # Patch MOUNT_ROOT so it uses our tmp dir
        monkeypatch = None  # running at module level, patch manually
        import app.config as cfg
        orig = cfg.MOUNT_ROOT
        cfg.MOUNT_ROOT = tmp_path

        result_mp = m.mount(drive)
        assert Path(result_mp).is_mount()

        # Write a file (we're root) and check it lists
        (Path(result_mp) / "hello.txt").write_text("litelayer test")
        from app.routers.files import _safe_path
        p = _safe_path(Path(result_mp), "/hello.txt")
        assert p.read_text() == "litelayer test"

        m.unmount(Drive(id="looptest", device=lo, label="x", fstype="ext4",
                        size_bytes=0, used_bytes=0, free_bytes=0,
                        state="mounted_ro", mount_point=result_mp))
        assert not Path(result_mp).is_mount()
        cfg.MOUNT_ROOT = orig
    finally:
        subprocess.run(["losetup", "-d", lo], check=False)
