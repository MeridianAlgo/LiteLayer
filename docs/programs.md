# Programs

Import runnable programs from GitHub and LiteLayer keeps them running on the Pi —
continuously, in the background, through crashes and reboots. Manage everything
from **Settings → Programs**.

> **Making a repo LiteLayer-ready?** This page is the only document you need —
> hand it to a developer (or an AI) as-is. [api.md](api.md) is separate: it's
> for driving LiteLayer itself from a terminal or script (importing, starting,
> checking status over HTTP), not for writing a program.

## What every program must have

| Requirement | Details |
|---|---|
| **Long-running process** | The start command must keep running (a server, a worker loop, a bot). One-shot scripts exit immediately and systemd will restart them forever — that's a crash loop, not a program. |
| **Status** | Every program always shows a live status in the UI (see the table below). There is no "unknown by design" state — if it can't be determined the card says so. |
| **Runs in the background** | Each program gets its own systemd unit (`litelayer-prog-<name>`) with `Restart=always`, started on boot. No terminal session required. |
| **Web UI — optional** | If the program serves a web page, give it a **web port** at import time. The card then shows a LAN link, and a **global link** when the Cloudflare tunnel or Tailscale is on. Programs without a web UI are fine — they just show status and logs. |
| **Declared dependencies** | `requirements.txt` (Python — installed into a per-program `.venv`) or `package.json` (Node — `npm install --omit=dev`). Anything else must be preinstalled on the Pi. |
| **Config via environment variables** | Never commit keys or tokens. Read them from environment variables (`os.environ`, `process.env`) and set them in LiteLayer's per-program Secrets store (below). |

## App Store

**Settings → App Store** is a hand-picked catalog of apps known to work with
this pipeline — one click installs (clone → deps → systemd unit) with the right
start command and port pre-filled. Installed apps appear under **Programs** and
are managed exactly like an imported repo.

## Importing

Paste a GitHub URL (`https://github.com/owner/repo` or just `owner/repo`) into
**Settings → Programs → Import from GitHub**. LiteLayer clones the repo to
`/opt/litelayer/programs/<name>`, installs declared dependencies, writes the
systemd unit and starts it.

**Start command** is auto-detected if you leave it blank, in this order:

1. `package.json` with a `start` script → `npm start`
2. `main.py` / `app.py` / `server.py` → `python3 <file>` (the `.venv` python when a `requirements.txt` exists)
3. `index.js` → `node index.js`

If nothing is detected the program lands in **Needs command** — click
*Set start command* on its card. The command runs from the program's folder via
`bash -lc`, so anything you could type in a shell works.

## Statuses

| Status | Meaning |
|---|---|
| **Importing…** | Cloning / installing dependencies / starting. The card shows which phase. |
| **Running** | The systemd unit is active. Green pulsing dot. |
| **Stopped** | Stopped by you (Stop also disables start-on-boot; Start re-enables it). |
| **Failed** | The process keeps exiting — check **Logs** on the card. |
| **Needs command** | Imported, but no start command detected or set. |
| **Import failed** | Clone or dependency install failed; the error shows on the card. Remove and re-import after fixing. |

## Web UIs and the global link

A program that listens on its web port (the port is also passed to it as the
`PORT` environment variable — honor it if you can) gets:

- **LAN link** — `http://<pi-address>:<port>`, for devices on your network/VPN.
- **Global link** — `https://<host>/apps/<name>/`, reverse-proxied through
  LiteLayer. The host is the Cloudflare tunnel domain when the tunnel
  (Settings → System) is connected, otherwise your Tailscale MagicDNS name or
  Tailscale IP when Tailscale is running. A Cloudflare link works from anywhere
  in the world; a Tailscale link works on any device signed in to your tailnet
  (via Caddy on 443 — accept the local-cert warning on plain IPs).

