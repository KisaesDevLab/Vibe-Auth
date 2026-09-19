# Vibe Recap — SSO implementation plan

Repo `Vibe-Recap` · slug `vibe-recap` · **Fastify 5** · Postgres sessions (`recap_sid`, **strict**, per-session CSRF token) · two containers (`vibe-recap-api:3000`, `vibe-recap-web:8080`) · `rootServedOnly` · **estimate 2–3 h, confidence 85%**.

Variant: **Fastify**. Read `README.md`, `../INTEGRATION-PLAN.md` §1–§3, §4.10.

> **Break-glass review, 2026-09-19.** The identifier is fine here (`z.string().max(200)`, no `.email()`) and there is no MFA. Two things
> are not: the command path in item 7 was wrong and is corrected below, and `forgot-password` lets a JIT account bootstrap
> local credentials from its mailbox whenever SMTP is on. `createLocalUser` must clear `mustChangePassword` for the
> break-glass row as this plan already does for JIT. Detail and anchors: `break-glass-and-rollout-risks.md`; the corrected recipe is
> `../INTEGRATION-PLAN.md` §2.B, I7, I8, I12.

## 0. Facts

| Item | Anchor |
|---|---|
| App | `apps/api/src/app.ts:63`; `authPluginRegistered` `:94` → `src/plugins/auth.ts`: Origin allow-list `:34-46`, CSRF `:49-58`, **session required for everything under `/api/`** unless `config.auth:false` `:61-65`, `requireRole` `:70` |
| Auth routes | `src/routes/auth.ts`: cookie options `:17-25` (`recap_sid`, httpOnly, **strict**, `secure: COOKIE_SECURE`), login `:57-123`, logout `:125`, reset `:181-221` |
| Sessions | `src/db/schema.ts:37-52` (`csrf_token`, `expires_at`, `last_seen_at`), `src/auth/session.ts` (destroy-others, sweep) |
| Users | `src/db/schema.ts:19-35` (`email` unique, `role`, `password_hash`, `disabled`, `must_change_password`, unused `totp_secret`); roles ordered `viewer<staff<preparer<admin` (`packages/shared/src/enums.ts:2`) |
| Public routes | `/healthz`, `/api/v1/health`, `/readyz`, `/api/setup/status`, `POST /api/setup`, `/api/auth/login`, password-reset endpoints, `/api/invite/:token` |
| Config | `apps/api/src/config.ts`: `COOKIE_SECURE` :23 (rendered from `@SESSION_SECURE@`), `TRUST_PROXY` :24, `ALLOWED_ORIGIN` :33, `PUBLIC_URL` :38, `REDIS_URL` |
| Image | `apps/api/Dockerfile` node:24-bookworm-slim, node_modules `/app/node_modules`, entrypoint `docker-entrypoint.sh` with `serve|seed-admin|migrate|rotate-master-key` shims |
| SPA | React 19 + RR7, `BrowserRouter` no basename (`main.tsx:10`), `lib/auth.tsx` (csrf in module state, `/api/auth/me` on boot), `Settings.tsx:4-12` tabs, `App.tsx:108` |
| Manifest | `.appliance/manifest.json` exists (`rootServedOnly`, routing web:8080 + `/api/*`, `/healthz`, `/readyz` → api:3000, emergency 5183, seed `seed-admin`); console copy adds `requiredApps ["vibe-ai-router"]` |
| Tests | vitest against real Postgres + Redis (`compose.test.yml`, `test/helpers.ts`), `auth.integration.test.ts`, `session.test.ts` |

## 1. Decisions

