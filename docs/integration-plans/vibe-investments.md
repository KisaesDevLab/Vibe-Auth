# Vibe Investments — SSO implementation plan

Repo `Vibe-Investments` · slug `vibe-investments` (to be created) · Express 4 + **Postgres sessions** (`vibe_session`, `SameSite=Strict`, TOTP optional) · multi-role, per-client-scoped RBAC · **not an appliance app yet** · **estimate 3–4 h, confidence 75%**.

Variant: **Express + server-side sessions**. Read `README.md`, `../INTEGRATION-PLAN.md` §1–§2, §4.7. Half of this plan is appliance onboarding that SSO merely forces.

> **Break-glass review, 2026-09-19.** `z.string().email()` at `routes/auth.ts:34` rejects `vibe-breakglass@localhost`.
> `checkBruteForce` is awaited unguarded on the login path, so **a Redis outage takes break-glass down**: guard it for the
> break-glass identifier. One seeded admin and no reset route means a role-sync demotion is recoverable only by SQL.
> **`defaultRoleMapFor` sends `vibe-manager` and `vibe-staff` to `READ_ONLY`** (the vocabulary is uppercase): this plan's role
> map must be passed as `defaultRoleMap`, not left to the default. Detail and anchors: `break-glass-and-rollout-risks.md`; the corrected recipe is
> `../INTEGRATION-PLAN.md` §2.B, I7, I8, I12.

## 0. Facts

| Item | Anchor |
|---|---|
| App | `apps/api/src/index.ts`: cors `:43-48` (`CORS_ORIGIN`, single string), health `:74,77`, auth router `:79`, `bootstrapAdminFromEnv` `:93`; `/api/v1/*` routers each apply `requireAuth`+`requirePermission` |
| Auth routes | `apps/api/src/routes/auth.ts`: login `:58` (TOTP gate `:113-126`), logout `:147`, totp setup/verify `:163/:179`, password change `:224` |
| Sessions | `apps/api/src/auth/sessions.ts`: `create`/`revokeAllSessionsForUser` `:182`; cookie `vibe_session` `:14`, options `:194-208` (**`secure: NODE_ENV==='production'`**, `sameSite: 'strict'`), 8 h idle / 12 h abs |
| Middleware | `apps/api/src/auth/middleware.ts` (`createRequireAuth`, `requirePermission`; scope collapse `:68`) |
| Users / roles | `packages/db/src/schema/auth.ts:24-44` (`app_user`: `firmId`, `email` unique, `passwordHash`, `totpSecret`, `isActive`); `user_role` `:47-64` PK `(userId, role, scopeClientId)`; roles `ADMIN|MANAGER|REVIEWER|PREPARER|READ_ONLY`, capability matrix `packages/shared/src/auth-types.ts:4-27` |
| Public routes | `/health`, `/api/health`, `/api/v1/auth/login`, `/api/v1/auth/logout` |
| SPA | `apps/web/src/auth/LoginScreen.tsx:18`, `useSession.ts`, `ProtectedRoute.tsx`; relative fetches (`api-client.ts:16-22`); **no `base`**; Caddy web container on :3000 |
| Config | `CORS_ORIGIN`, `MASTER_SECRET`, `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD`, `CADDYFILE` selector; **no session secret, no cookie-secure env** |
| Image | `apps/api/Dockerfile` node:20-alpine, node_modules `/repo/node_modules`, workdir `/repo/apps/api`, CMD `node dist/index.js` :4000; web `caddy:2-alpine` :3000 |
| Migrations | drizzle-kit `db:migrate` by hand; no migrate-on-boot, no migrate service |
| Manifest | **none anywhere** (neither in repo nor in `Vibe-Appliance/console/manifests`) |
| CLI | none (`auth/bootstrap.ts` runs at boot) |
| Tests | vitest unit only; Playwright root; supertest present but no API tests |

## 1. Decisions

1. **Appliance onboarding first (prerequisite, same PR or a preceding one).**
   - `.appliance/manifest.json` + `Vibe-Appliance/console/manifests/vibe-investments.json`: `slug vibe-investments`, images from the compose file, `ports { server: 4000, client: 3000 }`, `routing.default_upstream: vibe-investments-client:3000` + matchers `/api/*` and `/auth/*` → `vibe-investments-server:4000`, `database`, `redis`, `health: /api/health`, `migrations.command: ["node","/repo/node_modules/.bin/drizzle-kit","migrate"]` or a small `dist/migrate.js` (add one; drizzle-kit in a prod image is heavy).
   - **`rootServedOnly: true`** until the SPA gets a base-path sentinel (`vite.config.ts` has no `base`). Recommend adding the sentinel pattern from Calculators in this PR; if not, root-served is acceptable and LAN access is the emergency port.
   - Env: `SESSION_SECURE` (new, rendered from `install-mode-tls`) replacing the `NODE_ENV` derivation at `sessions.ts:194-208`; `ALLOWED_ORIGIN` consumed by `CORS_ORIGIN` (alias) so the appliance origin is allowed; `app.set('trust proxy', 1)`.
