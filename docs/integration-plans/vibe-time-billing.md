# Vibe Time & Billing — SSO implementation plan

Repo `Vibe-Time-Billing` · slug `vibe-time-billing` · Express 4 + **Redis sessions** (opaque sid, CSRF double-submit, TOTP/email/SMS/passkeys) · two realms (staff, client portal) · Tauri desktop · **estimate 4–5 h, confidence 85%**.

Variant: **Express + server-side sessions** with a Redis store. Read `README.md` and `../INTEGRATION-PLAN.md` §1–§2, §4.1 first; this plan corrects and extends §4.1 with the 2026-09-17 survey.

> **Break-glass review, 2026-09-19.** As written, break-glass **cannot sign in to this product at all.** The login regex requires a
> dotted domain (`staff-routes.ts:80`), so the `vibe-breakglass@localhost` first written in step B was a 400 (corrected below). Beyond that, the second factor is
> mandatory and fails closed, and an account with no enrolled factor is sent to a magic link, which needs SMTP and a real
> mailbox — the outage break-glass exists for. Decide before building: exempt the break-glass account, or enrol its TOTP at
> provisioning. Redis is also on the login path. JIT accounts can be reset from their mailbox (`/password/forgot`, magic link). Detail and anchors: `break-glass-and-rollout-risks.md`; the corrected recipe is
> `../INTEGRATION-PLAN.md` §2.B, I7, I8, I12.

## 0. Facts

| Item | Anchor |
|---|---|
| App | `apps/api/src/app.ts`; `trust proxy` unconditional `:269`; lock middleware `:557` (allowlists `/health/*`, `/metrics`, `/api/staff/admin/unlock`) |
| Staff auth routes (`/api/auth`) | `apps/api/src/auth/staff-routes.ts`: magic link `:154/:211`, password `:526`, 2FA `:622/:725`, passkey `:883/:921`, logout `:1629`, me `:1646` |
| Session store | `apps/api/src/auth/session-store.ts:1-38` (Redis, sha256(sid) key, 7 d sliding, `destroyAllForUser`, `destroyOthers`) |
| Cookies | `apps/api/src/auth/cookies.ts:24-51`: `STAFF_COOKIE_NAME` (`__vibe_app_session`), httpOnly, **`sameSite: 'strict'`**, `secure` from `APP_BASE_URL.startsWith('https://')` |
| CSRF | `auth/middleware.ts:73-89` `requireCsrf` vs `session.csrfToken`; SPA keeps it in `sessionStorage.__vibe_csrf` (`apps/web/src/api-client.ts:6-15`) |
| Auth mounting | per mount: `app.use('/api/staff', auth.requireAuth, auth.requireCsrf)` `:573` plus ~120 explicit mounts to `:2124`; portal routers take `requireAuth` injected |
| Users / roles | `app_user` (`packages/db/src/schema/core.ts:715+`, `firm_id`, `status`, nullable `password_hash`); `role`/`role_permission`/`user_role`/`role_permission_override` (`:834-900`); slugs `partner|manager|senior|staff|admin` (`packages/core/src/rbac/permissions.ts:202`) |
| Public routes | `/health*`, `/metrics`, raw-body webhooks `/api/webhooks/{opensign,stripe,stripe-connect,cpacharge,notifications}` (`:294-365, :2132`), `/api/auth/*`, `/api/portal/status|auth/*|branding|manifest.webmanifest`, token-in-URL `/api/shared*`, `/api/pay`, `/api/ach-verify`, `/api/mail-assets`, `/api/public/*`, `/api/calendar/rsvp`, `/api/v1` + `/mcp` (API tokens, `:1414-1417`), `/v1/internal`, `/api/staff/admin/unlock` |
| Config | `apps/api/src/config.ts`: `APP_BASE_URL` :18, `PORTAL_BASE_URL` :19, `STAFF_JWT_SECRET`/`PORTAL_JWT_SECRET` :29-30 (must differ), `KMS_KEY` :52, `WEBAUTHN_*`, `VIBE_AI_*` :104-106 |
| Image | `Dockerfile` node:24-bookworm-slim; node_modules at `/app/node_modules` + `/app/apps/api/node_modules`; prod entrypoint `ops/docker/entrypoint-api.sh:22-26` runs migrations then `node apps/api/dist/apps/api/src/server.js` |
| Migrations | `packages/db/migrations/*.sql` (lexical), runner `packages/db/src/scripts/migrate.ts` |
| SPA | `apps/web/src/pages/Login.tsx:38-80` (tabs), **no `base`** in `apps/web/vite.config.ts`; realms by Caddy hostname + `X-Vibe-Realm` |
| Manifest | **none in repo**; console `vibe-time-billing.json`: `rootServedOnly`, web `vibe-time-billing-web:80`, api matcher → `vibe-time-billing-api:3001`, worker wired via `depends_on` since 2026-09-17 |
| CLI | `apps/api/src/scripts/create-admin.ts`, `reset-password.ts`; `packages/db` bins `bootstrap-firm`, `migrate` |
| Tests | vitest + PGlite + ioredis-mock + supertest; RBAC seam `fakeUserRoles` (`app.ts:~258`) |

