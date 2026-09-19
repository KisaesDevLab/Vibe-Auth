# Vibe Auth — Product Integration Plan (Phase 8, v1)

Scope: wire `@kisaesdevlab/vibe-auth` into the twelve remaining Vibe products. One branch and one PR per product, built autonomously by Claude Code, in the order of §4. Trial Balance (`trial-balance-app@vibe-auth-integration`) and Sentinel (`Vibe-Sentinel@vibe-auth-integration`) are the two reference implementations; every step below points at them.

Reads first: `VIBE-AUTH-BUILD-PLAN.md` §1 (D1–D30), `COMPAT.md` §B (the per-product facts with file:line anchors), `docs/integration-checklist.md`, `packages/client/README.md`, `packages/client/test/harness.ts`.

---

## 0. Confidence and prerequisites

- **P1 — the package must be consumable from a Docker build.** Today every integration uses `file:../../Vibe-Auth/packages/client`, which works for local builds and tests but not inside `Dockerfile` builds (the path is outside the context). Before the first PR merges: push `Vibe-Auth` and the `v1.0.0` tag so CI publishes `@kisaesdevlab/vibe-auth` to GitHub Packages, then switch each product's dependency to `"@kisaesdevlab/vibe-auth": "^1.0.0"` with an `.npmrc` line `@kisaesdevlab:registry=https://npm.pkg.github.com` and a `NODE_AUTH_TOKEN` build secret. Until P1 is done, PRs are reviewable but their images will not build.
- **P2 — Phase 7 has not run.** Products can be integrated and tested against `test/compose.yml` (real authentik) and the fake IdP without an appliance host; the appliance-level checks (registration through `lib/identity.sh`, break-glass provisioning through `docker exec`) are only provable on the LAN box.
- Confidence per product is stated in §4. Products with server-side sessions and Express are routine (≥95%). Fastify products, layered-permission products and Connect carry the design risk.

---

## 1. Locked rules for every integration (I1–I14)

