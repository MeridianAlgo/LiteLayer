#!/usr/bin/env python3
"""LiteLayer CLI — a thin HTTP client over the same REST API the web UI uses.

Pure stdlib (argparse + http.client) so it installs with zero dependencies and
streams uploads/downloads instead of buffering whole files in RAM.

  litelayer login [--url URL]        log in (prompts pw + 2FA), save Bearer token
  litelayer drives                   list drives
  litelayer ls DRIVE [PATH]          list a folder
  litelayer get DRIVE PATH [-o DST] [-r]   download a file (or -r a folder)
  litelayer put DRIVE PATH LOCAL...  upload file(s) into a folder
  litelayer mkdir DRIVE PATH         make a folder
  litelayer mv DRIVE SRC... DEST     move within a drive
  litelayer rm DRIVE PATH...         delete
  litelayer find DRIVE QUERY         recursive name search
  litelayer logout                   revoke token + wipe local config

DRIVE may be a drive UUID, its label, or its device name (e.g. sda1).
Config: ~/.config/litelayer/config.json (0600). Env: LITELAYER_URL, LITELAYER_TOKEN.
"""
import argparse
import getpass
import http.client
import json
import os
import posixpath
import ssl
import sys
from urllib.parse import urlsplit, urlencode, quote

DEFAULT_URL = "http://litelayer.local"


# ── config ────────────────────────────────────────────────────────────────────
def _config_path() -> str:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "litelayer", "config.json")


def _load_config() -> dict:
    try:
        with open(_config_path()) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    # Env always wins — for CI/scripts and for --url override plumbed in below.
    if os.environ.get("LITELAYER_URL"):
        cfg["url"] = os.environ["LITELAYER_URL"]
    if os.environ.get("LITELAYER_TOKEN"):
        cfg["token"] = os.environ["LITELAYER_TOKEN"]
    return cfg


def _save_config(cfg: dict) -> None:
    path = _config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Create 0600 up front so the token is never briefly world-readable.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
    try:
        os.chmod(path, 0o600)  # no-op-ish on Windows, real on POSIX
    except OSError:
        pass


def _die(msg: str, code: int = 1):
    print(f"litelayer: {msg}", file=sys.stderr)
    sys.exit(code)


# ── HTTP ────────────────────────────────────────────────────────────────────
class ApiError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status
        self.detail = detail


_warned: set = set()


def _warn_once(key: str, msg: str) -> None:
    if key not in _warned:
        _warned.add(key)
        print(f"warning: {msg}", file=sys.stderr)


def _connect(url: str, insecure: bool, timeout):
    u = urlsplit(url)
    host, port = u.hostname, u.port
    if u.scheme == "https":
        if insecure:
            _warn_once("insecure", "TLS certificate verification is OFF (--insecure) — "
                                   "the connection is not authenticated and can be intercepted")
        ctx = ssl._create_unverified_context() if insecure else ssl.create_default_context()
        return http.client.HTTPSConnection(host, port, context=ctx, timeout=timeout)
    # Plaintext to a non-local host means a token/password crosses the wire in the clear.
    if host not in ("localhost", "127.0.0.1", "::1") and not (host or "").endswith(".local"):
        _warn_once("plain:" + str(host),
                   f"using plain HTTP to {host} — token/password sent unencrypted")
    return http.client.HTTPConnection(host, port, timeout=timeout)


def _request(cfg, method, path, *, query=None, body=None, ctype=None,
             insecure=False, timeout=30, auth=True):
    """Open a connection and send the request. Returns (response, conn); the caller
    reads the response then closes conn. Use _json() for the common read-and-parse."""
    url = cfg.get("url") or DEFAULT_URL
    full = path + ("?" + urlencode(query) if query else "")
    headers = {}
    if auth and cfg.get("token"):
        headers["Authorization"] = "Bearer " + cfg["token"]
    if ctype:
        headers["Content-Type"] = ctype
    conn = _connect(url, insecure, timeout)
    conn.request(method, urlsplit(url).path.rstrip("/") + full, body=body, headers=headers)
    return conn.getresponse(), conn


