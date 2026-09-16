# Vibe Auth — Build Plan (v2, Q&A-locked)

Repo: `KisaesDevLab/Vibe-Auth`
Artifacts: `@kisaesdevlab/vibe-auth` (npm, GitHub Packages) · `ghcr.io/kisaesdevlab/vibe-auth` (broker image, amd64) · `deploy/` (compose profile + blueprints + backup contract)
Runs: inside Vibe Appliance as a `provides: identity` core component, or standalone beside any single Vibe product.
Execution: autonomous Claude Code, phased. Human checkpoints are listed in §9 and nowhere else; every other step is expected to run unattended.

---

## 0. Confidence statement

The design is fixed by the Q&A in §1. Three facts still live in code and are discovered, not assumed, in Phase 0: the Appliance's secret-injection mechanism, whether any product uses stateless JWT sessions, and how Vibe Connect unlocks client-side keys. Phase 0 has hard exit gates; Phase 1+ does not start until `COMPAT.md` is committed with file/line references. Phase 7 is a compatibility matrix run on a real Appliance install with every product present, in all three deployment modes. When Phase 0 gates pass, remaining risk is ordinary implementation risk and 95% is an honest number. Pre-Phase 0: ~80%.

---

## 1. Locked decisions

| # | Decision | Source |
|---|----------|--------|
| D1 | OIDC Authorization Code + PKCE only. No SAML, no implicit. | design |
| D2 | Bundled IdP is Authentik, upstream image pinned by digest, never forked. | design |
| D3 | Broker (`vibe-auth`, Node/Express) bootstraps Authentik, exposes registration API, hosts firm admin UI, emits audit events. | design |
| D4 | Client package `@kisaesdevlab/vibe-auth`: shared Express middleware + React components. | design |
| D5 | Firm staff only. Client-portal users never use firm SSO. | design |
| D6 | Every product keeps local auth. Modes `local` (default) · `both` · `oidc_only`. | design |
| D7 | Postgres: one shared Appliance instance; Vibe Auth gets database `vibe_auth`, role `vibe_auth`. Bundled-Postgres mode exists only for standalone installs. | Q&A |
| D8 | Platform: amd64 only. | Q&A |
| D9 | **Revised 2026-09-16 (Q&A after Phase 0):** Authentik supports subpath deployment (`AUTHENTIK_WEB__PATH`), so the identity provider is served at `https://{host}/auth/` in LAN, Tailscale and single-host domain modes and at `https://auth.{host}/auth/` in subdomain-per-app mode — the same routing every product uses, no published port. The original `:8443` design remains available as `VIBE_AUTH_ROUTING=port` (`deploy/compose.yml --profile port`). An IP/host change triggers `/rebase`. | Q&A |
| D10 | Caddy edge gate (`forward_auth`) is off by default, opt-in per install. | Q&A |
| D11 | Enabling Vibe Auth changes nothing in products. Each product stays `local` until the firm flips it individually in the console (to `both`) or in the product's own settings. | Q&A |
| D12 | Break-glass: the console creates a dedicated `vibe-breakglass` local admin in every SSO-capable product via a package-provided command. Password generated once, shown once, stored in the Appliance secret store. | Q&A |
| D13 | Authentik superuser: the broker prompts on first visit via a setup wizard protected by a one-time setup token printed to the broker log and surfaced in the console. | Q&A |
| D14 | Licensing: free, no license file, not listed in licensing.kisaes.com. | Q&A |
| D15 | Secret-injection mechanism: unknown; Phase 0 discovers and locks it in §2.3. | Q&A |
| D16 | Session mechanism per product: unknown; Phase 0 discovers. Any stateless-JWT product gets a revocation-list adapter in Phase 3. | Q&A |
| D17 | Vibe Connect key model: unknown; Phase 0 discovers. If keys derive from the login password, Connect ships SSO-for-authentication with a separate local unlock passphrase, documented in Phase 8. | Q&A |
| D18 | All products are one firm per install. `TenantResolver` ships with the single-tenant default only; multi-firm is out of scope. | Q&A |
| D19 | Phase 0 runs against one workspace with every Vibe repo checked out. | Q&A |
| D20 | No Entra tenant exists. Phase 1 includes creating the Kisaes tenant and a `kisaes-test` tenant (human checkpoint H1). | Q&A |
| D21 | Phase 7 hardware target: decided at human checkpoint H3 before Phase 7 starts. | Q&A |
| D22 | Roles: `roles` claim (Entra App Roles) preferred; else groups→role map. Default Authentik groups `vibe-admin`, `vibe-partner`, `vibe-manager`, `vibe-staff`, `vibe-it`. | design |
| D23 | MFA enforced in bundled Authentik by default (TOTP/WebAuthn); can be disabled only with a logged acknowledgement. | design |
| D24 | Client secrets encrypted at rest in products using each product's existing key-wrap (adapter). | design |
| D25 | Vibe Auth is the **only** identity provider in the catalog. Sentinel consumes it (its `OIDC_ISSUER` points at Vibe Auth via the client package); Sentinel Core drops its bundled Authentik. Sentinel gains `POST /api/ingest/vibe-auth` + `SENT-V-AUTH-*` rules in Phase 8 step 7. | Q&A 2026-09-16 |
| D26 | Entra ID federation is **not part of v1**: H1 (tenants) is deferred; the Entra source wizard ships but is untested. Bundled Authentik and Google only for v1. | Q&A 2026-09-16 |
| D27 | Artifacts publish under **KisaesDevLab**: `@kisaesdevlab/vibe-auth` (GitHub Packages), `ghcr.io/kisaesdevlab/vibe-auth`, repo `KisaesDevLab/Vibe-Auth`. | Q&A 2026-09-16 |
| D28 | `oidc_only` guard is split: the console requires a stored break-glass password; the product's Settings → Authentication page additionally requires a successful Test connection within 60 minutes by the same admin. | Q&A 2026-09-16 |
| D29 | LAN-mode internal CA is not distributed in v1 (per-device click-through, as for products). MyBooks `user_type='client'` rows are denied SSO (D5). Default role maps as in `docs/integration-checklist.md`. Tauri desktop login uses `@fabianlars/tauri-plugin-oauth`. | Q&A 2026-09-16 |
| D30 | Phase 7 runs on a bare-metal box on the office LAN, executed by the human with `test/scripts/phase7.sh`; results pasted back. Follow-up scope accepted: restore ordering in Vibe Backup (separate PR). | Q&A 2026-09-16 |