| # | Rule | Why / source |
|---|---|---|
| I1 | The product's local login stays intact; SSO is additive. Default mode `local`; the console or the product settings page flips it. | D6, D11 |
| I2 | Server engine is created with **`basePath: ""`**; React components get **`basePath: import.meta.env.BASE_URL.replace(/\/$/, "")`**. Never derive the redirect URI from `basePath`; it comes from `VIBE_OIDC_PUBLIC_URL`. | Appliance Caddy strips `/<prefix>` before the API; the SPA lives under it. TB deviation #2 (`trial-balance-app/docs/sso.md` §Deviations) |
| I3 | Mount `vibeAuthExpress(auth)` (or the Fastify plugin) **after** body parsers and every raw-body / webhook / health / API-key route, **before** the product's authenticated routers. Never move a webhook mounted before `express.json()`. | COMPAT §B public_paths; MyBooks/T&B/TRC raw-body webhooks |
| I4 | `await auth.start()` at boot; let its only throw (oidc_only without break-glass) abort startup with its message. | §2.8, Phase 3 |
| I5 | Local login route gets `guardLocalLogin` (or an equivalent that keeps the product's error envelope) **and** calls `auth.afterLocalLogin` on success. | D12 audit |
| I6 | Server-side-session products implement `destroyByIdentity`; stateless-JWT products add the `sid` claim, store `(sid → user)` and call `auth.isRevoked({ userId }, iat*1000)` **on every request** inside their verify middleware (D16). Revocation is by revocation moment; a later login stays valid. | D16; package fix 2026-09-16 |
| I7 | `UserAdapter.create` (JIT) writes an unusable random password hash, marks the email verified where the schema has such a column, and never sets `must_change_password`. `createLocalUser` uses the product's own hash algorithm and cost, **and must produce a row that can sign in during an outage**: active, not locked, every forced-change flag cleared (`must_change_password`, Entity's `passwordResetRequired`), not subject to a permanent lockout (MyBooks: `is_super_admin`), and with the product's second-factor policy for it decided and documented. **A JIT account must not be able to bootstrap local credentials without an admin**: refuse self-service reset and magic links for an account that has an `auth_identities` row and no local factor (1040's `isSsoOnlyAccount`); see `vibe-1040-findings.md` item 6. | Phase 3; review 2026-09-19 |
| I8 | Roles: map Vibe groups to the product's **role slugs only** (D22, D29 defaults); never touch per-user permission overrides (T&B, Investments, Calculators, MyBooks). `syncRoles: true`. **Pass an explicit `defaultRoleMap`**: `defaultRoleMapFor` matches case-sensitively and falls back to the *least* privileged role, which mis-maps Investments, MyBooks and Entity and promotes every `vibe-partner` to `super_admin` in Payroll & Time. **Role sync must not demote the last active admin** (it runs on the first link of an existing account; the break-glass row does not count as another admin). | D22; review 2026-09-19 |
| I9 | Client secrets at rest go through the product's existing key-wrap (`secretWrap`); never plaintext. | D24 |
| I10 | Audit events use the §5 names, written through the product's existing audit writer; clamp to the product's column widths. | §5 |
| I11 | Products that are portals for non-staff (MyBooks portal, 1099 recipient/client portals, Connect portal, T&B portal realm) leave those realms untouched; only the staff realm gets SSO. MyBooks `user_type='client'` is denied. | D5, D29 |
| I12 | Manifest (`.appliance/manifest.json` **and** the vendored `Vibe-Appliance/console/manifests/<slug>.json`) gains `"requires": ["identity"]` and the `sso` block, plus a Caddy matcher `{ "name": "auth", "path": "/auth/*", "upstream": "<api tier>" }` whenever the SPA is a separate container. `internalUrl` = the API tier. `breakglassCommand` must work in the shipped image (distroless → `node <path>/cli.js`; tsx-only images → `tsx …/cli.js`). **Verify it with `docker exec` from the container's real working directory** (an entrypoint may `cd`; the CLI resolves both `package.json` and the adapter from `process.cwd()`), and remember the Appliance reads the **vendored** manifest: until that copy has the `sso` block it execs `<slug>-server` with `npx` and swallows the failure. | Phase 6 contract; review 2026-09-19 |
| I13 | Every PR ships a scripted end-to-end check against the package's fake IdP (copy `trial-balance-app` / `Vibe-Sentinel` scratch scripts into `test/sso-e2e.mjs` in the product) and green existing tests. | exit gate |
| I14 | No product session model is redesigned. If the discovery notes say "no revocation today", the revocation list is the fix; do not migrate a product from JWT to server sessions as part of this work. | scope |

---

## 2. The recipe (same for every product)

Each step names the reference file to copy from. Steps A–E are server, F–G client, H manifest/CLI, I tests, J PR.

**A. Dependency + tables**
- Add the package (see P1). CJS servers use `require`; ESM import.
- Migration that executes `sql/auth_identities.sql` (or imports `@kisaesdevlab/vibe-auth/sql/drizzle`), plus an `auth_sessions_oidc` table for JWT products. Reference: `trial-balance-app/server/migrations/20260916000001_vibe_auth.js`, `Vibe-Sentinel/packages/schema/migrations/0004_vibe_auth.sql`.

**B. UserAdapter** (`src/lib/vibeAuthUsers.ts`): reference `trial-balance-app/server/src/lib/vibeAuthUsers.ts` (int ids, username-based) and `Vibe-Sentinel/apps/api/src/lib/vibeAuthUsers.ts` (uuid, email-based). Map the product row → `VibeUser`; implement all eight methods; `findByUsername` for email-only products maps `vibe-breakglass` → **a dotted address** such as `vibe-breakglass@<slug>.local` or `@appliance.local`. **Not `@localhost`** (corrected 2026-09-19): seven of the nine remaining products validate the login identifier as an email with a dotted domain and reject it, and all three implemented email-login products chose a dotted domain on their own. Three things go together: (1) the login body's validation must admit the literal `vibe-breakglass` (1040's `z.union([z.string().email(), z.literal(BREAKGLASS_USERNAME)])`), because the Appliance prints only the username; (2) set `breakglassEmail` on the CLI adapter to the same address, or derive it from the username in `createLocalUser` so the two cannot drift; (3) map the address **back to the username** before calling `auth.localLoginAllowed` and `auth.afterLocalLogin` — both compare against the username, and a product that passes only the email never emits `vibe.auth.breakglass.used`. Per-product detail: `integration-plans/break-glass-and-rollout-risks.md`.