def _json(cfg, method, path, **kw):
    resp, conn = _request(cfg, method, path, **kw)
    try:
        raw = resp.read()
        if resp.status >= 400:
            detail = raw.decode("utf-8", "replace")
            try:
                detail = json.loads(detail).get("detail", detail)
            except ValueError:
                pass
            raise ApiError(resp.status, detail)
        return json.loads(raw) if raw else {}
    finally:
        conn.close()


def _post_json(cfg, path, obj, **kw):
    return _json(cfg, "POST", path, body=json.dumps(obj).encode(),
                ctype="application/json", **kw)


# ── helpers ─────────────────────────────────────────────────────────────────
def _human(n: int) -> str:
    for unit in ("B", "K", "M", "G", "T"):
        if n < 1024 or unit == "T":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}T"


def _resolve_drive(cfg, ref, insecure):
    """Accept a UUID, a (case-insensitive) label, or a device name like sda1."""
    drives = _json(cfg, "GET", "/api/drives", insecure=insecure)
    for d in drives:
        if d["id"] == ref:
            return d
    low = ref.casefold()
    for d in drives:
        if d.get("label", "").casefold() == low or os.path.basename(d.get("device", "")) == ref:
            return d
    raise ApiError(404, f"No drive matches {ref!r}. Run 'litelayer drives' to list them.")


def _need_login(cfg):
    if not cfg.get("token"):
        _die("not logged in — run 'litelayer login' first")


# ── commands ────────────────────────────────────────────────────────────────
def cmd_login(cfg, args):
    url = args.url or cfg.get("url") or DEFAULT_URL
    cfg = {"url": url}  # fresh — a new login shouldn't inherit a stale token
    username = input("Username: ").strip()
    password = getpass.getpass("Password: ")
    payload = {"username": username, "password": password}
    try:
        data = _post_json(cfg, "/api/login", payload, insecure=args.insecure, auth=False)
    except ApiError as e:
        if e.status == 401 and e.detail == "2fa_required":
            payload["code"] = input("2FA code: ").strip()
            data = _post_json(cfg, "/api/login", payload, insecure=args.insecure, auth=False)
        else:
            raise
    cfg["token"] = data["token"]
    _save_config(cfg)
    print(f"Logged in as {data['username']} → {url}")


def cmd_logout(cfg, args):
    if cfg.get("token"):
        try:
            _json(cfg, "POST", "/api/logout", insecure=args.insecure)
        except ApiError:
            pass  # revoke best-effort; wipe the local token regardless
    try:
        os.remove(_config_path())
    except OSError:
        pass
    print("Logged out.")


def cmd_drives(cfg, args):
    _need_login(cfg)
    drives = _json(cfg, "GET", "/api/drives", insecure=args.insecure)
    if args.json:
        print(json.dumps(drives, indent=2))
        return
    if not drives:
        print("No drives detected.")
        return
    print(f"{'LABEL':<22} {'FS':<8} {'SIZE':>8} {'STATE':<12} DEVICE")
    for d in drives:
        lock = " [locked]" if d.get("locked") and not d.get("unlocked") else ""
        print(f"{(d['label'] + lock):<22} {d['fstype']:<8} {_human(d['size_bytes']):>8} "
              f"{d['state']:<12} {d['device']}")


def cmd_ls(cfg, args):
    _need_login(cfg)
    d = _resolve_drive(cfg, args.drive, args.insecure)
    listing = _json(cfg, "GET", "/api/files",
                    query={"drive": d["id"], "path": args.path}, insecure=args.insecure)
    if args.json:
        print(json.dumps(listing, indent=2))
        return
    for e in listing["entries"]:
        if e["is_dir"]:
            print(f"{'<dir>':>10}  {e['name']}/")
        else:
            print(f"{_human(e['size_bytes']):>10}  {e['name']}")


