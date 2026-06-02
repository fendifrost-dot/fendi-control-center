#!/usr/bin/env bash
# Run ON YOUR MAC (not in Cursor Cloud). Starts the Remote Bridge daemon.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${REMOTE_BRIDGE_ENV_FILE:-$HOME/.fendi-remote-bridge.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  cat <<'EOF' > "$ENV_FILE"
# Fendi Remote Bridge — edit then re-run start-mac.sh
export SUPABASE_URL="https://wkzwcfmvnwolgrdpnygc.supabase.co"
export REMOTE_BRIDGE_TOKEN="PASTE_SAME_VALUE_AS_SUPABASE_SECRET"
export REMOTE_BRIDGE_WORKDIR="$HOME"
export REMOTE_BRIDGE_DEVICE_NAME="primary-mac"
export REMOTE_BRIDGE_POLL_MS="3000"
EOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE — edit REMOTE_BRIDGE_TOKEN, then run this script again."
  exit 1
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

if [[ -z "${REMOTE_BRIDGE_TOKEN:-}" || "$REMOTE_BRIDGE_TOKEN" == "PASTE_SAME_VALUE_AS_SUPABASE_SECRET" ]]; then
  echo "Set REMOTE_BRIDGE_TOKEN in $ENV_FILE (must match Supabase Edge secret)."
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Warning: this daemon is intended for macOS (open, osascript, Cursor CLI)."
fi

echo "Starting bridge → $SUPABASE_URL (device: ${REMOTE_BRIDGE_DEVICE_NAME:-primary-mac})"
echo "Workdir: ${REMOTE_BRIDGE_WORKDIR:-$HOME}"
echo "Stop with Ctrl+C. For background: tmux new -s fendi-bridge '$(realpath "$0")'"
exec node "$SCRIPT_DIR/run.mjs"