**C. SessionAdapter** (`src/lib/vibeAuth.ts`):
- server-side store → `create` inserts + sets the cookie exactly as the login route does; `destroy`, `currentUserId`, `currentIdentity`, `destroyByIdentity` (by `oidc_sid`, `(issuer, subject)`, `user_id`).
- stateless JWT → `create` mints the product JWT with a `sid` claim and hands it to the SPA via the TB `#sso_token=` hand-off (reference `trial-balance-app/server/src/lib/vibeAuth.ts` → `vibeAuthMiddleware()` rewriting the 302); `issueToken` returns the same JWT for desktop clients.
- Redis / memory stores → same as server-side; `destroyByIdentity` walks the user's session index.

**D. Engine** (`createVibeAuth`): product roles vocabulary + `defaultRoleMap`, `createPgStores({ query })` (pg pool `query`, `knex.raw(...).then(r => r.rows)` does **not** work — borrow a pg connection as TB does; drizzle: `db.execute(sql.raw)` or the pool), `secretWrap`, `audit`, `basePath: ""`, `loginPath`, `breakglassLoginPath`, `trustProxy: true`, `syncRoles: true`. Fastify products use `vibeAuthFastify` + `@fastify/formbody`.

**E. Wiring**: mount per I3; `guardLocalLogin` + `afterLocalLogin` per I5; revocation check per I6; `await auth.start()` per I4. Expose `GET /api/…/me` if the product lacks one (Investments).

**F. Login UI**: wrap the existing credentials form in `<LoginPanel basePath returnTo>`; add the `/login/local` route with `breakglass`; for JWT products handle the `#sso_token=` fragment (reference `client/src/pages/LoginPage.tsx` + `utils/loginFlow.ts` in TB). Sign-out calls `/auth/oidc/logout` when the session came from SSO.

**G. Settings page**: `<AuthSettingsPage basePath productName fetch>` behind the product's admin gate (bearer/CSRF header injected through the `fetch` prop). Nav entry per the "Settings nav file" column in COMPAT §B.

**H. CLI + manifest**: `vibeAuthAdapter.ts` default-exporting `{ users, audit, adminRole, breakglassEmail, close }`; `"vibeAuth": { "adapter": … }` in package.json; verify `breakglass status` runs in the image's runtime. Manifest per I12; add the same `sso`/matcher to `Vibe-Appliance/console/manifests/<slug>.json` on the `vibe-auth-integration` branch.

**I. Tests**: existing suites green; `test/sso-e2e.mjs` covering: status in `local`/`both`; PKCE login → JIT with mapped role; existing-user email link + role sync; unverified email denied; `/auth/settings` 403/200; mode `oidc_only` guard; break-glass local login + audit; back-channel logout revokes; fresh login after revocation; RP-initiated logout; boot refusal without break-glass.

**J. PR**: title `feat: single sign-on via @kisaesdevlab/vibe-auth (Phase 8 step N)`; body = files, deviations from this plan and why, commands run with results, the `sso` manifest block, and the docs/sso.md operator note. End with the session attribution lines.

**Exit gate per product**: I steps all green, manifest validated by `Vibe-Appliance/tests/manifests`, `docs/sso.md` present, STATE.md row updated.

---

## 3. Per-framework and per-session-model variants

| Variant | Products | What differs |
|---|---|---|
| Express + server-side sessions | 1099, Entity, Investments, Calculators, Connect, T&B (Redis) | Routine: C-server-side; `destroyByIdentity` against the sessions table/Redis index |
| Express + stateless JWT | MyBooks, Tax Research Chat | TB pattern: `sid` claim, `#sso_token` hand-off, revocation check every request, `auth_sessions_oidc` |
| Fastify 5 | AI Router, Recap, 1040 | `await app.register(vibeAuthFastify, { auth })` **outside** any `/api` auth hooks; register `@fastify/formbody`; `SessionAdapter` receives Fastify `request`/`reply` (set cookies via `reply.setCookie`); the raw objects are typed `never` in the package — cast |
| Go | Backup | No package. Stays behind the Appliance console proxy (Q10); nothing to do in v1 beyond the manifest note |