def _walk(cfg, drive_id, path, insecure):
    """Yield (rel_path, is_dir) for everything under path, depth-first."""
    listing = _json(cfg, "GET", "/api/files",
                    query={"drive": drive_id, "path": path}, insecure=insecure)
    for e in listing["entries"]:
        yield e["path"], e["is_dir"]
        if e["is_dir"]:
            yield from _walk(cfg, drive_id, e["path"], insecure)


def _download_one(cfg, drive_id, remote, dest, insecure):
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    resp, conn = _request(cfg, "GET", "/api/files/download",
                          query={"drive": drive_id, "path": remote},
                          insecure=insecure, timeout=None)
    try:
        if resp.status >= 400:
            raise ApiError(resp.status, resp.read().decode("utf-8", "replace"))
        with open(dest, "wb") as f:
            while chunk := resp.read(1024 * 1024):
                f.write(chunk)
    finally:
        conn.close()
    print(f"downloaded {dest}")


def cmd_get(cfg, args):
    _need_login(cfg)
    d = _resolve_drive(cfg, args.drive, args.insecure)
    if args.recursive:
        base = args.output or posixpath.basename(args.path.rstrip("/")) or "download"
        for rel, is_dir in _walk(cfg, d["id"], args.path, args.insecure):
            sub = posixpath.relpath(rel, args.path)
            parts = [p for p in sub.split("/") if p not in ("", ".")]
            if any(p == ".." for p in parts):  # server shouldn't, but never let it escape base
                _die(f"server returned an out-of-tree path: {rel}")
            local = os.path.join(base, *parts)
            if is_dir:
                os.makedirs(local, exist_ok=True)
            else:
                _download_one(cfg, d["id"], rel, local, args.insecure)
    else:
        dest = args.output or posixpath.basename(args.path.rstrip("/"))
        _download_one(cfg, d["id"], args.path, dest, args.insecure)


def _upload_one(cfg, drive_id, remote_dir, local, insecure):
    name = os.path.basename(local)
    boundary = "----litelayer" + os.urandom(8).hex()
    preamble = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    epilogue = f"\r\n--{boundary}--\r\n".encode()
    size = os.path.getsize(local)

    def body():
        yield preamble
        with open(local, "rb") as f:
            while chunk := f.read(1024 * 1024):
                yield chunk
        yield epilogue

    url = cfg.get("url") or DEFAULT_URL
    q = urlencode({"drive": drive_id, "path": remote_dir})
    conn = _connect(url, insecure, timeout=None)
    conn.request(
        "POST", urlsplit(url).path.rstrip("/") + f"/api/files/upload?{q}",
        body=body(),
        headers={
            "Authorization": "Bearer " + cfg["token"],
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(preamble) + size + len(epilogue)),
        },
    )
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    if resp.status >= 400:
        detail = raw.decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except ValueError:
            pass
        raise ApiError(resp.status, detail)
    print(f"uploaded {name}")


def cmd_put(cfg, args):
    _need_login(cfg)
    d = _resolve_drive(cfg, args.drive, args.insecure)
    for local in args.local:
        if os.path.isdir(local):
            if not args.recursive:
                _die(f"{local} is a folder — pass -r to upload it")
            top = os.path.basename(local.rstrip("/\\"))
            for root, _dirs, filenames in os.walk(local):
                rel = os.path.relpath(root, local)
                remote = posixpath.join(args.path, top) if rel == "." else \
                    posixpath.join(args.path, top, *rel.split(os.sep))
                for fn in filenames:
                    _upload_one(cfg, d["id"], remote, os.path.join(root, fn), args.insecure)
        else:
            _upload_one(cfg, d["id"], args.path, local, args.insecure)