**Public vs private:** the global link is **public by default** — anyone with
the URL can open the program (that's the point of sharing it). Flip the chip on
the card to **Private** to require a LiteLayer sign-in instead.

Global-link limitations (the LAN link has none of these):

- The program is served under the `/apps/<name>/` path. Pages that reference
  assets by absolute path (`/static/app.js`) will 404 through the global link —
  use relative paths or make the base path configurable.
- WebSockets and server-sent events are not proxied. Plain HTTP only.

## Secrets (repository secrets)

GitHub repository secrets live in GitHub Actions and **never leave GitHub** —
they are not cloned with your code. LiteLayer has its own store for the same
job: on a program's card, click **Secrets** and enter one `KEY=VALUE` per line
(blank lines and `#` comments are fine).

How LiteLayer stores them:

- One file per program at `/etc/litelayer/program-env/<name>.env`, permissions
  `0600` (root-only). Never inside the cloned repo folder — a `git pull` or
  program **Update** can't touch or leak them.
- Injected as **environment variables** when the program starts (systemd
  `EnvironmentFile`), so your code just reads `os.environ["API_KEY"]` /
  `process.env.API_KEY`.
- They stay on the Pi: not synced anywhere, not returned by `GET /api/programs`,
  and deleted when the program is removed.
- Saving secrets restarts a running program so it picks up the new values.

## Updates (OTA)

Each program has one of two update modes — pick it at import time (Options →
Updates) or flip the `OTA · …` chip on its card any time:

- **GitHub (default)** — LiteLayer periodically compares your installed copy
  against the repository's latest commit (`git ls-remote`). When GitHub is
  ahead, the card shows an **Update available** badge; clicking **Update** does
  `git pull --ff-only`, reinstalls declared dependencies and restarts the
  program.
- **Self-managed (private OTA)** — for programs that ship their own updater or
  update from somewhere other than the public repo. LiteLayer stops checking
  GitHub and hides its Update button entirely; your program is in charge of
  fetching and applying its own updates. Applying one is easy: after swapping
  its files, the program just exits — systemd (`Restart=always`) brings it back
  up running the new code.

## Managing programs

Each card offers: **Start / Stop / Restart**, **Update** (`git pull --ff-only`
+ dependency reinstall + restart), **Logs** (last lines from the unit's
journal), and **Remove** (stops the unit, deletes the unit file and the cloned
folder — the GitHub repository is untouched).

## API

All endpoints require authentication except the `/apps/` proxy for public programs.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/programs` | GET | List programs with status and links |
| `/api/programs` | POST | Import — `{repo_url, name?, start_command?, web_port?, ota?}` |
| `/api/programs/updates` | GET | OTA check — local vs GitHub HEAD per program |
| `/api/programs/{name}/action` | POST | `{action: "start" \| "stop" \| "restart"}` |
| `/api/programs/{name}` | PUT | Edit — `{start_command?, web_port?, public?, ota?, clear_port?}` |
| `/api/programs/{name}/secrets` | GET / PUT | Read / replace the program's `KEY=VALUE` secrets |
| `/api/programs/{name}/update` | POST | Pull latest code, reinstall deps, restart |
| `/api/programs/{name}` | DELETE | Stop and remove the program |
| `/api/programs/{name}/logs` | GET | Journal tail (`?lines=`) |
| `/apps/{name}/…` | any | Reverse proxy to the program's web port |

## Security notes

- Only `https://github.com/…` repositories are accepted; program names are
  restricted to `a-z 0-9 . _ -`, so nothing can be smuggled into `git clone`,
  unit names or paths.
- Importing a program means **running its code on your Pi** with the same
  privileges as LiteLayer itself. Only import repositories you trust — treat it
  like the terminal.
- The `/apps/` proxy only ever connects to `127.0.0.1:<the registered port>`;
  it cannot be pointed at other hosts or unregistered ports.
- Registry lives at `/etc/litelayer/programs.json`; code at
  `/opt/litelayer/programs/`; secrets at `/etc/litelayer/program-env/` (0600).