Fastify note: the plugin registers `GET/POST/PUT ${basePath}/auth/*`; make sure Recap's blanket "everything under `/api/` needs a session" hook does not cover `/auth/*` (it does not — `/auth` is not under `/api`).

---

## 4. Per-product plans (build order)

Effort is Claude Code wall-clock on this workstation, including tests. Confidence is for the PR to pass its exit gate without design changes.

### 4.1 Time & Billing — `Vibe-Time-Billing` (Express, Redis sessions, layered RBAC, Tauri) — 3–4 h, 90%
- Users `app_user` (uuid, `firm_id`, `status` enum ACTIVE/INACTIVE/ARCHIVED, `password_hash` nullable) — `packages/db/src/schema/core.ts:715`. Roles live in `user_role` join rows; `UserAdapter.setRole` replaces the user's `role` row with the slug's system role (`roles` table, `system_flag`), never touching `role_permission_override`. Vocabulary `["admin","partner","manager","senior","staff"]`, adminRole `admin`, map: vibe-admin/it→admin, vibe-partner→partner, vibe-manager→manager, vibe-staff→staff.
- Sessions: `apps/api/src/auth/session-store.ts:39` (`createSessionStore(redis)`, realm `staff`); `create` = `store.create` + `writeSessionCookie` (`cookies.ts:39`); `destroyByIdentity` = look up `auth_sessions_oidc` (add) → `destroyAllForUser`. CSRF: settings-page fetch must send `X-CSRF-Token` from `sessionStorage.__vibe_csrf`.
- Mount after the webhook block and `/api/v1` API-token router (`apps/api/src/app.ts:270-370, 1414`), before `app.use('/api/staff', auth.requireAuth …)` (`:573`). Login guard on `POST /api/auth/login/password` (`auth/staff-routes.ts:526`); the magic-link login also calls `afterLocalLogin`.
- Second factor: `isSecondFactorRequired()` fails closed; SSO sessions must record `secondFactorSatisfied` when `amr` contains an MFA method (`VIBE_OIDC_REQUIRE_MFA_AMR=true` recommended for T&B).
- Desktop: `apps/desktop` (Tauri v2) — add `@fabianlars/tauri-plugin-oauth` + `loopbackLogin` from `@kisaesdevlab/vibe-auth/tauri`; `SessionAdapter.issueToken` mints an API token row (`mcp_token` table) scoped to the user. Exit check: loopback login on Windows.
- Settings nav: `apps/web/src/pages/admin/index.tsx:85` GROUPS → People; route in the inner `<Routes>` (`:338-401`). UI kit is `@vibe/ui` tokens — pass `classNames` to the components.
- Manifest: no `.appliance/manifest.json` exists in the repo — create one from `Vibe-Appliance/console/manifests/vibe-time-billing.json` and add the `sso` block; `internalUrl: http://vibe-time-billing-api:3001` (check overlay service name).

### 4.2 MyBooks — `myBooks` (Express, JWT access + refresh, tenants) — 3 h, 85%
- Users `users` (uuid, `tenant_id`, `user_type`, `role`, `is_active`) — `db/schema/auth.ts:26`; `inviteUser()` at `services/auth.service.ts:921` is the creation path (call it with a random temp password, then mark). Deny `user_type !== 'staff'` in `findByEmail`/`findById` (I11). Single-tenant install: use the first/only tenant (`TenantResolver` default); JIT users get `role` from the map: vocabulary `["owner","accountant","bookkeeper","readonly"]`, adminRole `owner`, map vibe-admin/it/partner→owner, vibe-manager→accountant, vibe-staff→bookkeeper.
- Sessions: access JWT (`services/auth.service.ts:60`) + refresh row (`sessions` table). `create` = `issueSession()` for the user (mints access+refresh, sets the HttpOnly refresh cookie) and hands the access token via `#sso_token`; add `sid` to the access JWT claims; `destroyByIdentity` deletes the user's `sessions` rows and revokes. Reject tokens carrying `typ/tfa_pending/checks_stepup` stays as is (`middleware/auth.ts:125`).
- Revocation check inside `authenticate()` right after `jwt.verify` (`middleware/auth.ts:113`); it already re-reads `users.isActive` every request.
- Mount after Stripe/Plaid/SMS raw-body routers and `staffIpAllowlist` (`app.ts:190-284`) — keep the ordering comment intact. Login guard on `routes/auth.routes.ts:145`.
- Client: `packages/web/src/features/auth/LoginPage.tsx`; token store `api/client.ts` (`setTokens`); settings tile in `features/settings/SettingsPage.tsx:171`; route in `App.tsx`; RR7.
- Manifest: `.appliance/manifest.json` exists (`publicUrlEnvVar: PUBLIC_URL`); `internalUrl: http://vibe-mybooks-api:3001`; publicPaths: Plaid, Stripe, SMS, `/oauth/*`, `/api/v2/*`, `/mcp`, `/api/portal/*`, `/api/w9`, `/api/bank-connect`, `/api/peer/pm/*`, `/api/setup/*`, health/ping. MyBooks is also an OAuth **provider** (`routes/oauth.routes.ts`) — leave it; note in docs/sso.md that it is unrelated.

