#!/usr/bin/env bash
# Phase 7 compatibility matrix runner — run ON the Appliance host (Ubuntu 24.04) as root,
# after `bootstrap.sh` completed in the routing mode under test. Re-run once per mode
# (lan, domain, tailscale) and paste each result table into STATE.md.
#
#   sudo bash test/scripts/phase7.sh [--products "vibe-tb vibe-time-billing vibe-mybooks"] [--skip-restore]
#
# Every check is idempotent; nothing here deletes data except the optional restore drill,
# which asks for confirmation. Output: a markdown table on stdout + /opt/vibe/logs/phase7.log.
set -uo pipefail
APPLIANCE_DIR="${APPLIANCE_DIR:-/opt/vibe/appliance}"
VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
PRODUCTS="vibe-tb"
SKIP_RESTORE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --products) PRODUCTS="$2"; shift 2 ;;
    --skip-restore) SKIP_RESTORE=1; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
LOG="${VIBE_DIR}/logs/phase7.log"; mkdir -p "$(dirname "$LOG")"
ROWS=()
row() { local name="$1" ok="$2" note="${3:-}"; ROWS+=("| ${name} | $([[ "$ok" == 0 ]] && echo '✅' || echo '❌') | ${note//|/\\|} |"); echo "[$([[ "$ok" == 0 ]] && echo PASS || echo FAIL)] ${name} ${note}" | tee -a "$LOG"; }
vibe() { bash "${APPLIANCE_DIR}/bin/vibe" "$@"; }
mode="$(python3 -c "import json;print(json.load(open('${VIBE_DIR}/state.json')).get('config',{}).get('mode','?'))")"
echo "== Phase 7 · mode=${mode} · products=${PRODUCTS} · $(date -Is)" | tee -a "$LOG"

# 1. Install with vibe-auth
vibe enable vibe-auth >>"$LOG" 2>&1; row "Install with vibe-auth: vibe-auth enabled" $?
probe() { docker exec vibe-console curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1"; }
[[ "$(probe http://vibe-auth:8080/vibe-auth/health)" == 200 ]]; row "vibe-auth /health 200" $?
[[ "$(probe http://vibe-auth-authentik-server:9000/auth/-/health/ready/)" == 200 ]]; row "authentik ready under /auth/" $?
st="$(vibe identity setup-token 2>/dev/null)"; echo "$st" | grep -q '"done": *true' ; row "Setup wizard completed (run it first if ❌; URL: $(echo "$st" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("url"))' 2>/dev/null))" $?

for p in $PRODUCTS; do
  vibe enable "$p" >>"$LOG" 2>&1; row "$p enabled" $?
  s="$(vibe identity status "$p" 2>/dev/null)"
  echo "$s" | grep -q '"registered": *true'; row "$p registered with vibe-auth (env block written)" $? "$s"
  echo "$s" | grep -q '"mode": *"local"'; row "$p mode unchanged = local (D11)" $?
  echo "$s" | grep -q '"breakglass": *true'; row "$p break-glass password stored (D12)" $?
  # mode flips with guards
  vibe identity mode "$p" both >>"$LOG" 2>&1; row "$p → both" $?
  # oidc_only refused without break-glass is covered by identity.sh; with it:
  vibe identity mode "$p" oidc_only >>"$LOG" 2>&1; row "$p → oidc_only (allowed with break-glass)" $?
  vibe identity mode "$p" both >>"$LOG" 2>&1
  vibe identity rotate "$p" >>"$LOG" 2>&1; row "$p rotate secret" $?
done

# Stop vibe-auth → products boot / local login works → start → recovers
docker stop vibe-auth vibe-auth-authentik-server >>"$LOG" 2>&1
for p in $PRODUCTS; do
  m="${APPLIANCE_DIR}/console/manifests/${p}.json"
  up="$(python3 -c "import json;m=json.load(open('$m'));r=m['routing'];print(next((x['upstream'] for x in r.get('matchers',[]) if x.get('name')=='api'), r['default_upstream']))")"
  h="$(python3 -c "import json;print(json.load(open('$m'))['health'])")"
  docker restart "${p}-server" >>"$LOG" 2>&1 || true; sleep 15
  [[ "$(probe "http://${up}${h}")" == 200 ]]; row "$p healthy while vibe-auth is down (boot tolerance)" $?
done
docker start vibe-auth-authentik-server vibe-auth >>"$LOG" 2>&1; sleep 60
[[ "$(probe http://vibe-auth:8080/vibe-auth/health)" == 200 ]]; row "vibe-auth recovers after start" $?

# Verify + rebase
tok="$(grep '^VIBE_AUTH_CONSOLE_TOKEN=' "${VIBE_DIR}/env/vibe-auth.env" | cut -d= -f2-)"
ver="$(docker exec vibe-console curl -s -H "Authorization: Bearer $tok" http://vibe-auth:8080/vibe-auth/registrations/verify)"
echo "$ver" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if all(r["ok"] for r in d) else 1)'; row "registrations/verify all ok" $? "$ver"
vibe identity rebase >>"$LOG" 2>&1; row "rebase (host/IP change path)" $?

# Backup → wipe → restore (optional, destructive)
if [[ "$SKIP_RESTORE" == 0 ]]; then
  read -r -p "Run the backup/restore drill for vibe-auth? Type RESTORE to proceed: " ans
  if [[ "$ans" == "RESTORE" ]]; then
    docker exec vibe-backup /vibe-backup backup >>"$LOG" 2>&1; row "Vibe Backup run" $?
    docker exec vibe-backup /vibe-backup restore --module vibe-auth --confirm vibe-auth >>"$LOG" 2>&1; row "restore vibe-auth (post_restore hook: rebase + verify)" $?
  else
    row "backup/restore drill" 1 "skipped by operator"
  fi
fi

# Memory under a 10-user login burst is measured manually: docker stats vibe-auth-authentik-server vibe-auth-authentik-worker vibe-auth
echo; echo "| Check (${mode}) | Result | Note |"; echo "|---|---|---|"; printf '%s\n' "${ROWS[@]}"
echo; echo "Manual: 10 users sign in within a minute; record 'docker stats' peak (limits: server 1g, worker 768m, broker 256m)."
echo "Manual: authentik upgrade to next pinned digest → blueprints re-apply (docker logs vibe-auth-authentik-worker | grep -i blueprint)."
