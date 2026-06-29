# LiteLayer

[![Latest tag](https://img.shields.io/github/v/tag/MeridianAlgo/LiteLayer?label=release&sort=semver)](https://github.com/MeridianAlgo/LiteLayer/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Platform](https://img.shields.io/badge/platform-Raspberry%20Pi%203--5-c51a4a.svg)](#compatibility)
[![Python](https://img.shields.io/badge/python-3.9%2B-3776ab.svg)](#stack)

**A secure, self-hosted NAS backend for the Raspberry Pi.** Plug in any drive with
any filesystem and browse or download its files from any device — over your LAN or
any VPN. Drives mount **read-only by default**, so your data is never modified or
reformatted.

[**Website**](https://meridianalgo.github.io/LiteLayer/) · [Setup guide](#complete-setup-guide-pi--litelayer) · [How it compares](#how-it-compares) · [API](#api)

> **Architecture note** — this repository is the storage backend only. The
> production web UI lives in a separate `litelayer-ui` repository.
> `dev-ui/index.html` here is a development tool, not the shipped UI.

---

## Highlights

- **Reads any drive, untouched.** ext4, NTFS, exFAT, FAT32, Btrfs, XFS, HFS+, F2FS, and more — with kernel auto-detect as the fallback. Existing data is never erased.
- **Safe by default.** Read-only on mount; write is an explicit per-drive opt-in. No code path runs `mkfs`, `fdisk`, or `parted`.
- **Reachable anywhere.** Browse from a phone or laptop over LAN or any VPN — local mesh (ZeroTier, WireGuard) or remote access (Tailscale, Cloudflare Tunnel). Switch between installed VPNs from **Settings → System**, no reboot.
- **One-click public URL.** Turn on a **Cloudflare Tunnel** from **Settings → System** to reach LiteLayer from anywhere — no open ports, no port forwarding. Use the free `*.trycloudflare.com` quick tunnel, or paste a Cloudflare token to serve it on your own domain.
- **Your look follows you.** Theme, accent, and custom colors **sync across devices**, encrypted at rest on the Pi. Set it on your laptop, sign in on your phone, and everything matches.
- **Real file manager.** Right-click for **Properties** or **New file**, rename without re-typing the extension, toggle **Autosave** in the editor, and upload whole folders (subdirs preserved) with a live progress bar.
- **Stays signed in where it matters.** If a terminal session expires, re-auth in place — no logging out of the whole app.
- **Lightweight.** Installs onto the Raspberry Pi OS you already run. No database, no Docker — runs on a 512 MB Pi Zero 2 W.
- **Updates in place.** OTA over GitHub with a one-click apply and pinned version rollback.

---

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh)
```

Supports Pi 3 → Pi 5, 32- and 64-bit Raspberry Pi OS (Bullseye or newer; Bookworm recommended).
Full walkthrough in the [setup guide](#complete-setup-guide-pi--litelayer) below.

---

## How it compares

LiteLayer is a **backend layer, not a full operating system.** You install it onto
the Raspberry Pi OS you already run, rather than flashing a dedicated NAS appliance
or standing up a container stack. That keeps the footprint small and the failure
surface narrow.

| | **LiteLayer** | OpenMediaVault | TrueNAS SCALE | CasaOS / Umbrel | Samba (raw) |
|---|---|---|---|---|---|
| Deployment model | Service on your existing OS | Full NAS OS (flash an image) | Full NAS OS + ZFS | Docker app platform | Config files, no UI |
| Minimum RAM | Runs on **512 MB** (Pi Zero 2 W) | ~1 GB recommended | **8 GB** documented minimum | ~2 GB (Docker + apps) | Minimal |
| Architecture | ARM — Pi 3–5 (ARMv7/ARM64) | x86-64 + ARM (OMV-Extras) | x86-64 only | x86-64 + ARM | Any |
| Runtime dependencies | Python venv + Caddy, no DB | nginx + PHP-FPM stack | Linux + ZFS + Kubernetes | Docker daemon | `smbd` |
| Drive handling | Auto-detect, read-only first | Manual mount + share setup | ZFS pools | Varies by app | Manual share config |
| Reformats your disks? | **Never** | Optional | Yes (creates ZFS pools) | Varies | No |
| Built-in web UI | Yes | Yes | Yes | Yes | No |

**How much lighter, concretely:** LiteLayer's supported memory floor is **512 MB**
versus TrueNAS SCALE's documented **8 GB** minimum — roughly a **16× lower floor** —
and it needs no database, no container runtime, and no dedicated disk.

> Figures are each project's **published minimums or recommendations**, not measured
> runtime usage; LiteLayer's is its lowest supported board. This is deliberately not
> apples-to-apples: TrueNAS and OpenMediaVault are full appliances with features
> (ZFS, RAID, plugin ecosystems) that LiteLayer does not attempt to match. LiteLayer
> aims at the opposite end — the smallest thing that safely serves a drive you
> already have.

---

## Complete Setup Guide: Pi → LiteLayer

Everything from zero to a working NAS. About 15–20 minutes total.

### What you need

| Item | Notes |
|------|-------|
| Raspberry Pi | Pi 3B+, Pi 4, Pi 4B, Pi Zero 2W, or Pi 5 |
| MicroSD card | 8 GB minimum; class 10 / A1 or faster |
| Power supply | Official Pi PSU — cheap cables cause random crashes |
| Network connection | Ethernet cable (easier) or Wi-Fi credentials |
| Another computer | Windows, macOS, or Linux — to write the SD image |

---

### Step 1 — Flash Raspberry Pi OS

**1.1** Download **Raspberry Pi Imager** from https://www.raspberrypi.com/software/ and install it.

**1.2** Open Imager. You'll see three buttons: **CHOOSE DEVICE**, **CHOOSE OS**, **CHOOSE STORAGE**.

**1.3** Click **CHOOSE DEVICE** and select your Pi model.

**1.4** Click **CHOOSE OS**:
- → **"Raspberry Pi OS (other)"**
- → **"Raspberry Pi OS Lite (64-bit)"** — headless, no desktop, ideal for a NAS
- If you have a Pi 3 or older and see issues, choose the 32-bit Lite version instead.

**1.5** Click **CHOOSE STORAGE** and select your microSD card.
> Note: This will erase everything on that card — double-check the device name before proceeding.

**1.6** Click **NEXT** → **EDIT SETTINGS** when prompted. Fill in all tabs:

*General tab:*
- **Set hostname** — e.g. `litelayer` (you'll access it as `litelayer.local`)
- **Set username and password** — username `pi`, choose a strong password
- **Configure wireless LAN** — enter your Wi-Fi SSID, password, and country code (skip if using Ethernet)
- **Set locale** — your timezone and keyboard layout

*Services tab:*
- **Enable SSH** → **"Use password authentication"**

Click **SAVE**, then **YES** to confirm writing.

**1.7** Wait 3–5 minutes while Imager writes and verifies. When it says "Write successful", click **CONTINUE** and safely eject the card.

---

### Step 2 — First boot

**2.1** Insert the microSD card into your Pi.

**2.2** If using Ethernet, plug the cable in now. Then plug in power.

**2.3** Wait **60–90 seconds** for the first-boot setup to complete. The green activity LED will stop blinking rapidly when it's done.

**2.4** Find the Pi's IP address — try each of these until one works:

```bash
# Option A: mDNS (works on most home networks)
ping litelayer.local

# Option B: check your router admin page
# Usually at http://192.168.1.1 or http://192.168.0.1 → look for "Connected devices"

# Option C: network scan (replace subnet to match yours)
nmap -sn 192.168.1.0/24
```

---

### Step 3 — SSH in and update

Open a terminal on your computer and connect:

```bash
ssh pi@litelayer.local
# Or use the IP address: ssh pi@192.168.1.xx
```

The first time you connect, type `yes` to accept the host key fingerprint, then enter your password.

Once logged in, update the system:

```bash
sudo apt update && sudo apt upgrade -y
```

This takes 2–5 minutes. Don't skip it — kernel updates are important for filesystem driver support (ntfs3, exfat, etc.).

---

### Step 4 — Run the LiteLayer installer

In the same SSH session, run the one-liner:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh)
```

The installer will:
1. Install system dependencies (git, python3, caddy, exfatprogs, …)
2. Prompt you to set an admin password for the LiteLayer web UI
3. Ask which VPN to set up — or choose **None** to skip (you can add VPN later)
4. Clone LiteLayer into `/opt/litelayer`
5. Create and enable a systemd service so LiteLayer starts automatically on every boot
6. Start the service immediately

Total time: **3–8 minutes** depending on connection speed.

When you see `LiteLayer is running`, it's ready.

---

### Step 5 — Open LiteLayer in your browser

On any device on the same network, open:

```
http://litelayer.local
```

`litelayer.local` is broadcast on your LAN via mDNS (installed automatically). No need to know the IP — works on macOS, iOS, Android, Linux, and Windows 10+.

If it doesn't resolve (some corporate/managed networks block mDNS), use the IP shown at the end of the installer: `http://192.168.1.xx`

> **Use `http://` not `https://`** — plain HTTP on port 80 has no certificate warning. HTTPS on port 443 is available for VPN clients that need TLS.

Log in with:
- **Username:** `admin`
- **Password:** the password you set during install

You can change your username and password any time from the **Settings** (gear icon) in the top-right corner of the UI.

Plug in a USB drive and click **Refresh** — it will appear automatically.

---

### Headless / scripted install

Skip interactive prompts using environment variables:

```bash
LITELAYER_PASSWORD=yourpassword LITELAYER_VPN=none \
  bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh)
```

VPN options: `tailscale` · `zerotier` · `netbird` · `wireguard` · `cloudflare` · `none`

---

## Security model

| Rule | Detail |
|------|--------|
| Read-only by default | RW is an explicit per-drive opt-in (`POST /api/drives/{id}/enable-write`) |
| System disk protection | Boot disk excluded by tracing `findmnt /` — never touched |
| Path confinement | Every path is realpath-resolved; `..` traversal and symlink escapes return 403 |
| Auth on everything | All `/api/drives` and `/api/files` endpoints require a valid session |
| No formatting | `mount.py` never calls mkfs, fdisk, or parted |

---

## Compatibility

| Hardware | RAM | Notes |
|----------|-----|-------|
| Pi 3 / 3B+ | 1 GB | ARM64 or ARMv7; ntfs3 falls back to ntfs-3g on 32-bit kernels |
| Pi 4 | 2–8 GB | Full support |
| Pi 5 | 4–8 GB | Full support; NVMe HATs work |
| Pi Zero 2W | 512 MB | Low RAM mode (1 uvicorn worker) |
| Future Pi | — | ARM64 Debian-compatible |

**Minimum OS:** Raspberry Pi OS Bullseye (Python 3.9+). Bookworm recommended (Python 3.11, ntfs3 in kernel).

---

## Supported filesystems

| Filesystem | Kernel driver | Notes |
|-----------|---------------|-------|
| ext4 / ext3 / ext2 | built-in | |
| NTFS | ntfs3 | kernel 5.15+; ntfs-3g fallback |
| exFAT | exfat | kernel 5.7+ |
| FAT32 / FAT16 | vfat | |
| Btrfs | btrfs | |
| XFS | xfs | |
| HFS+ | hfsplus | always read-only |
| ISO 9660 / UDF | iso9660, udf | always read-only |
| F2FS | f2fs | Android storage |
| Any other | auto-detect | kernel decides |

---

## Stack

- **API**: Python 3.9+ · FastAPI · uvicorn
- **Drive detection**: `lsblk`/`blkid` + `pyudev` (polling fallback)
- **Auth**: argon2-cffi · HttpOnly session cookie · Bearer token
- **Reverse proxy / TLS**: Caddy (local cert, all interfaces)
- **OTA**: git pull + pip install + systemd restart

---

## API

→ See **[docs/api.md](docs/api.md)** for the full reference.

Interactive Swagger UI at `https://<pi-ip>/docs` after install.

```
POST /api/login                          sign in
GET  /api/drives                         list drives
POST /api/drives/{id}/mount              mount read-only
POST /api/drives/{id}/unmount            eject
POST /api/drives/{id}/enable-write       opt-in read-write
GET  /api/files?drive=&path=             directory listing
GET  /api/files/download?drive=&path=    download file
GET  /api/settings                       pull synced UI settings (encrypted at rest)
PUT  /api/settings                       push synced UI settings
GET  /api/system/cloudflare              Cloudflare Tunnel status + public URL
POST /api/system/cloudflare              enable/disable the tunnel (quick or token)
GET  /api/ota/status                     check for updates
POST /api/ota/update                     apply update
```

### Settings sync

Your appearance choices (theme, accent, custom colors, single-click, status pills, boot-drive view) are stored once on the Pi, **encrypted at rest** with Fernet, and pulled on every sign-in — so a phone shows the same look you set on a laptop. One account, one synced copy; the browser keeps the live values and the Pi keeps the encrypted mirror.

---

## VPN / remote access

→ See **[docs/vpn.md](docs/vpn.md)** for full setup per provider.

Caddy binds on all interfaces — any VPN works without app changes.
Supported (installer can set up): Tailscale · ZeroTier · Netbird · WireGuard · Cloudflare Tunnel.

VPNs group as **local mesh** (ZeroTier, WireGuard) and **remote access** (Tailscale, Cloudflare Tunnel) in **Settings → System → VPN**. Install one over SSH, then click **Use this** to switch — it enables the chosen VPN and turns the others off, no reboot.

### Cloudflare Tunnel (one-click, in the UI)

The Cloudflare Tunnel is the one path you can turn on directly from **Settings → System → Cloudflare Tunnel** — it's an outbound connection, so toggling it can never cut off your LAN or SSH the way flipping a mesh VPN can. It also runs alongside any mesh VPN.

- **Quick tunnel** — flip the toggle. LiteLayer installs `cloudflared`, starts the tunnel, and shows your free `https://<random>.trycloudflare.com` URL. No Cloudflare account, no open ports. The URL changes if the tunnel restarts.
- **Your own domain** — create a tunnel in the Cloudflare Zero Trust dashboard, copy its connector token, and paste it under **Use your own domain** for a stable custom hostname.

Full setup, including the named-tunnel route, is in [docs/vpn.md](docs/vpn.md#cloudflare-tunnel).

---

## OTA updates

→ See **[docs/ota.md](docs/ota.md)** for details.

The UI shows an update banner automatically when a new version is available. Click **Apply update** to update in place.

```bash
# Apply via CLI
sudo /opt/litelayer/installer/update.sh

# Check only
sudo /opt/litelayer/installer/update.sh --check
```

Auto-check runs daily at 03:00 via `litelayer-update.timer`.

---

## Networking

→ See **[docs/networking.md](docs/networking.md)** for CORS, firewall, and Caddy config.

---

## Development (non-Pi)

```bash
git clone https://github.com/MeridianAlgo/LiteLayer
cd LiteLayer
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

# Set admin password
python -c "from auth.store import set_password; set_password('admin', 'dev1234')"

# Run
uvicorn app.main:app --reload
# Open http://localhost:8000
```

---

## Tests

```bash
pytest tests/ -v                                               # all unit tests (no root)
sudo pytest tests/test_mount.py::test_loopback_integration    # needs root + Linux
```

---

## License

MIT