### 4.3 AI Router — `Vibe-AI-Router` (Fastify, in-memory sessions) — 2 h, 85%
- Users `users` (uuid, `firm_id`, `role` enum admin/partner/staff, nullable `password_hash`, **`external_ref` reserved for SSO sub**, no active flag) — `db/schema.ts:98`. Add an `is_active boolean default true` column in the migration (needed for `setActive`); write `external_ref = subject` on link. Vocabulary `["admin","partner","staff"]`.
- Sessions: `src/admin-api/session.ts` in-memory `SessionStore`; `create` = `store.create(user)` + cookie (`:126-136`); `destroyByIdentity` = `store.destroyByUser(userId)`. Sessions are per-container (gateway vs console) — mount the engine only in the `console` role (`ROUTER_ROLE`).
- Admin gate: `requireAdmin` (`routes.ts:123`) needs `x-vibe-admin: 1` on non-GET — the settings page `fetch` prop adds it.
- publicPaths: `/v1/*` (app tokens), `/healthz`, `/version`, `/role`, `/metrics`, `/admin/*` bootstrap surface.
- UI: hash router `ui/src/App.tsx:14-24` PAGES → add `auth`; login `ui/src/pages/Login.tsx`.
- Bonus (found in Phase 0): 1040 probes `GET /v1/policy/regions` which does not exist — out of scope, note in PR.

### 4.4 Tax Research Chat — `Vibe-Tax-Research-Chat` (Express, JWT 15 m + refresh) — 2–3 h, 85%
- Users `users` (uuid, `role` admin/user/viewer, `is_active`, `deleted_at`) — `packages/db/src/schema/users.ts:6`; creation `routes/admin/users.ts:69`. Vocabulary `["admin","user","viewer"]`, map vibe-admin/it/partner→admin, vibe-manager→user, vibe-staff→user.
- Sessions: `lib/jwt.ts` `signAccess`/`signRefresh`; `create` mints both, stores the refresh row, hands the access token via `#sso_token` and sets the `vibe_at` cookie; `sid` claim; revocation check in `middleware/auth.ts:41-47` (there is **no DB check today** — the revocation lookup is the first one; keep it to one indexed read).
- Mount after `POST /api/webhooks/*` (raw body, `app.ts:75-79`), `/api/ping`, `/api/health*`, `/api/dl/:token`, `/api/setup/*`.
- Client: `apps/web/src/lib/api.ts` (`apiUrl()` BASE_URL-aware, single-flight refresh) — the settings `fetch` wrapper must reuse it; login `pages/Login.tsx` (keep the `/setup` first-run redirect); admin nav `pages/admin/AdminLayout.tsx:23-36`.
- Manifest: exists (`ping`, `health` deep); `internalUrl: http://vibe-tax-research-api:4000` (verify overlay name).