1. **`/auth/*` is outside `/api/`**, so the blanket session hook does not cover it and the Origin/CSRF checks do not apply; register the plugin before `authPluginRegistered` anyway for clarity. Add `/auth` to any SPA fallback the web nginx does (it proxies only `/api/*`, `/healthz`, `/readyz` today: the **`/auth/*` matcher is mandatory** and nginx in `vibe-recap-web` must proxy `/auth/` too, or Caddy's matcher must bypass the web container: the manifest matcher does that).
2. **CSRF token hand-off.** `SessionAdapter.create` inserts the session with a fresh `csrf_token`; the SPA obtains it from `GET /api/auth/me` on boot (`lib/auth.tsx` already does), so no fragment is needed.
3. **`SameSite=Strict` stays** (same-site IdP on the appliance).
4. **Roles.** Package vocabulary most-privileged-first `["admin","preparer","staff","viewer"]`, `adminRole: "admin"`; map `vibe-admin`/`vibe-it`/`vibe-partner` → `admin`, `vibe-manager` → `preparer`, `vibe-staff` → `staff`. `setActive` flips `disabled`. JIT: `must_change_password: false` (I7).
5. **Setup gate.** `POST /api/setup` self-disables once a user exists; JIT creation through SSO counts. Document that a fresh install can be bootstrapped either way; in `oidc_only` the setup route is refused (local credential).
6. **zod 4 vs the package's zod 3:** separate copies, no conflict (verified in §4.10).
7. **Break-glass:** the entrypoint dispatches subcommands; add `breakglass` to `docker-entrypoint.sh:12-17` mapping to `node /app/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass "$@"` (**absolute**: the entrypoint does `cd /app/apps/api` at `docker-entrypoint.sh:11` and the image has modules only at `/app/node_modules`, so the relative path first written here did not exist; that working directory is the right one for the CLI's `package.json` lookup), and set `breakglassCommand: ["docker-entrypoint.sh","breakglass","ensure","--json"]` (consistent with the manifest's `seed.command`). Adapter `apps/api/dist/vibeAuthAdapter.js`; `"vibeAuth": { "adapter": "./dist/vibeAuthAdapter.js" }`.
8. **Standalone installs** register by hand (`docs/sso.md`).

## 2. Steps

**A.** Dependency in `apps/api/package.json` (npm workspaces), `.npmrc`, BuildKit secret in `apps/api/Dockerfile`. Drizzle migration `apps/api/drizzle/0007_vibe_auth.sql`: package SQL + `sessions` OIDC columns.

**B.** `apps/api/src/lib/vibeAuthUsers.ts` (postgres.js via Drizzle); argon2 unusable hash (`src/auth/password.ts`); audit → `audit()` (`src/services/audit.ts:26`).

**C.** `apps/api/src/lib/vibeAuth.ts`: Fastify adapter (`reply.setCookie` with the options from `routes/auth.ts:17-25`), `create` inserts session + csrf; `destroyByIdentity` = delete matching rows; `secretWrap` via the `age`/`MASTER_KEY_PASSPHRASE` storage key (`src/services/storage.ts`) or a small AES-GCM on the same secret; `createPgStores` with `sql.unsafe`.

**D.** In `app.ts`: `await app.register(formbody); await app.register(vibeAuthFastify, { auth })` before `:94`; local-login `preHandler` on `POST /api/auth/login` (`routes/auth.ts:57`) keeping the rate limit and lockout; `afterLocalLogin`; `await auth.start()` in `index.ts` after migrations.

**E.** SPA: `pages/Login.tsx` `<LoginPanel basePath="" returnTo="/">` (Tailwind 4 `classNames`); `/login/local`; `SettingsLayout` TABS `pages/Settings.tsx:4-12` gains Authentication → `<AuthSettingsPage basePath="" productName="Recap" fetch={fetchWithCsrf}>`; sign-out → `/auth/oidc/logout?local=1` when SSO-born (expose on `/me`).

**F.** Manifests (both):
```jsonc
"requires": ["identity"],
"routing": { "default_upstream": "vibe-recap-web:8080",
  "matchers": [ { "name": "api", "path": "/api/*", "upstream": "vibe-recap-api:3000" },
                { "name": "healthz", "path": "/healthz", "upstream": "vibe-recap-api:3000" },
                { "name": "readyz", "path": "/readyz", "upstream": "vibe-recap-api:3000" },
                { "name": "auth", "path": "/auth/*", "upstream": "vibe-recap-api:3000" } ] },
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/healthz","/api/v1/health","/readyz","/api/setup/*","/api/auth/login","/api/auth/password-reset/status","/api/auth/forgot-password","/api/auth/reset-password/*","/api/invite/*"],
  "edgeGate": false, "internalUrl": "http://vibe-recap-api:3000",
  "breakglassService": "vibe-recap-api",
  "breakglassCommand": ["docker-entrypoint.sh","breakglass","ensure","--json"] }
```
Also add `location /auth/` → api to `apps/web/nginx.conf` for standalone installs.

**G.** Tests: extend `auth.integration.test.ts` (real Postgres): callback creates a session row with csrf; `/api/auth/me` returns it; a state-changing `/api` call with that csrf passes; back-channel deletes the row; `test/sso-e2e.mjs`.

**H.** `docs/sso.md`; PR `(Phase 8 step 10)`.

## 3. Exit gate additions

- LAN box: register, `both`, sign in at `http://<ip>:5183/` (root-served → emergency port), `oidc_only` + break-glass.
