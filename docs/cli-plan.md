# LiteLayer CLI — implementation plan

A small command-line client so you can drive LiteLayer from your own machine instead
of the web UI. It talks to the **same HTTP API the UI uses** — no new server code, no
new attack surface. Nothing here is built yet; this is the plan.

## Is it possible?

Yes, and it's mostly straightforward. LiteLayer already exposes a complete REST API
(`docs/api.md`): auth, drive list/mount, file list/download/upload/move/delete, search,
transfer. A CLI is just a thin HTTP client over that. The **home-network** case is easy;
**from-anywhere** is a config detail, not a rewrite (see below).

## Scope (v1 — home network)

```
litelayer login [--url http://litelayer.local]   # prompt for user/pass (+2FA), save token
litelayer drives                                  # list drives (name, fs, size, mounted?)
litelayer ls <drive> [path]                       # list a folder
litelayer get <drive> <path> [-o dest]            # download a file (or -r for a folder)
litelayer put <drive> <path> <local>...           # upload file(s) into a folder
litelayer mkdir <drive> <path>
litelayer mv <drive> <src>... <dest>
litelayer rm <drive> <path>...
litelayer find <drive> <query>                    # recursive search
litelayer logout
```

Nice-to-have later: `cp` (cross-drive transfer with a progress bar), `tree`, shell
completion, `--json` output for scripting.

## Design (lazy, no new dependencies where possible)

- **Language:** Python + `argparse` + `urllib`/`httpx`. The backend is already Python;
  reuse `requirements` (httpx is pulled in by FastAPI/starlette). One file,
  `cli/litelayer.py`, exposed as a `litelayer` console-script in `pyproject`/`setup`.
  Installable with `pipx install litelayer` or `pip install .`.
  - *ponytail:* argparse + httpx covers all of this; no Click/Typer needed for ~10
    commands.
- **Auth = the existing token, done right.** `login` POSTs `/api/login` (prompt for the
  password with `getpass`, and the TOTP code if the server answers `2fa_required`), then
  stores the returned **Bearer token** in `~/.config/litelayer/config.json`, mode
  `0600`. Every later call sends `Authorization: Bearer <token>` — this is exactly the
  cross-origin API path the web UI uses, so no server change is needed.
  - Note: the Bearer token is **not** device-bound (see F-02 in `security-findings.md`)
    — that's intentional for a real API client, but it means the CLI's saved token is a
    standing credential. Keep the file `0600`; `logout` deletes it and calls
    `/api/logout`.
- **Config:** `{ "url": "...", "token": "..." }`. `--url` overrides; `LITELAYER_URL` /
  `LITELAYER_TOKEN` env vars for CI/scripts.
- **Uploads** reuse `POST /api/files/upload?drive=&path=` (multipart, one file per
  request — the same call the UI makes). Folder upload = walk locally, recreate the
  relative path in the `path=` query per file (the server `mkdir -p`s it).
- **Downloads** stream `GET /api/files/download` to disk in chunks. Folder download =
  `find`-then-fetch, or add a small server `zip` endpoint later if it's worth it.

## From anywhere (v2)

Two paths, no CLI rewrite — only the `--url` changes:

1. **Cloudflare tunnel (already built in).** Turn on the tunnel in *Settings → System*,
   point the CLI at the `*.trycloudflare.com` / your-domain URL. Works today with the v1
   CLI as-is. The token auth and HTTPS are already there.
2. **VPN (Tailscale/WireGuard/ZeroTier — already supported).** Join the same VPN, use
   the Pi's VPN IP/hostname as `--url`. Also works with v1 unchanged.

So "from anywhere" is a **documentation + config** task, not new code — because remote
access is already solved at the network layer. The only code nicety worth adding is
`litelayer login` auto-discovering the tunnel URL from `/api/system/info`
(`cloudflare_domain`) so users don't copy-paste it.

## Security review of the CLI itself

- Saved token file `0600`, in `~/.config` (not world-readable, not in the repo).
- HTTPS enforced when the URL is remote; warn (don't silently allow) plain-HTTP to a
  non-loopback, non-`.local` host.
- Verify TLS certs by default (no `--insecure` unless explicitly passed, and print a
  loud warning when it is).
- No secrets in argv (password via `getpass`, never a `--password` flag that lands in
  shell history).
- `logout` revokes server-side (`/api/logout`) and wipes the local file.

## Build order

1. `cli/litelayer.py`: config load/save, `login`/`logout`, `drives`, `ls`. (~1 evening)
2. `get` / `put` (streaming, single files). (~1 evening)
3. `mkdir` / `mv` / `rm` / `find`; folder `-r` for get/put. (~1 evening)
4. Package as a console-script; short README section; `--json` for scripting.
5. v2 docs: tunnel/VPN `--url` recipes + auto-discovery of the tunnel URL.

## Effort

v1 (home network, single-file client over the existing API) is small — a few focused
sessions, no backend changes. v2 (from anywhere) is mostly docs because the tunnel and
VPN plumbing already exists. The main judgment call is folder download: start with
client-side walk (zero server change), add a `zip` endpoint only if it proves slow.