### 4.5 1099 — `Vibe-1099` (Express, Redis sessions, CSRF, tsx runtime) — 2 h, 95%
- Users `users` (uuid, `firm_id`, `role` text admin/preparer/reviewer, `active`, composite unique `(firm_id,email)`) — `packages/db/src/schema.ts:79`. Vocabulary `["admin","reviewer","preparer"]`.
- Sessions: `apps/api/src/middleware/auth.ts:24-83` (`createSession`, `destroyAllUserSessions`); `create` sets `v1099_sid` + `v1099_csrf` cookies exactly as `routes/auth.ts:76`. Settings `fetch` adds `x-csrf-token` from the cookie (`apps/web/src/api.ts:17`).
- Mount before the staff router (`app.ts:102`) but after `/api/portal`, `/api/w9-public`, `/api/client-portal`, `/api/webhooks/taxbandits` and `staffIpAllowlist` (`app.ts:94-101`).
- CLI: image runs tsx with no build — `breakglassCommand: ["pnpm","--filter","@vibe1099/api","exec","tsx","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` (verify path resolution in the image).
- UI: single settings page with tab state `apps/web/src/staff/Settings.tsx:59` — add an `authentication` tab.

### 4.6 Entity — `vibe-entity` (Express, Postgres sessions, hand SQL migrations) — 2 h, 95%
- Users `users` (uuid, `firm_id`, `email_lower`, role CHECK admin/staff/viewer, **no disabled flag**) — add `disabled_at timestamptz` in the migration and honour it in `resolveSession`. Creation `createAuthStore(db).createUser()` (`auth-service.ts:237`). Vocabulary `["admin","staff","viewer"]`.
- Sessions: `sessions` table with `revoked_at` (`auth-service.ts:8-149`); `create` = same as `/login` (`routes/auth.ts:57-85`); `destroyByIdentity` = `revokeSession` for the user's rows.
- Replace the dormant `apps/api/src/auth.ts` bearer-OIDC stub with the package; drop `VIBE_APPLIANCE_OIDC_ISSUER` from `.env.example`. Also remove the `testAuth` fallback risk (`app.ts:64-75`) from the SSO path.
- Mount before `sessionAuthMiddleware` (`app.ts:114`); public: `/api/v1/ping`, `/healthz`, `/api/v1/health`, `/readyz`, `/metrics/resources`, auth request/verify.
- UI: inline-style React; settings tabs `apps/web/src/pages/settings.tsx:7-45`. Delete the stray empty dir `vibe-entity;C` in the workspace (not in the repo).

