# VPN / Mesh Network Setup

LiteLayer binds Caddy on all interfaces (`0.0.0.0:443`). Any VPN that routes
traffic to the Pi's IP works automatically — no app config changes needed.

---

## Choosing during install

The installer asks which VPN to set up:

```
1) None       — LAN only, add VPN later
2) Tailscale  — easiest; managed; 100 devices free
3) ZeroTier   — 25 devices free; self-hostable control plane
4) Netbird    — open-source WireGuard-based; self-hostable
5) WireGuard  — manual; most control; lowest overhead
6) Cloudflare — public URL, no open ports; free *.trycloudflare.com or your domain
```

To pre-select for scripted/headless installs:
```bash
LITELAYER_VPN=tailscale bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo/LiteLayer/main/installer/install.sh)
```

---

## Tailscale

```bash
# Install
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Option A: Tailscale manages HTTPS (recommended for remote access)
sudo tailscale serve --bg https / http://localhost:8000
# Access: https://<your-tailscale-hostname>

# Option B: use Caddy's local cert over the Tailscale IP
# Access: https://100.x.x.x (Caddy answers, accept the local cert warning)
```

---

## ZeroTier

```bash
curl -fsSL https://install.zerotier.com | bash
sudo zerotier-cli join <network-id>     # get ID from my.zerotier.com
sudo zerotier-cli status                # confirm connected
# Access: https://<zt-assigned-ip>
```

---

## Netbird (open-source, self-hostable)

```bash
curl -fsSL https://pkgs.netbird.io/install.sh | bash
sudo netbird up                         # follow the auth URL
# Access: https://<netbird-ip>
```

---

## WireGuard (manual)

```bash
sudo apt-get install -y wireguard wireguard-tools
# Edit /etc/wireguard/wg0.conf with your server's config
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0
# Access: https://<wg-tunnel-ip>
```

---

## OpenVPN / any other VPN

Once any VPN creates a tunnel interface on the Pi, Caddy answers on it.
No changes to LiteLayer needed. Access via the VPN-assigned IP.

---

## Cloudflare Tunnel

Cloudflare Tunnel reaches LiteLayer from anywhere over an outbound, encrypted
connection — no open ports and no port forwarding. Because it never changes a
network interface or route, it's the one remote-access option that's safe to drive
straight from the UI: toggling it can't cut off your LAN or SSH the way flipping a
mesh VPN can. It also runs alongside any mesh VPN.

### From the UI (recommended)

**Settings → System → Cloudflare Tunnel.**

- **Quick tunnel** — flip *Public URL (quick tunnel)*. LiteLayer installs
  `cloudflared`, starts `litelayer-cloudflare.service`, and shows your free
  `https://<random>.trycloudflare.com` URL once it's up (also under
  **Settings → About → Public URL**). No Cloudflare account needed. The URL changes
  whenever the tunnel restarts.
- **Your own domain** — under *Use your own domain (Cloudflare token)*, paste the
  connector token from your Cloudflare Zero Trust tunnel for a stable custom
  hostname. The token is written to `/etc/litelayer/cloudflare.env` (never passed
  through a shell) and the service runs `cloudflared tunnel run --token <token>`.

The service unit defaults to the quick tunnel:

```ini
ExecStart=/usr/bin/cloudflared tunnel $CF_TUNNEL_ARGS
Environment=CF_TUNNEL_ARGS=--url http://localhost:8000
EnvironmentFile=-/etc/litelayer/cloudflare.env   # token mode overrides CF_TUNNEL_ARGS
```

### Manual / named tunnel over SSH

For a fully named tunnel with DNS managed by the CLI:

```bash
# Install cloudflared (Debian/Raspberry Pi OS package)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo "$VERSION_CODENAME") main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
sudo apt-get update && sudo apt-get install -y cloudflared

# Authenticate and create the tunnel
cloudflared tunnel login
cloudflared tunnel create litelayer
cloudflared tunnel route dns litelayer litelayer.yourdomain.com

# Run — points directly at the app (bypasses Caddy)
cloudflared tunnel run --url http://localhost:8000 litelayer
```

---

## CORS for the separate UI repo

Add your UI dev server origin to `/etc/litelayer/env`, then restart:

```bash
echo "LITELAYER_CORS_ORIGINS=http://localhost:3000,https://ui.yourdomain.com" \
  >> /etc/litelayer/env
sudo systemctl restart litelayer
```

---

## Changing VPN after install

Edit `/etc/litelayer/env`:
```
LITELAYER_VPN_TYPE=tailscale
```

Then install the VPN manually using the commands above. No other changes needed.
