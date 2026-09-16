#!/bin/sh
# Vibe Backup post_restore hook (§2.5): runs inside the broker container with VIBE_RESTORE=1.
# Re-derives issuer/redirect URIs for the current host (rebase) and verifies every registration.
set -eu
BASE="http://127.0.0.1:${VIBE_AUTH_PORT:-8080}${VIBE_AUTH_BASE_PATH:-/vibe-auth}"
AUTH="Authorization: Bearer ${VIBE_AUTH_CONSOLE_TOKEN}"
i=0
until wget -qO- "${BASE}/health" >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 60 ] && { echo "broker not healthy after restore" >&2; exit 1; }
  sleep 5
done
wget -qO- --header="$AUTH" --header="Content-Type: application/json" --post-data='{}' "${BASE}/rebase" >/dev/null
wget -qO- --header="$AUTH" "${BASE}/registrations/verify"
echo
