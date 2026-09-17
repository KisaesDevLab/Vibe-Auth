# Vibe Entity — SSO implementation plan

Repo `vibe-entity` · slug `vibe-entity` · Express 4 + **Postgres sessions** (sha256 token, 12 h, `revoked_at`) + magic links · two containers (`vibe-entity-server:3001`, `vibe-entity-client:80`) · **estimate 2–3 h, confidence 90%**.

Variant: **Express + server-side sessions**. Read `README.md`, `../INTEGRATION-PLAN.md` §1–§2, §4.6.

## 0. Facts

| Item | Anchor |
|---|---|
| App | `apps/api/src/app.ts`: `testAuth` synthetic-admin fallback when `deps.auth` missing `:58-75`; public `:81-111`; per-router `requireAuth` mounts `:114-172` |
| Auth routes (`/api/v1/auth`) | `apps/api/src/routes/auth.ts`: cookie set/clear `:20-43` (**`secure: false` hard-coded**), login `:57-85`, change-password `:90`, magic request/verify `:126/:147`, logout `:183`, me `:196`, `sessionAuthMiddleware`/`requireRole` `:229-260+` |
| Auth service | `apps/api/src/services/auth-service.ts`: sessions `:8-149` (`createSession` :117, `revokeSession` :143), `createUser` :237-255, `ensureAdminSeed` :175 |
| Users | `packages/db/src/schema/users.ts:5-29`: `firmId`, `email`, `emailLower` (**non-unique index**), `role` admin/staff/viewer, nullable `passwordHash`, `passwordResetRequired`, **no disabled flag**; `sessions` `:51` |
| Dormant OIDC stub | `apps/api/src/auth.ts:19-57` (`OidcVerifier`, `VIBE_APPLIANCE_OIDC_ISSUER`), unwired |
| Public routes | `/api/v1/ping`, `/healthz`, `/api/v1/health`, `/readyz`, `/metrics/resources`, `/api/v1/auth/*` (login/request/verify) |
| SPA | `apps/web/src/pages/login.tsx` (`:27`), `auth-context.tsx`, `App.tsx:24-59` (`RequireAuth` :37); relative API paths, **no base path** |
| Config | ad hoc `process.env`: `APP_BASE_URL ?? ALLOWED_ORIGIN` (`index.ts:28-30`), `MIGRATIONS_AUTO`, `FIRM_ID`, `ADMIN_EMAIL`, `ENCRYPTION_KEY`; `JWT_SECRET` provisioned but unread |
| Image | `apps/api/Dockerfile`: `pnpm deploy --prod /deploy` → node:20-alpine `/app` (node_modules `/app/node_modules`), CMD `node dist/index.js`, root |
| Migrations | numbered SQL `packages/db/migrations`, runner `packages/db/src/cli/migrate.ts`; manifest command `["node","dist/cli/migrate.js","up"]` looks stale (built path is `node_modules/@vibe-entity/db/dist/cli/migrate.js`) |
| Manifest | `.appliance/manifest.json` exists: routing `vibe-entity-client:80` + `/api/*` → `vibe-entity-server:3001`, `firstLogin` default creds `admin/admin1234` forced reset |
| Tests | vitest + supertest against `createApp(deps)`, mostly via `testAuth`; `test/auth.test.ts` stubs the OIDC verifier |

## 1. Decisions

