# Vibe Tax Research Chat — SSO implementation plan

Repo `Vibe-Tax-Research-Chat` · slug `vibe-tax-research` · Express 4 + **stateless JWT** (access 15 min bearer in localStorage **and** `vibe_at` cookie, rotating refresh rows) · two containers (`vibe-tax-api:4000`, `vibe-tax-web:80`) · **estimate 2–3 h, confidence 85%**.

Variant: **Express + stateless JWT → Trial Balance pattern**. Read `README.md`, `../INTEGRATION-PLAN.md` §1–§2, §4.4.

## 0. Facts

| Item | Anchor |
|---|---|
| App | `apps/api/src/app.ts`: `trust proxy` :55, raw-body webhooks mounted before json `:79`, health `:106`, ping `:107`, Bull Board `/admin/queues` `:111` (cookie-authenticated) |
| Auth routes | `apps/api/src/routes/auth.ts`: login `:33-101`, refresh `:105`, logout `:169`, me `:187`, change/forgot/reset `:217/:289/:343` |
| Cookie | `apps/api/src/lib/cookies.ts:19-43` (`vibe_at`, httpOnly, lax, `COOKIE_SECURE=auto|true|false`, 15 min) |
| Tokens | `apps/api/src/lib/jwt.ts` `signAccess`/`signRefresh`; refresh rows `auth_refresh_tokens` |
| Middleware | `middleware/auth.ts` `requireAuth` :26 (bearer else cookie), `requireRole` :50; mounted **per router** (`routes/admin/*.ts`, `chats/index.ts:23`, `clients/index.ts:25`, …) |
| Users | `packages/db/src/schema/users.ts:6-26` (`email` unique, `password_hash`, `role` enum admin/user/viewer, `is_active`, `deleted_at`); admin create `routes/admin/users.ts:69-96` |
| Public routes | `/api/health`, `/api/health/deep`, `/api/ping`, `/api/setup/*`, `/api/auth/login|refresh|forgot-password|reset-password`, `/api/webhooks/*` (github/opensign/stripe, raw body), `/api/dl/:token` |
| SPA | `apps/web/src/pages/Login.tsx` (`/setup` redirect `:22-39`), `lib/api.ts` (`apiUrl()` `:27-34`, single-flight refresh `:36-68`), token store `lib/token-store.ts:9`; base-path sentinel `vite.config.ts:18-24` |
| Config | `config/env.ts`: `PUBLIC_BASE_URL` :17, `ALLOWED_ORIGIN` :25 (list, `regex:`), `COOKIE_SECURE` :40, `TRUST_PROXY` :47, `JWT_SECRET`/`JWT_REFRESH_SECRET` :65-68, `MASTER_KEY` |
| Image | `apps/api/Dockerfile`: node:24-alpine, node_modules per workspace (`/app/node_modules`, `/app/apps/api/node_modules`, `/app/packages/*/node_modules` :81-87), CMD `node apps/api/dist/index.js`, shell present |
| Migrations | drizzle SQL `packages/db/drizzle`, runner `packages/db/dist/migrate.js`, `MIGRATIONS_AUTO` |
| Manifest | `.appliance/manifest.json` exists (subdomain `tax` → `vibe-tax-web:80`, health `/api/health/deep`, ping `/api/ping`, `streaming: "sse"`); console `vibe-tax-research.json` |
| CLI | `apps/api/package.json` bin `vibe-backup`; `packages/db/src/seed.ts` |
| Tests | vitest 2 + supertest (`routes/ping.test.ts`, `webhooks/*.test.ts`) |

## 1. Decisions