2. **Roles.** Vocabulary (most privileged first) `["ADMIN","MANAGER","REVIEWER","PREPARER","READ_ONLY"]`, `adminRole: "ADMIN"`; map `vibe-admin`/`vibe-it`/`vibe-partner` → `ADMIN`, `vibe-manager` → `MANAGER`, `vibe-staff` → `PREPARER`. `setRole` replaces the user's **unscoped** `user_role` row (`scopeClientId IS NULL`) and never touches client-scoped rows (I8). Multi-role users keep their extra rows; the package only manages the unscoped one. Document.
3. **Add `GET /api/v1/auth/me`** (the SPA fakes it in `useSession.ts:17-50`): returns user, roles, `ssoBorn`.
4. **Session adapter.** `create` = `sessions.create` + the cookie exactly as `/login` sets it; `sessions` table gains `oidc_issuer/subject/sid`; `destroyByIdentity` = `revokeAllSessionsForUser` for matching rows. TOTP is skipped for SSO sessions (IdP MFA; `VIBE_OIDC_REQUIRE_MFA_AMR=true`).
5. **`SameSite=Strict` stays** (same-site IdP on the appliance).
6. **JIT is the only creation path** (no user-create route). `create` inserts `app_user` with an unusable bcrypt hash and the mapped unscoped role, `firmId` = the sole firm.
7. **Break-glass**: no bin exists; add `apps/api/src/vibeAuthAdapter.ts` → `dist/vibeAuthAdapter.js`; command `["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` from `WORKDIR /repo/apps/api` (node_modules are hoisted at `/repo/node_modules`, so verify the resolution; if it fails use `["node","/repo/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js", …]`).
8. **Redis** is already a hard dependency (brute-force counters); the appliance provides it.

## 2. Steps

**A.** Dependency, `.npmrc`, BuildKit secret in `apps/api/Dockerfile` (pnpm). Drizzle migration in `packages/db/migrations`: package SQL + `auth_session` OIDC columns. Add `dist/migrate.js` (programmatic drizzle migrator) so the appliance can run migrations.

**B.** `apps/api/src/lib/vibeAuthUsers.ts`; audit → `writeEvent()` (`apps/api/src/auth/audit.ts:20`).

**C.** `apps/api/src/lib/vibeAuth.ts`; `secretWrap` via `packages/db/src/encryption.ts` (`MASTER_SECRET` PBKDF2→AES-GCM); stores on the pg pool.

**D.** Mount `vibeAuthExpress(auth)` in `index.ts` after health and before the `/api/v1/*` routers (`:79-83`); `guardLocalLogin` on `POST /api/v1/auth/login` (`:58`); `afterLocalLogin`; `await auth.start()` before listen. `SESSION_SECURE` + `trust proxy` per §1.1.

**E.** SPA: `LoginScreen.tsx` `<LoginPanel basePath="" returnTo="/">`; `/login/local`; replace the fake `useSession` with `/api/v1/auth/me`; new `/auth-settings` route (`App.tsx:~25`) + link in `AppShell.tsx:~74`; sign-out via `/auth/oidc/logout?local=1`.

**F.** Manifests per §1.1 plus:
```jsonc
"requires": ["identity"],
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/health","/api/health","/api/v1/auth/login","/api/v1/auth/logout"],
  "edgeGate": false, "internalUrl": "http://vibe-investments-server:4000",
  "breakglassService": "vibe-investments-server",
  "breakglassCommand": ["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
Appliance overlay `apps/vibe-investments.yml` and env template are new files; run `Vibe-Appliance` `npm test` (manifests, overlay closure).

**G.** Tests: first supertest API tests (login, `/me`, callback, back-channel); `test/sso-e2e.mjs`; unit test for `setRole` leaving scoped rows alone.

**H.** `docs/sso.md`; PR `(Phase 8 step 7)`, flagged "first appliance integration of this product".

## 3. Exit gate additions

- `sudo vibe enable vibe-investments` on the LAN box works end to end before any SSO test (new app).
- Then register, `both`, sign in at the emergency port (root-served) or `/investments/` if the base-path work is done.
