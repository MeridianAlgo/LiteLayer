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
```

To pre-select for scripted/headless installs:
```bash
LITELAYER_VPN=tailscale bash <(curl -fsSL https://raw.githubusercontent.com/MeridianAlgo-Developer/LiteLayer/main/installer/install.sh)
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

## Cloudflare Tunnel (future / planned)

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture) \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create litelayer
cloudflared tunnel route dns litelayer litelayer.yourdomain.com

# Run — points directly at the app (bypasses Caddy)
cloudflared tunnel run --url http://localhost:8000 litelayer
```

The `# TODO: cf-tunnel` marker in `Caddyfile` documents this seam.

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