---

## 2. Appliance compatibility contract

The only touch points between Vibe Auth and the Appliance. Phase 0 findings may amend this section; nothing else may.

### 2.1 Naming
| Kind | Name |
|---|---|
| Compose services | `vibe-auth`, `vibe-auth-authentik-server`, `vibe-auth-authentik-worker` — *amended (Phase 0): no `vibe-auth-cache`; authentik ≥2025 has no Redis dependency* |
| Docker network | joins the Appliance shared network (`APPLIANCE_NETWORK`, Phase 0); creates none |
| Volumes | `vibe-auth-media`, `vibe-auth-templates`, `vibe-auth-certs`, `vibe-auth-data` |
| Postgres | `vibe_auth` / `vibe_auth` on `APPLIANCE_PG_HOST` |
| Published ports | none in any mode by default — *amended (Phase 0, Q7): authentik supports subpath (`AUTHENTIK_WEB__PATH=/auth/`) and the Appliance forbids app overlays from publishing ports, so authentik is served at `{host}/auth/` (LAN, Tailscale, single-host domain) or `auth.{host}/auth/` (subdomain-per-app). The D9 `:8443` design survives as `VIBE_AUTH_ROUTING=port` + `deploy/caddy.port.Caddyfile` (`--profile port`). Emergency port 5180 (broker console only).* Authentik 9000/9443 and broker 8080 are always container-internal |
| Env prefix (broker) | `VIBE_AUTH_*` |
| Env prefix (products) | `VIBE_OIDC_*`, `VIBE_AUTH_MODE`, `VIBE_BREAKGLASS_*` |
| Manifest slug | `vibe-auth` |

