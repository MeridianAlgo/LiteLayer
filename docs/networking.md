# Networking

LiteLayer binds Caddy on all interfaces (`0.0.0.0:443`).
Any VPN that routes traffic to the Pi's IP works without app changes.

→ **VPN setup guide: [vpn.md](vpn.md)**

---

## Caddy & TLS

Caddy issues a local self-signed certificate via its built-in CA.

On first browser visit you'll see a TLS warning — add a security exception,
or install the Caddy root CA on your devices:

```bash
# On the Pi:
cat /usr/local/share/ca-certificates/caddy-local-authority-*.crt

# Android/iOS: copy and install the .crt via Settings → Security
# macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain caddy-local-authority.crt
# Windows: certutil -addstore Root caddy-local-authority.crt
```

For a real domain with ACME certs, replace `local_certs` in `Caddyfile`:

```caddy
{
    email you@example.com
}

yourdomain.com {
    reverse_proxy localhost:8000
}
```

---

## CORS for the separate UI repo

Add your UI dev origin to `/etc/litelayer/env`:

```
LITELAYER_CORS_ORIGINS=http://localhost:3000,https://ui.yourdomain.com
```

```bash
sudo systemctl restart litelayer
```

---

## Firewall

Open on the Pi:
- `443/tcp` — Caddy HTTPS (required)
- `80/tcp`  — Caddy HTTP→HTTPS redirect (optional)
- `41641/udp` — Tailscale (if used)
- `9993/udp`  — ZeroTier (if used)

The backend (`0.0.0.0:8000`) is proxied by Caddy; you don't need to expose it directly.

---

## mDNS / litelayer.local

avahi-daemon advertises `litelayer.local` on the LAN so you can reach the UI
without knowing the Pi's IP address.

```bash
# Verify mDNS is working from another device
ping litelayer.local
```

If `litelayer.local` doesn't resolve, check avahi is running on the Pi:
```bash
sudo systemctl status avahi-daemon
```

---

## Cloudflare Tunnel

`cloudflared` connects outbound to Cloudflare and proxies to `localhost:8000`.
Caddy is not involved in tunnel traffic.

See [vpn.md](vpn.md) for full tunnel setup.
