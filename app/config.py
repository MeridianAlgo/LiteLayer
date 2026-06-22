import os
from pathlib import Path

MOUNT_ROOT = Path(os.environ.get("LITELAYER_MOUNT_ROOT", "/srv/litelayer/mounts"))
CREDENTIALS_FILE = Path(os.environ.get("LITELAYER_CREDENTIALS", "/etc/litelayer/credentials.json"))
SESSION_TTL_HOURS = int(os.environ.get("LITELAYER_SESSION_TTL", "24"))
DEV_UI_PATH = Path(__file__).parent.parent / "dev-ui"

# Comma-separated allowed origins for the separate UI repo's dev server
_raw_origins = os.environ.get(
    "LITELAYER_CORS_ORIGINS",
    "http://localhost:3000,http://localhost:5173,http://localhost:8080,http://127.0.0.1:3000"
)
CORS_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]
