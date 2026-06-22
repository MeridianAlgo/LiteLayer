# LiteLayer

Secure, self-hosted NAS backend for Raspberry Pi.
Plug in any drive with any filesystem — browse and download files from any device, over LAN or any VPN.

> **Two-repo architecture** — this repo is the storage backend only.
> The production web UI lives in a separate `litelayer-ui` repo.
> `dev-ui/index.html` in this repo is a throwaway dev tool, not the production UI.

---

## One-liner install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo-Developer/LiteLayer/main/installer/install.sh)
```

Supports Pi 3 → Pi 5, 32-bit and 64-bit Raspberry Pi OS (Bullseye+, Bookworm recommended).
The installer asks for an admin password and which VPN (if any) to set up.

Pre-install checklist — prepare your Pi

- MicroSD card (8GB+ recommended) or NVMe HAT for Pi 5
- A machine with SD card writer (Windows / macOS / Linux)
- Network access (Ethernet or Wi‑Fi). For headless Wi‑Fi, you'll need to configure Wi‑Fi on the image before first boot.

Step-by-step: flash Raspberry Pi OS and run the one-liner

1. Download Raspberry Pi Imager from https://www.raspberrypi.com/software/ and install it on your laptop/desktop.
2. Run Raspberry Pi Imager and choose the OS:
  - For modern Pi (Pi 4 / Pi 5): choose "Raspberry Pi OS (other) → Raspberry Pi OS (64-bit)" (Bookworm or Bullseye)
  - For older Pi or if you need 32-bit compatibility: choose the 32-bit image.
3. Select your SD card and click the gear icon (Advanced options) to:
  - enable SSH
  - set a hostname (optional)
  - configure Wi‑Fi (SSID, password, country) if you plan a headless setup
  - set locale/timezone if you want
  Save and write the image to the card.

Alternative (headless without Imager advanced options):
 - After writing the image, create an empty file named `ssh` in the boot partition to enable SSH on first boot.
 - For Wi‑Fi, create a `wpa_supplicant.conf` in the boot partition with your network details (see Raspberry Pi docs).

4. Insert the SD card into the Pi and power it on. Wait ~60s for first-boot setup.
5. Find the Pi's IP address from your router, mDNS (hostname.local), or by scanning (e.g. `nmap -sn 192.168.1.0/24`).
6. SSH into the Pi (default user `pi`, or the account you configured) and update the system:

```bash
ssh pi@<pi-ip>
sudo apt update && sudo apt upgrade -y
```

7. Run the LiteLayer installer one-liner on the Pi (this is the same command above):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo-Developer/LiteLayer/main/installer/install.sh)
```

Headless / scripted install (example with env vars):

```bash
LITELAYER_PASSWORD=yourpassword LITELAYER_VPN=tailscale \
  bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo-Developer/LiteLayer/main/installer/install.sh)
```

VPN options: `tailscale` · `zerotier` · `netbird` · `wireguard` · `none`

### Headless / scripted install

```bash
LITELAYER_PASSWORD=yourpassword LITELAYER_VPN=tailscale \
  bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo-Developer/LiteLayer/main/installer/install.sh)
```

VPN options: `tailscale` · `zerotier` · `netbird` · `wireguard` · `none`

---

## What it does

- **Detects any drive you plug in** — ext4, ntfs, exfat, vfat, btrfs, xfs, hfsplus, iso9660, udf, f2fs, and more; kernel auto-detect as final fallback
- **Mounts read-only by default** — your data is never modified or formatted
- **Browse and download** from any browser on your LAN or VPN
- **Updates itself** — OTA via GitHub, daily check, one-command apply

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

Quick reference:

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
Supported (installer can set up): Tailscale · ZeroTier · Netbird · WireGuard · OpenVPN · Cloudflare Tunnel (documented seam).

---

## OTA updates

→ See **[docs/ota.md](docs/ota.md)** for details.

```bash
# Check for update
GET https://<pi-ip>/api/ota/status

# Apply via API
POST https://<pi-ip>/api/ota/update

# Apply via CLI
sudo /opt/litelayer/installer/update.sh
```

Auto-check runs daily at 03:00 via `litelayer-update.timer`.

---

## Networking

→ See **[docs/networking.md](docs/networking.md)** for CORS, firewall, and Caddy config.

---

## Development (non-Pi)

```bash
git clone https://github.com/MeridianAlgo-Developer/LiteLayer
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
