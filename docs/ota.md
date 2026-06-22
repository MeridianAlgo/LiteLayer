# OTA Updates

LiteLayer checks GitHub for updates automatically (daily at 03:00) and lets you
apply them with a single API call or CLI command.

---

## How it works

1. `litelayer-update.timer` fires daily and runs `update.sh --auto`
2. The script fetches `origin/main`, compares SHAs, and applies if different
3. Steps: `git pull` → `pip install -r requirements.txt` → `systemctl restart litelayer`
4. A rollback SHA is logged so you can revert if needed

The UI in the separate `litelayer-ui` repo has its own independent OTA path
(same mechanism, different repo).

---

## API endpoints

All require authentication.

```
GET  /api/ota/status   → { current_version, current_sha, latest_sha,
                            update_available, update_running, changelog_url }
POST /api/ota/update   → triggers update in background
GET  /api/ota/logs     → last N lines of update log (?lines=100)
```

### Check from CLI
```bash
curl -s -b "litelayer_session=<token>" https://<pi-ip>/api/ota/status | python3 -m json.tool
```

### Trigger update from CLI
```bash
curl -s -X POST -b "litelayer_session=<token>" https://<pi-ip>/api/ota/update
```

---

## Manual update

```bash
sudo /opt/litelayer/installer/update.sh          # interactive, asks before applying
sudo /opt/litelayer/installer/update.sh --auto   # non-interactive
sudo /opt/litelayer/installer/update.sh --check  # print status only
```

---

## Rollback

The update log at `/var/log/litelayer/update.log` records the pre-update SHA:

```
--- 2026-06-22T03:00:01 update.sh --auto ---
Update available: 0.1.0 (abc12345) → 0.2.0 (def67890)
Snapshot: abc12345
...
Rollback if needed:  cd /opt/litelayer && git checkout abc12345 && systemctl restart litelayer
```

To roll back:
```bash
cd /opt/litelayer
sudo git checkout <snapshot-sha>
sudo systemctl restart litelayer
```

---

## Disabling automatic updates

```bash
sudo systemctl disable --now litelayer-update.timer
```

Re-enable:
```bash
sudo systemctl enable --now litelayer-update.timer
```

---

## Update schedule

Default: daily at 03:00 with a random delay of up to 30 minutes (avoids
all devices hitting GitHub simultaneously). Edit
`/etc/systemd/system/litelayer-update.timer` to change.
