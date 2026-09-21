# Vibe Auth — runbooks

Each runbook is meant to be executed by someone who did not build the system (checkpoint H4). Commands run on the Appliance host as root unless stated.

## R1. A user lost their phone / MFA device
1. Vibe Auth admin → Users → the user → **Reset MFA**. Their sessions end.
2. They sign in with their password and are asked to enrol a new device.
Audit: `vibe.auth.settings.changed { what: "mfa_reset" }`.

## R2. Single sign-on is down; staff must work
Products in `both` mode keep working with passwords; nothing to do.
Products in `oidc_only` mode: open the product's `/login/local` page and sign in as `vibe-breakglass` with the password from `sudo vibe credentials` (section "Vibe Auth break-glass local admins"). Every use is logged (`vibe.auth.breakglass.used`) and Sentinel raises `SENT-V-AUTH-001`.
Two products differ. **Vibe 1099** signs people in by email and rejects the bare username: sign in as `vibe-breakglass@vibe-1099.local`. **Vibe 1040** requires a second factor even for this account: it must be signed in once and its authenticator app enrolled **when the account is provisioned**, not during the outage; keep that authenticator with the password.
**Check break-glass before you need it:** `sudo vibe identity breakglass-status <slug>` (or the console's Single sign-on panel, which shows "break-glass verified" or "NOT ready" with the reason). It asks the product whether the account exists, is an active administrator, has any required second factor enrolled, and whether the stored password still signs in. The appliance refuses to switch a product to `oidc_only` unless that check passes.
**Test the break-glass sign-in after provisioning and after any product database restore or rollback.** The console's "break-glass ready" pill only means a password is stored; it does not mean the account exists or that the password still matches. If the password is refused: `sudo vibe identity rotate-breakglass <slug>`. If the account is gone: `sudo vibe identity register <slug>`.
When the outage is over, rotate the break-glass password: `sudo vibe identity rotate-breakglass <slug>`.

## R3. Diagnose "Identity provider unavailable"
```
sudo vibe identity status vibe-tb          # registered? mode? provider healthy?
docker logs vibe-auth --tail 100           # broker
docker logs vibe-auth-authentik-server --tail 100
curl -s http://vibe-auth:8080/vibe-auth/health   # from inside vibe_net (docker exec vibe-console curl ...)
```
Common causes: Postgres down (health shows `db:false`), authentik still migrating after an upgrade (wait), a host/IP change without a rebase (R5).

## R4. The firm's IP address or domain changed, or the routing mode was switched
```
sudo vibe identity rebase
```
Re-derives every product's issuer and redirect URIs and recreates the products. The console runs this automatically after a Network settings save; run it by hand after a manual change to `/opt/vibe/state.json`.

## R5. A product cannot sign in after an update ("Fix")
Console → Identity → the product → **Register / Fix**, or `sudo vibe identity register <slug>`. Idempotent: keeps the client id, rewrites the env block, recreates the product, ensures the break-glass account.

## R6. Rotate a product's client secret
`sudo vibe identity rotate <slug>` (or the console button). No user impact; the product restarts once.

## R7. Turn single sign-on off for one product / for everything
- One product: Console → Identity → **Disable SSO** (`sudo vibe identity disable <slug>`): registration dropped, mode back to `local`, product restarted.
- Everything: disabling the Vibe Auth app does this for every product first, then stops Vibe Auth.

## R8. Backup and restore
Vibe Backup captures database `vibe_auth` and the `vibe-auth-media` / `vibe-auth-data` volumes through `deploy/backup.contract.yaml`. **Restore order matters** (QUESTIONS Q9): Postgres globals → `vibe-auth` module → products. After the Vibe Auth restore its `post_restore` hook runs a rebase + verify; then re-run `sudo vibe identity register-all` if any product reports "provider missing".
Secrets that must survive with the backup: `VIBE_AUTH_AUTHENTIK_SECRET_KEY`, `VIBE_AUTH_SECRET_KEY` (both in `/opt/vibe/env/vibe-auth.env`, root-600 — include `/opt/vibe/env` in your off-box copy of CREDENTIALS).

## R9. Upgrade authentik
The image is pinned by digest in `apps/vibe-auth.yml`. `sudo vibe update vibe-auth` pulls the new broker + authentik pair; blueprints re-apply automatically on start (atomic per file). If the sign-in flow disappears after an upgrade: `docker logs vibe-auth-authentik-worker | grep -i blueprint`.

## R10. Disable MFA enforcement (not recommended)
Vibe Auth admin → Overview → "Disable enforcement (logged)". Recorded as `vibe.auth.mfa.enforcement.disabled` with the administrator's identity (D23). Re-enable from the same place.

## R11. Emergency access to the Vibe Auth console itself
`http://<host-ip>:5180/vibe-auth/admin` (emergency proxy; LAN/Tailscale only). Signing in still needs the `/auth/` route; if authentik is down, use the products' break-glass accounts (R2) — the console has no local password by design.
