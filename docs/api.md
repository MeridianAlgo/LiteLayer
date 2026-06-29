# API Reference

Interactive docs (Swagger UI): `https://<pi-ip>/docs`
OpenAPI JSON: `https://<pi-ip>/openapi.json`

All `/api/drives` and `/api/files` endpoints require authentication.
Pass the session as an HttpOnly cookie (`litelayer_session`) or as
`Authorization: Bearer <token>`.

---

## Auth

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/login` | `{username, password}` | `{token, username}` + sets HttpOnly cookie |
| POST | `/api/logout` | — | `{status: "ok"}` |
| GET  | `/api/me`    | — | `{username}` or 401 |

---

## Drives

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/drives` | List all detected external drives |
| POST | `/api/drives/{id}/mount` | Mount read-only |
| POST | `/api/drives/{id}/unmount` | Eject |
| POST | `/api/drives/{id}/enable-write` | Remount read-write (explicit opt-in) |
| POST | `/api/drives/{id}/disable-write` | Remount read-only |

### Drive object
```json
{
  "id":          "3a7f-uuid",
  "device":      "/dev/sda1",
  "label":       "BackupDrive",
  "fstype":      "ntfs",
  "size_bytes":  500107862016,
  "used_bytes":  210000000000,
  "free_bytes":  290107862016,
  "state":       "mounted_ro",
  "mount_point": "/srv/litelayer/mounts/3a7f-uuid",
  "rw_capable":  true
}
```

`state` values: `unmounted` | `mounted_ro` | `mounted_rw`

---

## Files

| Method | Path | Query params | Description |
|--------|------|-------------|-------------|
| GET | `/api/files` | `drive=<uuid>&path=<rel>` | Directory listing |
| GET | `/api/files/download` | `drive=<uuid>&path=<rel>` | Streamed file download |

### DirListing object
```json
{
  "drive_id": "3a7f-uuid",
  "path":     "/Documents",
  "entries": [
    { "name": "report.pdf", "path": "/Documents/report.pdf",
      "is_dir": false, "size_bytes": 204800, "modified": 1718000000.0 }
  ]
}
```

---

## OTA

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/api/ota/status` | Check for updates |
| POST | `/api/ota/update` | Trigger update in background |
| GET  | `/api/ota/logs`   | Last N lines of update log (`?lines=100`) |

### OTA status object
```json
{
  "current_version":  "0.1.0",
  "current_sha":      "abc12345",
  "latest_sha":       "def67890",
  "update_available": true,
  "update_running":   false,
  "github_reachable": true,
  "changelog_url":    "https://github.com/MeridianAlgo/LiteLayer/commits/main"
}
```

---

## Settings (cross-device, encrypted at rest)

The UI keeps the live appearance values in the browser's `localStorage`; these
endpoints store one signed-in copy on the Pi so a second device pulls the same
look on login. The blob is encrypted at rest (Fernet; key in
`/etc/litelayer/settings.key`, mode 0600). One account, one synced copy.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/settings` | — | `{ "settings": { ... } }` — the synced key/value map |
| PUT | `/api/settings` | `{ "settings": { ... } }` | Replace the synced map (max 64 KB) |

Synced keys: `ll-theme`, `ll-accent`, `ll-accent-hex`, `ll-custom-colors`,
`ll-single-click`, `ll-hide-stats`, `ll-boot-drive`.

## Cloudflare Tunnel

Enable a public URL straight from the app. Safe to toggle from the UI — the tunnel
is outbound, so it can't break LAN/SSH, and it coexists with any mesh VPN.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/system/cloudflare` | — | `{ installed, active, mode, url }` (`mode`: `quick`/`token`/`null`) |
| POST | `/api/system/cloudflare` | `{ "action": "enable", "mode": "quick" }` | Install (if needed) + start a free quick tunnel |
| POST | `/api/system/cloudflare` | `{ "action": "enable", "mode": "token", "token": "…" }` | Run a named tunnel on your own domain |
| POST | `/api/system/cloudflare` | `{ "action": "disable" }` | Stop and disable the tunnel |

Enable runs in the background (apt install can take a minute); poll
`GET /api/system/cloudflare` for `url`, and `GET /api/system/vpn/status` for any
`error`.

---

## Error format

All errors return standard FastAPI JSON:
```json
{ "detail": "Human-readable error message" }
```

Common status codes:
- `401` — not authenticated or session expired
- `403` — path escape rejected
- `404` — drive or file not found
- `409` — drive not mounted / conflict
- `500` — mount/unmount OS error (check detail for message)
- `501` — write endpoint not yet implemented