1. **Roles.** Vocabulary `["admin","user","viewer"]`, `adminRole: "admin"`; map `vibe-admin`/`vibe-it`/`vibe-partner` → `admin`, `vibe-manager`/`vibe-staff` → `user`. `setRole` writes `users.role`.
2. **Session adapter = TB pattern, plus the cookie.** `create` mints access (with `sid`) + refresh exactly as `POST /login` does, inserts the refresh row, **sets `vibe_at`** (so Bull Board keeps working), and lands on `<return_to>#sso_token=<access>&sso_refresh=<refresh>` (the SPA's `token-store` needs both). `auth_sessions_oidc(sid, user_id, issuer, subject, idp_sid)`.
3. **Revocation on every request** (I6) in `requireAuth` after verify (`middleware/auth.ts:41-47`): the first DB read on that path today; one indexed lookup on `auth_revocations`. Also in `POST /refresh` (`:105`).
4. **SSE streams.** Token expiry mid-stream is handled today by the SPA's refresh; SSO changes nothing since the tokens are the product's own.
5. **Mount order (I3):** after `/api/webhooks/*` (`:79`), `/api/ping`, `/api/health*`, `/api/dl/:token`, `/api/setup/*`, before the per-router `requireAuth` mounts (first at `:111`). `guardLocalLogin` on `POST /api/auth/login` (`:33`); `afterLocalLogin` on success.
6. **First-run `/setup`.** `POST /api/setup/bootstrap` stays (creates the first local admin). In `oidc_only` it is refused like any local credential path; document that a fresh install must run setup **or** flip modes only after the first SSO admin exists.
7. **Two containers → `/auth/*` matcher**, `internalUrl: http://vibe-tax-api:4000`. Break-glass `["node","apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` from `WORKDIR /app`; adapter `apps/api/dist/vibeAuthAdapter.js`.
8. **CORS:** `ALLOWED_ORIGIN` already lists the appliance origin; nothing to add.

## 2. Steps

**A.** Dependency in `apps/api/package.json`, `.npmrc`, BuildKit secret in `apps/api/Dockerfile`. Drizzle migration in `packages/db/drizzle`: package SQL + `auth_sessions_oidc`.

**B.** `apps/api/src/lib/vibeAuthUsers.ts`: bcrypt unusable hash for JIT, `is_active`/`deleted_at` honoured in `findById`; audit → `audit()` (`apps/api/src/lib/audit.ts:15`).

**C.** `apps/api/src/lib/vibeAuth.ts` (TB copy): `secretWrap` via `lib/crypto.ts` (`MASTER_KEY` HKDF purpose-bound AES-GCM); stores on the pg pool.

**D.** Wiring per §1.5; `await auth.start()` in `apps/api/src/index.ts` after migrations.

**E.** SPA: `Login.tsx` `<LoginPanel basePath={import.meta.env.BASE_URL.replace(/\/$/, "")} returnTo="/">` (keep the `/setup` pre-check); `/login/local` route; fragment hand-off through `lib/token-store.ts` (copy TB `loginFlow.ts`); settings page under `pages/admin/AdminLayout.tsx:23-36` nav with the `apiUrl()`-aware fetch (`fetch` prop must reuse `lib/api.ts` so refresh-on-401 works).

**F.** Manifests (`.appliance/manifest.json` + console):
```jsonc
"requires": ["identity"],
"routing": { "default_upstream": "vibe-tax-web:80",
  "matchers": [ { "name": "api", "path": "/api/*", "upstream": "vibe-tax-api:4000", "streaming": true },
                { "name": "queues", "path": "/admin/queues/*", "upstream": "vibe-tax-api:4000" },
                { "name": "auth", "path": "/auth/*", "upstream": "vibe-tax-api:4000" } ] },
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/api/health","/api/health/deep","/api/ping","/api/setup/*","/api/webhooks/*","/api/dl/*","/api/auth/login","/api/auth/refresh","/api/auth/forgot-password","/api/auth/reset-password"],
  "edgeGate": false, "internalUrl": "http://vibe-tax-api:4000",
  "breakglassService": "vibe-tax-api",
  "breakglassCommand": ["node","apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
(Keep the console manifest's existing matchers; add `auth`.)

**G.** Tests: `test/sso-e2e.mjs`; supertest: callback sets `vibe_at` and lands with both fragments; `requireAuth` 401 after revocation; `/refresh` refused after revocation; webhook tests still green (mount order).

**H.** `docs/sso.md`; PR `(Phase 8 step 4)`.

## 3. Exit gate additions

- Bull Board at `/admin/queues` opens after an SSO login (cookie path).
- LAN box: register, `both`, sign in at `http://<ip>/tax/`.