def cmd_mkdir(cfg, args):
    _need_login(cfg)
    d = _resolve_drive(cfg, args.drive, args.insecure)
    parent = posixpath.dirname(args.path.rstrip("/")) or "/"
    name = posixpath.basename(args.path.rstrip("/"))
    if not name:
        _die("give a folder path, e.g. /Documents/New")
    _post_json(cfg, "/api/files/mkdir",
               {"drive": d["id"], "path": parent, "name": name}, insecure=args.insecure)
    print(f"created {args.path}")


def cmd_mv(cfg, args):
    _need_login(cfg)
    d = _resolve_drive(cfg, args.drive, args.insecure)
    *paths, dest = args.paths
    if not paths:
        _die("usage: litelayer mv DRIVE SRC... DEST")
    r = _post_json(cfg, "/api/files/move",
                   {"drive": d["id"], "paths": paths, "dest": dest}, insecure=args.insecure)
    print(f"moved {r['count']} item(s) → {dest}")


def cmd_rm(cfg, args):
    _need_login(cfg)
    d = _resolve_drive(cfg, args.drive, args.insecure)
    r = _json(cfg, "DELETE", "/api/files",
              body=json.dumps({"drive": d["id"], "paths": args.paths}).encode(),
              ctype="application/json", insecure=args.insecure)
    print(f"deleted {r['count']} item(s)")


def cmd_find(cfg, args):
    _need_login(cfg)
    d = _resolve_drive(cfg, args.drive, args.insecure)
    r = _json(cfg, "GET", "/api/files/search",
              query={"drive": d["id"], "q": args.query}, insecure=args.insecure)
    if args.json:
        print(json.dumps(r, indent=2))
        return
    for e in r["entries"]:
        print(("d " if e["is_dir"] else "  ") + e["path"])
    if r.get("truncated"):
        print("… results truncated — refine the query", file=sys.stderr)


# ── argparse ────────────────────────────────────────────────────────────────
def build_parser():
    p = argparse.ArgumentParser(prog="litelayer", description="LiteLayer command-line client")
    p.add_argument("--url", help="server URL (overrides saved config)")
    p.add_argument("--insecure", action="store_true", help="skip TLS certificate verification (unsafe)")
    p.add_argument("--json", action="store_true", help="machine-readable JSON output where supported")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("login").add_argument("--url", help="server URL to log in to")
    sub.add_parser("logout")
    sub.add_parser("drives")

    s = sub.add_parser("ls"); s.add_argument("drive"); s.add_argument("path", nargs="?", default="/")

    s = sub.add_parser("get")
    s.add_argument("drive"); s.add_argument("path")
    s.add_argument("-o", "--output"); s.add_argument("-r", "--recursive", action="store_true")

    s = sub.add_parser("put")
    s.add_argument("drive"); s.add_argument("path"); s.add_argument("local", nargs="+")
    s.add_argument("-r", "--recursive", action="store_true")

    s = sub.add_parser("mkdir"); s.add_argument("drive"); s.add_argument("path")
    s = sub.add_parser("mv"); s.add_argument("drive"); s.add_argument("paths", nargs="+")
    s = sub.add_parser("rm"); s.add_argument("drive"); s.add_argument("paths", nargs="+")
    s = sub.add_parser("find"); s.add_argument("drive"); s.add_argument("query")
    return p


_COMMANDS = {
    "login": cmd_login, "logout": cmd_logout, "drives": cmd_drives, "ls": cmd_ls,
    "get": cmd_get, "put": cmd_put, "mkdir": cmd_mkdir, "mv": cmd_mv, "rm": cmd_rm,
    "find": cmd_find,
}


def main(argv=None):
    args = build_parser().parse_args(argv)
    cfg = _load_config()
    if args.url:
        cfg["url"] = args.url
    try:
        _COMMANDS[args.cmd](cfg, args)
    except ApiError as e:
        _die(e.detail, code=2)
    except KeyboardInterrupt:
        _die("cancelled", code=130)
    except (OSError, ConnectionError) as e:
        _die(str(e), code=3)


if __name__ == "__main__":
    main()