## 1. Decisions

1. **Staff realm only.** Portal (`/api/portal/*`, its own cookie and JWT secret) is untouched (I11).
2. **One choke point, not 120 edits.** `auth.requireAuth` already resolves the session from the Redis store. An SSO login **creates a normal staff session in that store**, so every existing mount keeps working unchanged. Do not add a second session kind.
3. **Roles.** Vocabulary `["admin","partner","manager","senior","staff"]`, `adminRole: "admin"`; map `vibe-admin`/`vibe-it` → `admin`, `vibe-partner` → `partner`, `vibe-manager` → `manager`, `vibe-staff` → `staff`. `setRole` replaces the user's `user_role` row with the firm's system role of that slug (`role.system_flag`), never `role_permission_override` (I8). Single firm on the appliance (`bootstrap-firm`).
4. **Second factor.** `isSecondFactorRequired()` fails closed. `SessionAdapter.create` marks `secondFactorSatisfied` when the ID token's `amr` shows MFA; set `VIBE_OIDC_REQUIRE_MFA_AMR=true` in the appliance env template so every SSO session is MFA-satisfied and never bounces into local 2FA enrolment. Passkeys remain a *local* credential and are refused in `oidc_only` except for break-glass.
5. **CSRF token for SSO sessions.** `create` mints `session.csrfToken` exactly as the password login does and the SPA must obtain it: extend `GET /api/auth/me` (`:1646`) to return `csrfToken`, and have the SPA store it on boot when `sessionStorage.__vibe_csrf` is empty. Without this, the first POST after an SSO login 403s.
6. **SameSite=Strict is fine on the appliance** (authentik is same-site: same host in LAN/single-host, `auth.<domain>` in subdomain mode). Do not relax it. It only matters for a remote broker (`remote-broker.md`), where the cookie must become `lax`; leave a config switch, default `strict`.
7. **Lock middleware.** Add `/auth/*` to `createLockMiddleware()`'s allowlist (`app.ts:557`) or the SSO callback deadlocks behind unlock.
8. **Root-served, two containers.** `rootServedOnly` means LAN access is the emergency port (5178/5179). The `/auth/*` matcher must exist in the manifest so `/auth/*` reaches the API (I12), and `internalUrl: http://vibe-time-billing-api:3001`.
9. **Tauri.** `apps/desktop` wraps the staff SPA. Use `loopbackLogin` from `@kisaesdevlab/vibe-auth/tauri` with `@fabianlars/tauri-plugin-oauth`; `SessionAdapter.issueToken` mints an `mcp_token` row scoped to the user (existing REST v1 auth) and the desktop uses it as bearer. Human checkpoint H6.
10. **Break-glass command**: `["node","apps/api/dist/apps/api/src/vibeAuthAdapter.js"]` is the adapter path; command `["node","apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` from `WORKDIR /app`. Verify in the image.

## 2. Steps

**A.** `apps/api/package.json` dependency `^1.0.3`; `.npmrc` registry; `Dockerfile` BuildKit secret around `pnpm install` (TB `Dockerfile.server:9-17`). Migration `packages/db/migrations/<next>_vibe_auth.sql`: package SQL verbatim + `auth_sessions_oidc(sid, user_id, issuer, subject, idp_sid, created_at)` (the Redis store has no room for identity columns; this table maps identity → user for `destroyByIdentity`).

