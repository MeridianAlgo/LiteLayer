"""Network helpers — the single source of truth for a caller's real IP.

Anything security-sensitive (throttle keys, audit records) must use client_ip():
the client can forge forwarding headers, so we only trust them from our own local
reverse proxy and otherwise fall back to the TCP peer address.
"""
from fastapi import Request

# Only our own reverse proxies (Caddy, or cloudflared for the tunnel) sit on loopback.
# A request from any other peer reached :8000 directly, so its forwarding headers are
# attacker-supplied and must be ignored.
_TRUSTED_PROXY_IPS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


def client_ip(request: Request) -> str:
    """The client's real IP, non-spoofable.

    Trust forwarding headers ONLY when the direct peer is a local proxy:
      - Cloudflare tunnel: CF-Connecting-IP is set by the Cloudflare edge.
      - Caddy: it *appends* the real peer to X-Forwarded-For, so the rightmost
        entry is the one Caddy added — a client-supplied leftmost value can't move
        it. (Taking [0] was the bug: that entry is whatever the client sent.)
    A direct (non-loopback) caller's headers are ignored in favor of the peer IP,
    which the TCP stack sets and the client can't forge.
    """
    peer = request.client.host if request.client else "?"
    if peer in _TRUSTED_PROXY_IPS:
        cf = request.headers.get("cf-connecting-ip", "").strip()
        if cf:
            return cf
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[-1].strip()
    return peer


# ── self-check ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import types

    def req(peer, **headers):
        return types.SimpleNamespace(
            client=types.SimpleNamespace(host=peer),
            headers={k.replace("_", "-"): v for k, v in headers.items()},
        )

    # Direct attacker on the LAN: spoofed headers ignored, real peer used.
    assert client_ip(req("192.168.1.9", x_forwarded_for="1.2.3.4")) == "192.168.1.9"
    assert client_ip(req("192.168.1.9", **{"cf-connecting-ip": "1.2.3.4"})) == "192.168.1.9"
    # Behind Caddy (loopback): rightmost XFF is the real client, spoof can't move it.
    assert client_ip(req("127.0.0.1", x_forwarded_for="9.9.9.9, 203.0.113.5")) == "203.0.113.5"
    # Behind the Cloudflare tunnel (loopback): trust CF-Connecting-IP.
    assert client_ip(req("127.0.0.1", **{"cf-connecting-ip": "203.0.113.5"})) == "203.0.113.5"
    # No proxy, no headers: peer.
    assert client_ip(req("198.51.100.7")) == "198.51.100.7"
    print("netutil self-check OK")