### 2.2 Manifest schema additions (Appliance repo)
*Amended (Phase 0): the schema had no `provides`/`requires`; both were added (enum `identity`), plus `sso` and `routing.mounts`. There is no `core` field; `ownsInfra` is foreign-runtime-only, so vibe-auth uses `provides` instead. The broker is a normal path-mounted app; authentik is a mount.*
```json
{ "slug": "vibe-auth", "provides": ["identity"], "subdomain": "auth", "pathPrefix": "vibe-auth",
  "routing": { "default_upstream": "vibe-auth:8080",
               "mounts": [{ "path": "/auth", "upstream": "vibe-auth-authentik-server:9000" }] },
  "health": "/vibe-auth/health", "emergencyPort": 5180, "resources": { "cores": 1, "ramMb": 2048 } }
```
Per SSO-capable product:
```json
{ "requires": ["identity"],
  "sso": { "capable": true,
           "redirectPaths": ["/auth/oidc/callback"],
           "logoutPaths": ["/auth/oidc/backchannel"],
           "publicPaths": ["/webhooks/*", "/api/health"],
           "edgeGate": false,
           "breakglassService": "vibe-tb-server",
           "breakglassCommand": ["node", "node_modules/@kisaesdevlab/vibe-auth/dist/cli.js", "breakglass", "ensure", "--json"] } }
```
`requires` affects boot order only (bootstrap.sh's topological sort); a product installs fine without Vibe Auth present.

### 2.3 Console behaviour (Appliance repo)
*Locked by Phase 0 (D15): secrets are per-product env files (`/opt/vibe/env/<slug>.env`, mode 600, compose `env_file`), written with `secrets_set_kv_per_app`, and a product picks them up only on `docker compose up -d --force-recreate --no-deps`. All of the below is implemented by `lib/identity.sh` (spawned by `console/identity.js` and by the enable/disable hooks; also `sudo vibe identity …`).*
1. Topological install order on `requires`/`provides`. `vibe-auth` is installed only when the firm selects it (console toggle or `vibe enable vibe-auth`), never implicitly.
2. On `vibe-auth` healthy: for each `sso.capable` product, `POST http://vibe-auth:8080/vibe-auth/registrations` (console token, JSON over stdin via `docker exec vibe-console curl`) → receive `VIBE_OIDC_*` block → write to `<slug>.env` → force-recreate the product → **do not change `VIBE_AUTH_MODE`** (D11).
3. Console "Identity" tab per product: registration status · mode toggle (`local` → `both` → `oidc_only`, with guards) · Fix · Rotate · Disable.
4. Break-glass provisioning (D12): on first registration of a product, run `docker exec {sso.breakglassService} {sso.breakglassCommand}` (default `npx vibe-auth breakglass ensure --json`; uses the product's `UserAdapter`), capture the generated password, store it in `vibe-auth.env` under `VIBE_BREAKGLASS_PASSWORD_{SLUG}`, display once (console output + CREDENTIALS.txt).
5. `oidc_only` toggle is refused unless the break-glass password is stored (console) — *amended: the "test login succeeded in this session" guard lives in the product's own Settings → Authentication page (the package's settings API), which is where a test login can actually be observed; the console cannot see product sessions.*
6. Uninstall product → `DELETE /registrations/{slug}`. Uninstall Vibe Auth → all products forced back to `local`, registrations dropped.
7. Mode change or LAN IP change → `POST /rebase`.

### 2.4 Caddy
*Amended (Phase 0): the Appliance has no snippet-import convention; every route is generated from manifests by `lib/render-caddyfile.sh`. Implemented there:*
- All path-mounted modes (LAN, Tailscale, single-host domain): `handle /vibe-auth/*` → broker (normal app prefix handler); `handle /auth/*` → `vibe-auth-authentik-server:9000` **without** prefix strip (`routing.mounts`), plus `redir /auth /auth/`.
- Subdomain-per-app domain mode: vhost `auth.{domain}` with the same `/auth/*` mount inside it and the broker at root.
- `port` fallback (original D9): `deploy/caddy.port.Caddyfile` on `:8443`, `tls internal` with the IP as SAN. Phase 0 confirmed the internal CA is **not** distributed to firm browsers ("out of v1 scope"); firms click through once per device, the same as for products today (Q11).
- Edge gate (D10): when `sso.edgeGate=true` **and** an identity provider is enabled, the product's handler gets `forward_auth vibe-auth-authentik-server:9000 { uri /auth/outpost.goauthentik.io/auth/caddy }` with an `@…_public path {publicPaths}` bypass; the broker creates the matching `forward_single` proxy provider + `<slug>-edge` application on the embedded outpost.

### 2.5 Backup
Vibe Backup default set includes `vibe_auth` database and `vibe-auth-media` + `vibe-auth-data` — declared in `deploy/backup.contract.yaml` (discovered via the `vibe.backup.contract` container label). Restore order: Postgres → `vibe-auth` → products — *amended (Phase 0): Vibe Backup restores one module at a time and has no ordering; the order is a runbook step (docs/firm/runbooks.md R8, QUESTIONS Q9).* Post-restore hook (`hooks/post-restore.sh`, run in-container with `VIBE_RESTORE=1`) calls `/rebase` then `GET /registrations/verify`.

### 2.6 Issuer split
Browser: `https://auth.{host}` or `https://{ip}:8443`. Products: `http://vibe-auth-authentik-server:9000`. Broker returns:
```
VIBE_OIDC_ISSUER=https://auth.{host}/application/o/{slug}/     (or https://{ip}:8443/application/o/{slug}/)
VIBE_OIDC_INTERNAL_BASE=http://vibe-auth-authentik-server:9000
```
Client package discovers against `VIBE_OIDC_ISSUER` (validates `iss`), then rewrites `token_endpoint`, `jwks_uri`, `userinfo_endpoint`, `revocation_endpoint`, `introspection_endpoint` hosts to `VIBE_OIDC_INTERNAL_BASE` (an **origin**, no path — the issuer path already carries `/auth/…`). `authorization_endpoint` **and `end_session_endpoint`** are never rewritten — *amended: RP-initiated logout is a browser redirect.* *Amended: authentik derives the per-provider issuer from the request host, so the client sends `X-Forwarded-Host`/`X-Forwarded-Proto` (the public values) on every internal call; authentik honours them from trusted-proxy CIDRs (docker networks). There is no server-side `AUTHENTIK_HOST` setting.* This removes internal-CA trust from all server-to-server calls.

### 2.7 Resources
Limits: server 1 GB, worker 768 MB, broker 256 MB (no cache); reservations half. Manifest `resources: { cores: 1, ramMb: 2048 }` feeds the console's free-capacity pre-flight.

### 2.8 Boot tolerance
`both` mode: product starts and serves local login if discovery fails; retries with backoff; logs `vibe.auth.idp.unreachable`. `oidc_only`: serves `/login/local` (break-glass) and an "identity provider unavailable" page.

---

## 3. Phases

### Phase 0 — Discovery and contract lock
Read-only against the shared workspace (D19). Output `COMPAT.md` with file/line references. **Gate: every box checked; any contradiction with §2 amended into §2 with a QUESTIONS.md entry before Phase 1.**

Appliance
- [ ] Shared Docker network name; how products join
- [ ] Postgres service name, host/port env names, per-product DB/role creation, superuser credential location
- [ ] **Secret injection mechanism** and the console function that performs it; whether it can restart one product (locks D15 → §2.3)
- [ ] Manifest schema file; current install-ordering logic
- [ ] Caddyfile assembly; snippet import convention; `{host}` templating per mode; how LAN mode routes products today (path? port?) and how the internal CA is distributed to firm browsers
- [ ] Tailscale hostname/cert source
- [ ] Health-check convention
- [ ] Vibe Backup default-set declaration; restore hook mechanism; ordering support
- [ ] Preflight capacity check location
- [ ] Any existing use of names in §2.1 (expect none)
- [ ] Any product publishing host port 8443 (would collide with D9)

Each product (TB, T&B, MyBooks, AI Router, Recap, 1040, 1099, Entity, Investments, Calculators, Tax Research Chat, Sentinel, Connect, Backup)
- [ ] Session mechanism (server-side store vs stateless JWT) → D16
- [ ] Auth middleware entry point; login route
- [ ] User table: id, email, `email_verified`?, role field(s); how a user is created programmatically (for `breakglass ensure`)
- [ ] Role model: flat enum or layered
- [ ] ORM + migration tool + version; Node version
- [ ] Machine endpoints for `public_paths`
- [ ] Tauri shell? platforms?
- [ ] Audit table and event shape
- [ ] Key-wrap mechanism for secrets at rest
- [ ] Connect only: client key derivation → D17

Writes: `COMPAT.md`, filled §6 matrix, amended §2, QUESTIONS.md entries.

### Phase 1 — Repo, CI, Entra tenants
- Monorepo (pnpm): `packages/client`, `packages/broker`, `deploy/`, `test/`, `docs/`.
- CI: typecheck, unit, publish npm on tag, build/push amd64 image on tag.
- `test/compose.yml`: Postgres, Authentik (pinned), broker, reference product `test/ref-app` (minimal Express app using the client package).
- `docs/entra-setup.md`: exact steps to create the Kisaes tenant (Workforce, verify `kisaes.com`, create `kurt@kisaes.com` GA, MFA), the `kisaes-test` tenant with three users and an App Roles assignment, and Partner Center enrolment + publisher verification. → **H1**
- Exit: green CI; `docker compose up` in `test/` yields Authentik login; H1 complete with tenant IDs recorded in `test/.env.entra`.

### Phase 2 — Client package core
- zod config for §2.6 + `VIBE_AUTH_MODE`.
- Discovery with issuer validation and internal-base rewrite; JWKS cache.
- `/auth/oidc/start`, `/auth/oidc/callback` (state/nonce/PKCE server-side, 5-min TTL; ID token validation iss/aud/exp/nonce/at_hash; userinfo fallback).
- Adapters: `SessionAdapter`, `UserAdapter`, `AuditSink`, `SecretWrap`, `TenantResolver` (single-tenant default only, D18).
- Boot tolerance (§2.8).
- Exit: ref-app logs in via Authentik and via `kisaes-test` Entra; discovery failure at boot leaves local login working.

### Phase 3 — Identity, roles, modes, logout, break-glass
- `auth_identities` fragment as Drizzle SQL and raw SQL.
- Linking: `(issuer, sub)` primary; verified-email link; JIT; unverified denied.
- Role resolution per D22; `VIBE_OIDC_REQUIRE_MFA_AMR`.
- Modes + guards; startup refusal if `oidc_only` and no break-glass user.
- CLI `vibe-auth breakglass ensure|rotate|status` (D12) via `UserAdapter`.
- RP-initiated + back-channel logout; revocation-list adapter if Phase 0 found JWT sessions (D16).
- Audit events (§5).
- Exit: `packages/client/test/matrix.md` green.

### Phase 4 — Client package UI + Tauri helper
- Settings → Authentication page; role-map editor seeded with defaults; mode selector with guards; "Test connection" popup.
- Login component (local + IdP button + hidden break-glass route).
- Tauri loopback helper (`127.0.0.1:{port}/callback`, system browser).
- Exit: ref-app configures Entra without docs; Tauri sample logs in on Windows/macOS/Linux.

### Phase 5 — Broker + deploy profile
- `deploy/compose.yml` per §2.1/§2.7; `VIBE_AUTH_PG_MODE=shared|bundled` (D7); cache service per pinned Authentik release.
- First boot: create DB/role if absent; apply blueprints (brand, groups, MFA-required flow, recovery flow); **no superuser created** — setup wizard at `/vibe-auth/setup` gated by one-time token (D13).
- Registration API: `POST/GET/DELETE /registrations/{slug}`, `POST .../rotate`, `POST /rebase`, `GET /registrations/verify`, `GET /health`, `GET /version`. Auth: `VIBE_AUTH_CONSOLE_TOKEN`.
- Federated sources wizard (Entra ID, Google) with group sync.
- Admin UI: users, MFA reset, registered products, sources, audit view, health.
- Audit export: JSON-lines + webhook (Sentinel).
- LAN-mode routing (D9): broker computes issuer as `https://{ip}:8443/...` when `VIBE_AUTH_ROUTING=lan`.
- Exit: `docker compose up` from `deploy/` on clean host → wizard → branded Authentik with MFA; registration round-trips with ref-app in both routing styles.

### Phase 6 — Appliance integration (lands in `vibe-appliance`)
- §2.2 manifest fields; topological install order.
- §2.3 console flow using the Phase 0 secret mechanism; Identity tab; break-glass provisioning; `oidc_only` guard; uninstall behaviour.
- §2.4 Caddy import; LAN `:8443`; edge-gate opt-in.
- §2.5 Backup set + ordering + post-restore hook.
- §2.7 preflight.
- Exit: `vibe-appliance install --with vibe-auth` on a clean host in each mode → SSO login into ref-app and Trial Balance with no manual steps beyond the setup wizard.

### Phase 7 — Compatibility matrix (**H3 first**: choose hardware)
Real Appliance install, every product installed, each mode.

| Check | Domain | LAN (IP) | Tailscale |
|---|---|---|---|
| All products start and serve local login with Vibe Auth installed | | | |
| No name/volume/network/db collisions | | | |
| Generated Caddyfile for existing products byte-identical to pre-install (diff) | | | |
| Auth endpoint reachable with valid/trusted cert (`auth.{host}` or `{ip}:8443`) | | | |
| Registrations created for every `sso.capable` product; **modes unchanged** (D11) | | | |
| Flip TB to `both` → SSO login → role resolved | | | |
| Flip TB to `oidc_only` without break-glass → refused; with → allowed; break-glass login works | | | |
| Logout at Authentik terminates product sessions | | | |
| Stop Vibe Auth → products boot, local login works → start → recovers | | | |
| Edge gate on → `public_paths` webhooks reach handlers | | | |
| Backup → wipe → restore → SSO login without reconfiguration | | | |
| Change LAN IP / switch mode → `/rebase` → SSO login works | | | |
| Authentik upgrade to next pinned digest → blueprints re-apply | | | |
| Memory within limits under 10-user login burst | | | |

### Phase 8 — Product roll-out (one PR each, `docs/integration-checklist.md`)
1. Trial Balance 2. Time & Billing 3. MyBooks (staff only) 4. AI Router, Tax Research Chat 5. 1099, Entity, Investments, Calculators, 1040 6. Recap (standalone, bundled-Postgres) 7. Sentinel (third identity source + audit ingest) 8. Connect per D17 outcome 9. Backup (admin UI)

### Phase 9 — Docs and release
Firm docs (Entra, Google, bundled Authentik, runbooks); developer docs; tag `v1.0.0` across package, image, deploy profile.

---

## 4. Definition of done
- `COMPAT.md` committed with references; §2 amended as needed.
- Phase 7 matrix green in all three modes with every product installed.
- Trial Balance, T&B, MyBooks shipped with SSO.
- Runbooks executed by someone other than the author (**H4**).

---

## 5. Audit event schema
```
vibe.auth.login.success      {user_id, method, issuer, sub, amr[], ip, ua}
vibe.auth.login.failure      {method, reason, email?, issuer?, ip}
vibe.auth.user.provisioned   {user_id, issuer, sub, email, role}
vibe.auth.user.linked        {user_id, issuer, sub}
vibe.auth.role.changed       {user_id, from, to, source}
vibe.auth.logout             {user_id, method, initiated_by}
vibe.auth.mode.changed       {from, to, actor}
vibe.auth.breakglass.used    {user_id, ip}
vibe.auth.breakglass.rotated {actor}
vibe.auth.idp.unreachable    {issuer, error}
vibe.auth.registration.*     {slug, action, actor}          (broker)
vibe.auth.setup.completed    {admin_email}                   (broker)
```

---

## 6. Integration matrix (filled in Phase 0)
| Product | Session | User create fn | Role model | ORM/Node | Tauri | public_paths | Key-wrap | Notes |
|---|---|---|---|---|---|---|---|---|
| Trial Balance | | | | Knex→Drizzle | | | | reference |
| Time & Billing | | | | | yes | | | |
| MyBooks | | | | | | Plaid, Stripe | | client portal excluded |
| AI Router | | | | | | | | |
| Recap | | | | /24 | | | | standalone |
| 1040 | | | | | | | | standalone |
| 1099 | | | | | | IRIS | | |
| Entity | | | | | | | | |
| Investments | | | | | | | | |
| Calculators | | | | | | | | |
| Tax Research Chat | | | | | | | | |
| Sentinel | | | | | yes (Lite) | CF Access, Tailscale | | |
| Connect | | | | | yes | | | D17 |
| Backup | | | | | | | | admin UI only |

---

## 7. QUESTIONS.md
Open (resolved by Phase 0 unless marked H):
- Q1 Secret-injection mechanism (D15).
- Q2 JWT sessions in any product (D16).
- Q3 Connect key derivation (D17).
- Q4 LAN mode: how products are routed today and how the internal CA reaches firm browsers; confirm no host port 8443 in use.
- Q5 Authentik pinned release: external cache still required?
- Q6 **H3** Phase 7 hardware target.
Closed by Q&A: Postgres shared (D7), amd64 (D8), IP in LAN mode (D9), edge gate off (D10), products stay local (D11), dedicated break-glass user (D12), wizard superuser (D13), free/no license (D14), single-firm (D18), one workspace (D19), no Entra tenant yet (D20).

---

## 8. STATE.md (initial)
```
Phase 0: not started — blocks everything
Phase 1: not started (H1 required before Phase 2 Entra test)
Phase 2–6: not started
Phase 7: blocked on H3
Confidence: ~80% pre-Phase-0; target ≥95% at Phase 0 gate
Next: Phase 0, Appliance repo first, then products in §6 order
```

---

## 9. Human checkpoints (the only places the build stops)
- **H1** (during Phase 1): create Kisaes Entra tenant, verify `kisaes.com`, create GA user with MFA, create `kisaes-test` tenant, enrol Partner Center, complete publisher verification. Follow `docs/entra-setup.md`; record tenant IDs in `test/.env.entra`.
- **H2** (end of Phase 0): review `COMPAT.md` and any §2 amendments; approve or answer new QUESTIONS.md items.
- **H3** (before Phase 7): choose the hardware target and provide a reset procedure (snapshot/reimage).
- **H4** (Phase 9): a non-author executes the firm runbooks.
