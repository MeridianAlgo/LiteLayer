# Security

LiteLayer is built to sit on your home network and, optionally, be reachable from
anywhere through a Cloudflare tunnel. These are the controls that protect it.

## Sign-in

- **Passwords** are hashed with argon2 (never stored or logged in plaintext).
- **Brute-force throttle** — repeated failed logins from an IP are locked out with an
  *escalating* delay (1 min, then 2, 4, …) that **persists across restarts**, so an
  attacker can't reset it by waiting for a reboot. The same throttle guards drive PINs.
- **Two-factor authentication (TOTP)** — optional. Turn it on in *Settings → Account*;
  scan the QR with any authenticator app. After that, sign-in needs your password **and**
  a 6-digit code. The secret is generated and stored on the Pi and never leaves it.

## Devices & sessions

- **Trusted devices** (*Settings → Devices*) — an allowlist of devices that may sign in.
  Turn on *"Only trusted devices can sign in"* and even the correct password is refused
  from a device that isn't on the list.
- **Session ↔ device binding** — a session cookie only works from the device that
  created it. A stolen session cookie is useless on another machine.
- **Active sign-ins** — see every logged-in session and **"Sign out everywhere else"** in
  one click.
- **Secure cookies** are set automatically when LiteLayer is reached over HTTPS or the
  tunnel (forceable with `LITELAYER_COOKIE_SECURE=1`).

## The terminal

The built-in shell runs as the LiteLayer user (root on a stock install) and is the
biggest attack surface, so:

- it can be **switched off entirely** in *Settings → System* (re-enabling needs your
  password), and
- **opening it requires a fresh password** (a one-time ticket), so a hijacked session
  alone can't drop into a root shell.

## Audit log

Auth events, 2FA changes, device add/remove, PIN failures, credential changes and
terminal access are recorded to `audit.log` (and shown under *Settings → Devices →
Recent security activity*).

## Web hardening

- Security headers (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  a Content-Security-Policy) are set by the app itself, so they apply on the tunnel path
  too (not just behind Caddy).
- **CSRF** — cookie-authenticated, state-changing requests are rejected unless they come
  from an allowed origin.

## Encryption at rest (LUKS)

Drive *data* is stored as-is — anyone who physically takes a drive can read it. For
sensitive data, encrypt the drive with LUKS. LiteLayer shows whether a drive is LUKS
(*drive → Properties → Encryption*) but does **not** format drives itself (that would
erase data). Set it up manually:

```sh
# WARNING: cryptsetup luksFormat ERASES the target. Pick the right device!
sudo cryptsetup luksFormat /dev/sdX1
sudo cryptsetup open /dev/sdX1 mydrive
sudo mkfs.ext4 /dev/mapper/mydrive
```

Unlock it (`cryptsetup open`) before LiteLayer mounts it. Automatic in-app LUKS
provisioning is a future addition — it's deliberately manual for now because formatting
is destructive.

## Reporting

Found something? Email meridianalgo@gmail.com.
