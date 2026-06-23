# LiteLayer

Secure, self-hosted NAS backend for Raspberry Pi.
Plug in any drive with any filesystem — browse and download files from any device, over LAN or any VPN.

> **Two-repo architecture** — this repo is the storage backend only.
> The production web UI lives in a separate `litelayer-ui` repo.
> `dev-ui/index.html` in this repo is a throwaway dev tool, not the production UI.

---

## One-liner install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh)
```

Supports Pi 3 → Pi 5, 32-bit and 64-bit Raspberry Pi OS (Bullseye+, Bookworm recommended).

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
> ⚠️ This will erase everything on that card — double-check the device name before proceeding.

**1.6** Click **NEXT** → **EDIT SETTINGS** when prompted. Fill in all tabs:

*General tab:*
- ✅ **Set hostname** — e.g. `litelayer` (you'll access it as `litelayer.local`)
- ✅ **Set username and password** — username `pi`, choose a strong password
- ✅ **Configure wireless LAN** — enter your Wi-Fi SSID, password, and country code (skip if using Ethernet)
- ✅ **Set locale** — your timezone and keyboard layout

*Services tab:*
- ✅ **Enable SSH** → **"Use password authentication"**

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

When you see `✓ LiteLayer is running`, it's ready.

---

### Step 5 — Open LiteLayer in your browser

On any device on the same network (or connected VPN), open:

```
https://litelayer.local
```

Or substitute the Pi's IP address: `https://192.168.1.xx`

**Expected TLS warning:** Your browser will show "Your connection is not private" or similar. This is normal — Caddy uses a locally-signed certificate. Click **Advanced** → **Proceed to litelayer.local (unsafe)** to continue.

Log in with:
- **Username:** `admin`
- **Password:** the password you set during install

Plug in a USB drive and click **Refresh** — it will appear automatically.

---

### Headless / scripted install

Skip interactive prompts using environment variables:

```bash
LITELAYER_PASSWORD=yourpassword LITELAYER_VPN=none \
  bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh)
```

VPN options: `tailscale` · `zerotier` · `netbird` · `wireguard` · `none`

---

## What it does

- **Detects any drive you plug in** — ext4, ntfs, exfat, vfat, btrfs, xfs, hfsplus, iso9660, udf, f2fs, and more; kernel auto-detect as final fallback
- **Mounts read-only by default** — your data is never modified or formatted
- **Browse and download** from any browser on your LAN or VPN
- **Updates itself** — OTA via GitHub, daily check, one-command apply from the UI

---

## Security rules

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
| Pi 3 / 3B+ | 1 GB | ✓ ARM64 or ARMv7; ntfs3 falls back to ntfs-3g on 32-bit kernels |
| Pi 4 | 2–8 GB | ✓ Full support |
| Pi 5 | 4–8 GB | ✓ Full support; NVMe HATs work |
| Pi Zero 2W | 512 MB | ✓ Low RAM mode (1 uvicorn worker) |
| Future Pi | — | ✓ ARM64 Debian-compatible |

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
GET  /api/ota/status                     check for updates
POST /api/ota/update                     apply update
```

---

## VPN / remote access

→ See **[docs/vpn.md](docs/vpn.md)** for full setup per provider.

Caddy binds on all interfaces — any VPN works without app changes.
Supported (installer can set up): Tailscale · ZeroTier · Netbird · WireGuard · Cloudflare Tunnel (documented seam).

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
