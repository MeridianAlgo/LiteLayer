# OTA Updates

LiteLayer can update itself from GitHub via the UI or the API.

---

## How it works

1. `GET /api/ota/status` fetches `origin/main` and compares SHAs
2. If `update_available` is true the UI shows a yellow badge and banner
3. `POST /api/ota/update` runs the update in a background thread:
   - `git pull origin main`
   - Creates a local git tag `applied-YYYYMMDD-HHMMSS` for history
   - `pip install -q -r requirements.txt`
   - `systemctl restart litelayer`
4. If `is_major` is true (install.sh or requirements.txt changed), the UI
   offers **Full Reinstall** which re-runs the one-liner installer instead.

---

## API endpoints

All endpoints require authentication.

```
GET  /api/ota/status
  → { current_version, current_sha, latest_sha,
      update_available, is_major, update_running,
      github_reachable, changelog_url }

POST /api/ota/update        { }                   # standard update
POST /api/ota/update        { "reinstall": true }  # full reinstall (major)

GET  /api/ota/logs          ?lines=100            # tail of update log
```

### Check from CLI
```bash
curl -s -b "litelayer_session=<token>" http://litelayer.local/api/ota/status | python3 -m json.tool
```

### Trigger update from CLI
```bash
# Standard update
curl -s -X POST -H "Content-Type: application/json" \
     -b "litelayer_session=<token>" \
     http://litelayer.local/api/ota/update

# Force full reinstall (same as one-liner)
curl -s -X POST -H "Content-Type: application/json" \
     -d '{"reinstall":true}' \
     -b "litelayer_session=<token>" \
     http://litelayer.local/api/ota/update
```

---

## Git tags

After every successful standard update the backend creates a local tag:

```
applied-20260622-030012
```

List update history on the Pi:
```bash
git -C /opt/litelayer tag | sort
```

---

## Rollback

The update log at `/var/log/litelayer/update.log` records each run.
To roll back to the previous commit:

```bash
cd /opt/litelayer
# find the previous tag or SHA
git log --oneline | head -5
sudo git checkout <sha>
sudo systemctl restart litelayer
```

---

## Changelog in the UI

Open **Settings → Updates** to see the last 20 commits from GitHub,
with the currently-installed commit highlighted in accent color and
any newer commits marked in yellow.

---

## Update log

```bash
sudo cat /var/log/litelayer/update.log
# or via API:
curl -s -b "litelayer_session=<token>" http://litelayer.local/api/ota/logs | python3 -m json.tool
```