1. **Replace the stub.** Delete `apps/api/src/auth.ts` and `VIBE_APPLIANCE_OIDC_ISSUER` (`.env.example:38-39`); `test/auth.test.ts` is rewritten against the package. The bearer-only stub would mislead.
2. **Close the `testAuth` hole on the SSO path.** `createApp` must refuse to start in production without real `deps.auth` (throw when `NODE_ENV=production && !deps.auth`). Tests keep injecting it.
3. **Schema fixes in the same migration:** `users.disabled_at timestamptz` (for `setActive`, honoured in `resolveSession`); **unique index on `(firm_id, email_lower)`** after a one-off duplicate check (the plan cannot link by email safely otherwise); `sessions` gains `oidc_issuer`, `oidc_subject`, `oidc_sid`.
4. **Cookie flags.** `secure: false` hard-coded and no `trust proxy`. Add `SESSION_SECURE` (rendered by the appliance from `install-mode-tls`, like vibe-1040) and `app.set('trust proxy', 1)`. On the LAN box it is false; in domain mode true. This is a prerequisite fix, not SSO polish.
5. **Roles.** Vocabulary `["admin","staff","viewer"]`, `adminRole: "admin"`; map `vibe-admin`/`vibe-it`/`vibe-partner` → `admin`, `vibe-manager`/`vibe-staff` → `staff`.
6. **Firm.** Single firm (`FIRM_ID`/`DEFAULT_FIRM_ID` seed); JIT users join it. `passwordResetRequired` must be `false` for JIT users (I7) so the forced-reset gate never fires on an SSO session.
7. **Session adapter.** `create` = `createSession` + the same cookie as `/login` (`routes/auth.ts:20-31`) with the OIDC columns; `destroyByIdentity` = `revokeSession` on matching rows. Magic links stay a local credential (guarded in `oidc_only`).
8. **Default credentials.** `firstLogin` advertises `admin/admin1234` with forced reset; in `oidc_only` that account cannot log in locally (only break-glass can). Document; keep the seed for `local`/`both`.
9. **Two containers → `/auth/*` matcher**, `internalUrl: http://vibe-entity-server:3001`. Break-glass `["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` from `/app`; adapter `dist/vibeAuthAdapter.js`.
10. Fix the stale migration command in the manifest while there.

## 2. Steps

**A.** Dependency in `apps/api/package.json`, `.npmrc`, BuildKit secret in `apps/api/Dockerfile`. Migration `packages/db/migrations/<next>_vibe_auth.sql`: package SQL + §1.3 columns/index.

**B.** `apps/api/src/lib/vibeAuthUsers.ts` over `AuthStore`/Drizzle: bcryptjs cost 11 unusable hash; `emailLower`; audit → `buildAuditEntry()` chain (`packages/db/src/audit-chain.ts:13-39`).

**C.** `apps/api/src/lib/vibeAuth.ts`: session adapter per §1.7; `secretWrap` via pgcrypto (`packages/db/src/crypto.ts:10-41`, `ENCRYPTION_KEY`) or a small AES-GCM wrapper on the same key; stores on the pg pool.

**D.** Mount `vibeAuthExpress(auth)` before `sessionAuthMiddleware` (`app.ts:114`) and after the public block (`:81-111`). `guardLocalLogin` on `POST /login` (`:57`) and on `GET /verify` (`:147`, magic link); `afterLocalLogin` after each. `await auth.start()` in `index.ts` after migrations.

**E.** SPA: `pages/login.tsx` `<LoginPanel basePath="" returnTo="/">` (root-served; inline-style app, pass `classNames`); `/login/local` route; settings tab in `pages/settings.tsx:7-45`; sign-out via `/auth/oidc/logout?local=1` when SSO-born (expose on `/me`).

**F.** Manifests (both):
```jsonc
"requires": ["identity"],
"routing": { "default_upstream": "vibe-entity-client:80",
  "matchers": [ { "name": "api", "path": "/api/*", "upstream": "vibe-entity-server:3001" },
                { "name": "auth", "path": "/auth/*", "upstream": "vibe-entity-server:3001" } ] },
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/api/v1/ping","/healthz","/api/v1/health","/readyz","/metrics/resources","/api/v1/auth/login","/api/v1/auth/request","/api/v1/auth/verify"],
  "edgeGate": false, "internalUrl": "http://vibe-entity-server:3001",
  "breakglassService": "vibe-entity-server",
  "breakglassCommand": ["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
Env template: add `SESSION_SECURE` from `install-mode-tls`.

**G.** Tests: rewrite `test/auth.test.ts` around the package with a real `deps.auth`; supertest: callback sets the cookie with `SESSION_SECURE` honoured; `passwordResetRequired=false` for JIT; unique-email migration test; `test/sso-e2e.mjs`.

**H.** `docs/sso.md`; PR `(Phase 8 step 6)`. Delete the stray empty `vibe-entity;C` directory in the workspace (not in git).

## 3. Exit gate additions

- Boot refuses in production without `deps.auth` (regression test).
- LAN box: register, `both`, sign in at `http://<ip>/entity/`.
