#!/usr/bin/env bash
# wait-for.sh <url> <timeout-seconds> — waits for HTTP 200.
set -euo pipefail
url="$1"; timeout="${2:-120}"; start=$(date +%s)
until code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true); [ "$code" = "200" ]; do
  if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then echo "timeout waiting for $url (last $code)" >&2; exit 1; fi
  sleep 3
done
echo "ready: $url"