**B.** `apps/api/src/lib/vibeAuthUsers.ts` (Drizzle over `app_user`): `findByUsername` maps `vibe-breakglass` → `vibe-breakglass@vibe-time-billing.local` (**not `@localhost`**: `EMAIL_RE` at `staff-routes.ts:80` requires a dotted domain; also admit the literal username in `LoginPasswordSchema`); `create` inserts `app_user` with `status ACTIVE`, null `password_hash` (magic-link-only users already exist that way), firm = the sole firm, and the mapped `user_role`; `setActive` flips `status`; audit sink → `emitAudit()` (`apps/api/src/auth/audit.ts:41`).

**C.** `apps/api/src/lib/vibeAuth.ts`: `SessionAdapter.create` = `store.create(user)` + `writeSessionCookie` (`cookies.ts:39`) + csrf token, then insert `auth_sessions_oidc`; `destroy` = store destroy; `destroyByIdentity` = look up the table → `destroyAllForUser`; `currentUserId` from the resolved session. Engine: `createPgStores` on the pg pool, `secretWrap` via `packages/crypto` (`KMS_KEY` AES-GCM), `basePath: ""`, `trustProxy: true`, `syncRoles: true`.

**D.** Mount `vibeAuthExpress(auth)` in `app.ts` after the webhook block and the `/api/v1` + `/mcp` token routers, **before** `:573`. `guardLocalLogin` on `POST /api/auth/login/password` (`:526`), on `verify-magic-link` (`:211`) and on `login/passkey/verify` (`:921`); `afterLocalLogin` after each success. `await auth.start()` in `server.ts`.

**E.** SPA: `Login.tsx` gets `<LoginPanel basePath="" returnTo="/">` above the tabs (root-served, so `basePath` is empty); `/login/local` route with `breakglass`; boot-time csrf fetch per §1.5; sign-out calls `/auth/oidc/logout?local=1` when `me` says the session is SSO-born. Settings: `<AuthSettingsPage productName="Time & Billing" fetch={fetchWithCsrf}>` under People in `apps/web/src/pages/admin/index.tsx:85` GROUPS, route in `:338-401`, `classNames` for `@vibe/ui`.

**F.** Create `.appliance/manifest.json` from the console manifest; add to both:
```jsonc
"requires": ["identity"],
"routing": { "default_upstream": "vibe-time-billing-web:80",
  "matchers": [ { "name": "api", "path": "/api/*", "upstream": "vibe-time-billing-api:3001" },
                { "name": "auth", "path": "/auth/*", "upstream": "vibe-time-billing-api:3001" } ] },
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/health","/health/*","/metrics","/api/webhooks/*","/api/auth/*","/api/portal/*","/api/shared*","/api/pay","/api/pay/*",
                  "/api/ach-verify/*","/api/mail-assets/*","/api/public/*","/api/calendar/rsvp","/api/v1/*","/mcp","/v1/internal/*","/api/staff/admin/unlock"],
  "edgeGate": false, "internalUrl": "http://vibe-time-billing-api:3001",
  "breakglassService": "vibe-time-billing-api",
  "breakglassCommand": ["node","apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
Appliance env template `vibe-time-billing.env.tmpl`: `VIBE_OIDC_REQUIRE_MFA_AMR=true`.

**G.** Tests: `test/sso-e2e.mjs` (TB copy) + supertest cases: SSO login yields a store session that passes `requireAuth`+`requireCsrf` with the csrf from `/me`; back-channel ends it; portal login unaffected in `oidc_only`; `fakeUserRoles` seam used for role assertions.

**H.** `docs/sso.md`; PR `feat: single sign-on via @kisaesdevlab/vibe-auth (Phase 8 step 1)`.

## 3. Exit gate additions

- LAN box: register, mode `both`, sign in at `http://<ip>:5178/` (emergency port is the LAN surface for root-served apps), then `oidc_only` + break-glass at `/login/local`.
- Desktop loopback login on Windows (H6).

## 4. Risks

- The csrf hand-off (§1.5) is the one new moving part; test it first.
- `entrypoint-api.sh`'s deep dist path (`apps/api/dist/apps/api/src/...`) must be mirrored for the adapter path in `package.json`'s `vibeAuth.adapter`.
