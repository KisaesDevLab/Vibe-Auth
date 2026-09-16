# QUESTIONS.md

Open items are numbered; items marked **H** need a human. Items marked **A** were answered by Phase 0 and are kept for the record.

## Open (need your decision)

- **Q6 (H3)** Phase 7 hardware target and reset procedure. Phase 7 is blocked until answered.
- **Q7** **D9 premise is false.** Authentik supports subpath deployment via `AUTHENTIK_WEB__PATH` (docs, "must contain both a leading and trailing slash"). The Appliance routes every product by path prefix in LAN mode and in the default `single-host` domain sub-mode, and publishing `:8443` from an app overlay violates the Appliance's stated "only Caddy and the emergency proxy publish" rule (`console/manifest.schema.json:193`). **Built:** the broker supports `VIBE_AUTH_ROUTING=subpath|subdomain|port`; the deploy profile defaults to `subpath` (`/auth/`) and keeps `port` (`https://{ip}:8443`) available exactly as D9 specifies. Subpath was verified against Authentik 2026.8 in `test/compose.yml`. **Decide:** keep subpath as the default (recommended), or force `port` in LAN mode per the original D9?
- **Q8** `sentinel-core` already declares `ownsInfra: ["identity"]` and bundles its own Authentik (`console/manifests/sentinel-core.json:5,14`). Two IdPs in the catalog. Options: (a) Vibe Auth is the only IdP and Sentinel's `OIDC_ISSUER` points at it (Sentinel already speaks generic OIDC); (b) keep both and mark them mutually exclusive via a `sameProductAs`-like rule; (c) Sentinel Core installs *consume* Vibe Auth's Authentik. Built as (a)-compatible: the broker registers Sentinel like any other product. Which?
- **Q9** Vibe Backup restores one module at a time with no ordering (`Vibe-Backup/internal/engine/restore.go:101`). Restore order Postgres → vibe-auth → products is in the runbook only. Implement ordering in Vibe Backup (separate PR) or accept the runbook?
- **Q10** The Appliance console itself uses a single shared HTTP Basic password (`console/server.js:1042-1050`) and proxies Backup's UI. Should the console become an SSO consumer in Phase 6 (it is Express, so the client package fits), or stay on Basic auth for v1? Built: not changed; recommended: yes in a follow-up.
- **Q11** Internal-CA distribution in LAN mode is "out of v1 scope" in the Appliance (`docs/TROUBLESHOOTING.md:632-640`). With subpath routing, OIDC in LAN mode works the same way products do today (per-device browser click-through). Desktop (Tauri) logins use the system browser and inherit the same click-through. Accept for v1?
- **Q12** Entra tenant (H1): no tenant exists. `docs/entra-setup.md` is written; needs a human to execute and record tenant IDs in `test/.env.entra`.
- **Q13** MyBooks `users.user_type='client'` rows share the staff login route. Should SSO be allowed for them (they are firm-invited external users, not portal clients)? Built: **denied** — the MyBooks `UserAdapter` refuses `user_type != 'staff'` per D5. Confirm.
- **Q14** Role mapping defaults per product were chosen by me (see `docs/integration-checklist.md` table). Products with layered permissions (T&B, Investments, Calculators, MyBooks) map Vibe groups to their existing role slugs only; permission overrides are untouched. Confirm or adjust.
- **Q15** Sentinel has no generic audit-ingest endpoint (`apps/api/src/routes/ingest.ts`). The broker's Sentinel webhook posts to `POST /api/ingest/vibe-auth` with `x-sentinel-token`, which does not exist yet. Add it to Sentinel in Phase 8 step 7, or should the broker write JSON-lines only until then? Built: webhook is optional (`VIBE_AUTH_SENTINEL_URL` unset → disabled).
- **Q16** Tauri loopback helper depends on the community plugin `@fabianlars/tauri-plugin-oauth` (Rust side) to open a localhost listener. Acceptable, or should T&B/Connect implement the listener in their own Rust shells?
- **Q17** Publishing: `@kisaes/vibe-auth` to GitHub Packages requires the `kisaes` org/repo to exist; the sibling repos use `KisaesDevLab` (`ghcr.io/kisaesdevlab/*`). Which owner: `kisaes` (per plan) or `KisaesDevLab` (per every other repo)? Built with `kisaes`; CI reads `GITHUB_REPOSITORY` so it follows wherever the repo lives.

## Answered by Phase 0 (A)

- **Q1 (A)** Secret-injection mechanism → `/opt/vibe/env/<slug>.env`, `_render_app_env()` `@MARKER@` substitution, `secrets_set_kv_per_app`, `--force-recreate`. See COMPAT.md §A.
- **Q2 (A)** JWT sessions → yes in Trial Balance, MyBooks, Tax Research Chat, Sentinel. Revocation list shipped.
- **Q3 (A)** Connect key derivation → separate device passphrase; SSO safe. D17 outcome recorded.
- **Q4 (A)** LAN mode → path prefixes on `:443` with `tls internal`; internal CA is not distributed; port 8443 unused.
- **Q5 (A)** Authentik 2026.8 needs no Redis; cache service dropped.

## Closed by Q&A (from the plan)
Postgres shared (D7), amd64 (D8), IP in LAN mode (D9 — see Q7), edge gate off (D10), products stay local (D11), dedicated break-glass user (D12), wizard superuser (D13), free/no license (D14), single-firm (D18), one workspace (D19), no Entra tenant yet (D20).