### 4.7 Investments — `Vibe-Investments` (Express, Postgres sessions, capability matrix) — 2–3 h, 85%
- Users `app_user` (uuid, `is_active`), roles in `user_role` (composite PK with `scope_client_id`) — `packages/db/src/schema/auth.ts:24-65`. `setRole` replaces the user's unscoped `user_role` row. Vocabulary `["ADMIN","MANAGER","REVIEWER","PREPARER","READ_ONLY"]`, adminRole `ADMIN`, map vibe-admin/it→ADMIN, vibe-partner→ADMIN, vibe-manager→MANAGER, vibe-staff→PREPARER.
- **No user-create route and no `/me` exist**: JIT is the creation path; add `GET /api/v1/auth/me` (the SPA's `useSession` currently fakes it — `apps/web/src/auth/useSession.ts:17-50`; replace with the real call).
- Sessions: `apps/api/src/auth/sessions.ts` (`createSession`, `revokeAllSessionsForUser`); cookie `vibe_session` Strict.
- Mount before the `/api/v1/*` routers (`index.ts:83`); public: `/health`, `/api/health`.
- No settings section exists — add `/auth-settings` route (`App.tsx:~25`) and a link in `AppShell.tsx:~74`. **No `.appliance/manifest.json`** — create one (image names from the compose file) and vendor it; this product is not yet appliance-integrated, so flag that in the PR.

### 4.8 Calculators — `Vibe-Calculators` (Express, Postgres sessions + API keys, distroless) — 2 h, 90%
- Users `users` (**text** id, `status` pending/active/suspended, `archived_at`, role enum admin/reviewer/preparer/readonly) — `packages/db/src/schema/users.ts:35`; invite route `routes/admin-users.ts:90`. `active` = status active and not archived; JIT sets status `active`. Vocabulary `["admin","reviewer","preparer","readonly"]`.
- Sessions: `apps/api/src/lib/sessions.ts` (session id = sha256 of cookie); `create` mirrors `routes/auth.ts:67`+`lib/cookies.ts`; `destroyByIdentity` = `revokeAllUserSessions`.
- Mount after `/api/health`, the OpenAPI route and `/api/v1/admin/firm-settings/public` but **before** `loadSession` (`server.ts:96-100`), so the bearer API-key path is unaffected.
- Distroless image: `breakglassCommand: ["/nodejs/bin/node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` (verify the node path in `gcr.io/distroless/nodejs20-debian12`); adapter compiled to `dist/vibeAuthAdapter.js` (run `scripts/fix-esm-extensions.mjs`).
- UI: Radix/shadcn — pass `classNames`; `NAV_ITEMS` in `components/layout/AppShell.tsx:45-68`, route + `RequirePerm perm="settings:write"` in `App.tsx:~385`; API router mounted in `server.ts:~137`.

### 4.9 1040 — `Vibe-1040` (Fastify, Postgres sessions with MFA gate) — 2–3 h, 80%
- Users `users` (uuid, role admin/partner/staff, `disabled_at`, `mfa_method`) — `src/db/schema.ts:89`; creation `admin-routes.ts:99`. Vocabulary `["admin","partner","staff"]`.
- Sessions: `src/auth/session.ts` (`issueSession`, `satisfyMfa`, `revokeSession`); **`requireUser` demands `mfa_satisfied_at`** (`middleware.ts:24-32`). `SessionAdapter.create` must call `satisfyMfa` when `identity.amr` satisfies MFA; set `VIBE_OIDC_REQUIRE_MFA_AMR=true` by default in this product's env template so SSO sessions are always MFA-satisfied.
- Fastify plugin registered before the global `preHandler` that attaches users is fine (it does not reject); mount before route registration. Public: `/health`, auth/mfa/totp/forgot/reset.
- Standalone install with its own Postgres: registration happens through `deploy/compose.yml` standalone mode (`POST /vibe-auth/registrations` by the operator; document in docs/sso.md) — no appliance manifest changes beyond the `sso` block.
- UI: view-state machine `src/App.tsx:12`, admin tabs `ui/src/components/Admin.tsx:12-39`; login is inline in `App.tsx:80`.

### 4.10 Recap — `Vibe-Recap` (Fastify, Postgres sessions with CSRF, standalone) — 2 h, 85%
- Users `users` (uuid, ordered roles viewer<staff<preparer<admin, `disabled`) — `apps/api/src/db/schema.ts:19`; creation `routes/users.ts:50`. Vocabulary ordered `["admin","preparer","staff","viewer"]` (most privileged first for the package), map vibe-admin/it→admin, vibe-partner→admin, vibe-manager→preparer, vibe-staff→staff.
- Sessions: `sessions` table with `csrf_token`; `create` = insert + `recap_sid` cookie (`routes/auth.ts:17-25`) — generate a csrf token and return it to the SPA (the SPA stores it from the login response; for SSO, expose it via `GET /api/auth/me`).
- `authPlugin` Origin allow-list + CSRF double-submit apply under `/api/`; `/auth/*` is outside. zod 4 in the app vs zod 3 in the package — separate copies, no conflict.
- Standalone (own Postgres + Caddy): registration via the broker's API as in 1040. Web is React 19 + RR7 + Tailwind 4: `SettingsLayout` TABS `pages/Settings.tsx:4-12`, route `App.tsx:108`.

### 4.11 Connect — `Vibe-Connect` (Express, express-session pg, Knex, Tauri, existing OIDC) — 3–4 h, 80%
- Replace `apps/server/src/routes/oidc.ts` with the package (keep its `validateIssuerUrl` SSRF guard as the settings-page issuer validator — port it into the product's `PUT /auth/settings` wrapper or contribute it upstream). Env mapping `OIDC_ISSUER_URL…` → `VIBE_OIDC_*` with a one-release fallback like Sentinel.
- Users `users` (uuid, **`username` unique**, email nullable non-unique, `is_admin`, `is_active`) — vocabulary `["admin","staff"]`, adminRole `admin`; `setRole` flips `is_admin` (and **demotes** when the map says staff — the old code never did). Add a unique index on `lower(email)` where not null (migration) — required for safe email linking. JIT via `usersRepo.create` with a random bcrypt hash (as the old OIDC route did).
- Sessions: `express-session` + `connect-pg-simple`; `create` = `req.session.regenerate` + set `userId/isAdmin` exactly like `routes/auth.ts:77-82`; `destroyByIdentity` = `terminateSessionsForUser`.
- **D17**: device keys stay on the separate device passphrase; change the enrolment copy at `apps/web/src/pages/Enrollment.tsx:49` to stop suggesting the login password; document the "two secrets" support story in docs/sso.md. Login page already has an SSO button (`Login.tsx:91-105`) — swap its URL to `/auth/oidc/start`.
- Desktop: Tauri v2 with `script-src 'self'` CSP — use `loopbackLogin` + `issueToken` (mint a session row and return its cookie value as bearer; add a bearer→session shim in `requireAuth`). Exit check on Windows.
- Public: `/ping`, `/health`, `/__vibe-boot.js`, ACME, `/bridges/*`, `/api/public/intake/*`, `/portal/*`.
- Admin nav `apps/web/src/pages/Admin.tsx:14-31` tabs + routes `:88-110`.

### 4.12 Backup — `Vibe-Backup` (Go) — 0.5 h, 100%
- No code change. Stays behind the console proxy (`/admin/apps/vibe-backup/`, Q10). Add a note to its README and to the Appliance manifest `_doc` that identity is the console's. Nothing to register.

---

## 5. Appliance side per product (on `Vibe-Appliance@vibe-auth-integration`)
1. `console/manifests/<slug>.json`: `requires`, `sso` (with `internalUrl`, `breakglassService`, `breakglassCommand`), and the `/auth/*` matcher when the SPA is separate. Run `npm test` in `console/` (manifest validation).
2. If the product's env template needs a default (1040: `VIBE_OIDC_REQUIRE_MFA_AMR=true`), add the line to `env-templates/per-app/<slug>.env.tmpl`.
3. `docs/MANIFEST_SCHEMA.md` needs no change unless a new `sso` field is required — if it is, add it to the schema first and to the broker's `registrationInput`.

---

## 6. Phase 7 additions
After each product merges, add its slug to the Phase 7 run: `sudo bash phase7.sh --products "vibe-tb vibe-time-billing …"`. Products that are standalone (1040, Recap) are verified with `deploy/compose.yml --profile bundled` next to the product's own compose instead.

---

## 7. Human checkpoints
- **H5** — after P1 (package published), approve switching all `file:` dependencies to `^1.0.0` (one commit per branch).
- **H6** — desktop logins (T&B, Connect) verified by a human on Windows and macOS.
- **H7** — MyBooks and T&B role maps reviewed by the firm before `oidc_only` is offered for those two (layered permissions).
- **H8** — one non-author walks `docs/firm/runbooks.md` R2 (break-glass) against a product in `oidc_only` (this is H4 from the build plan, scoped).

---

## 8. Templates

**Adapter skeleton (server-side sessions, Express)** — copy `Vibe-Sentinel/apps/api/src/lib/vibeAuth.ts` and `vibeAuthUsers.ts`; swap the table, cookie writer and hash function.
**Adapter skeleton (stateless JWT)** — copy `trial-balance-app/server/src/lib/vibeAuth.ts` (`vibeAuthMiddleware`, `#sso_token`, `auth_sessions_oidc`, `setRevocationCheck`).
**Fastify wrapper** — 
```ts
await app.register(vibeAuthFastify, { auth });          // before any /api hooks
// SessionAdapter.create(req, reply, user, identity) → reply.setCookie(...)
```
**Manifest `sso` block** — see `Vibe-Appliance/console/manifests/vibe-tb.json:29-38`.
**PR body** — see the Sentinel commit `6834a61` message and `docs/sso.md` in that repo.

---

## 9. Definition of done (v1 roll-out)
- All twelve PRs merged with green exit gates; `STATE.md` Phase 8 rows filled.
- Package consumed from GitHub Packages, not `file:` (P1/H5).
- Phase 7 table includes every SSO-capable product in all three modes.
- Firm docs list every product's Settings → Authentication location.
