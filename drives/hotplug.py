"""
Hotplug detection via pyudev with a polling fallback.
Refreshes the drive registry on any block device change.
"""
import logging
import threading
import time

log = logging.getLogger(__name__)


def _refresh() -> None:
    from drives import detect, registry
    try:
        drives = detect.enumerate_drives()
        registry.replace_all(drives)
        log.info("registry refreshed: %d drives", len(drives))
    except Exception as exc:
        log.error("drive refresh failed: %s", exc)


def _udev_monitor() -> bool:
    try:
        import pyudev
        ctx = pyudev.Context()
        mon = pyudev.Monitor.from_netlink(ctx)
        mon.filter_by(subsystem="block")

        def _handle(action, device):
            if action in ("add", "remove", "change"):
                log.info("udev %s %s", action, device.device_node)
                _refresh()

        obs = pyudev.MonitorObserver(mon, _handle)
        obs.daemon = True
        obs.start()
        log.info("pyudev monitor active")
        return True
    except Exception as exc:
        log.warning("pyudev unavailable (%s), using poll fallback", exc)
        return False


def _poll_loop() -> None:
    while True:
        time.sleep(5)
        _refresh()


def start() -> None:
    """Call once at app startup."""
    _refresh()
    if not _udev_monitor():
        t = threading.Thread(target=_poll_loop, daemon=True, name="drive-poll")
        t.start()
