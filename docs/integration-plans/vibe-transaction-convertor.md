# Vibe Transaction Converter — SSO implementation plan

Repo `Vibe-Transaction-Convertor` · slug `vibe-tx-converter` · Express 4 + **server-side sessions** (`sessions` table, signed `vibetc_session` cookie, CSRF double-submit) · single image serves API + SPA · no Tauri · **estimate 2–3 h, confidence 85%**.

Variant: **Express + server-side sessions** (Sentinel/1099 pattern). Read `README.md` here and `../INTEGRATION-PLAN.md` §1–§2 first.

## 0. Facts the plan is built on (survey 2026-09-17)

| Item | Anchor |
|---|---|
| App wiring | `apps/api/src/server.ts:34-193`; `stripBasePath` mounted at `:44` (rewrites `req.url`, keeps `originalUrl`); CSP hand-built `:55-64` (`connect-src 'self'`); CORS single-origin `:77-83` (`WEB_BASE_URL`); `cookieParser(SESSION_SECRET)` `:86`; `loadSession` global `:102`; **global `csrf()` `:104`**; unauthenticated routers `:107-110`; guarded routers `:117-141`; SPA static `:163`; catch-all `app.get(/^(?!\/api\/).*$/)` `:177` |
| Auth routes | `apps/api/src/routes/auth.ts`: `/api/auth/csrf :38`, `/users-exist :40`, `/register :49`, `/login :70`, `/logout :92`, `/me :108`, `/change-password :119`; admin users `:138+` |
| Session service | `apps/api/src/services/auth.ts` (session id `:20`, argon2id `:11-12,64,109`, rolling expiry `:163-169`); table `sessions` `apps/api/src/db/schema.ts:195-201` |
| Cookie | `vibetc_session` (`middleware/auth.ts:23`), set at `routes/auth.ts:77-85`: httpOnly, `sameSite: 'lax'`, signed, `secure` from `lib/cookie-flags.ts:17-23` (`SESSION_SECURE`), `path: '/'` |
| CSRF | `middleware/csrf.ts` cookie `vibetc_csrf` (:7, not httpOnly :16), header `x-csrf-token`, exempt paths `:25-27` |
| Middleware | `middleware/auth.ts` `loadSession:31`, `requireAuth:61`, `requireAdmin:66`; `middleware/feature-access.ts` `requireFeature` (per-user denials `user_feature_access` `schema.ts:180-193`) |
| Users | `schema.ts:163-171` (`email`, `passwordHash`, `displayName`, `role`); enum `user_role ∈ {admin, staff}` `schema.ts:25`; no tenant scoping |
| Public routes | `/api/auth/csrf`, `/api/health/live`, `/api/health/ready`, `/api/version*`, `/api/auth/*`; `/api/internal/appliance/*` IP-gated (`server.ts:146`) |
| Base path | build-time sentinel `/__VIBE_BASE_PATH__/` (`apps/web/vite.config.ts:13`), `scripts/web-base-path.sh` at start; client `withBase()` `apps/web/src/lib/api.ts:13-14` |
| Image | `Dockerfile`: node:24-bookworm-slim runtime, pnpm, node_modules at `/app/node_modules` **and** `/app/apps/api/node_modules` (:55-63), `CMD ["node","apps/api/dist/index.js"]`, entrypoint drops to `node` |
| Migrations | Drizzle, `apps/api/src/db/migrations/` → `apps/api/dist/db/migrations` (`Dockerfile:73`), `node apps/api/dist/db/migrate.js` |
| Manifests | **no `.appliance/manifest.json`** (old-schema `vibe-app.yaml`, subdomain `tx`); console `vibe-tx-converter.json`: subdomain `vibetc`, `routing.default_upstream: vibe-tx-converter:4000`, env `WEB_BASE_URL`+`ALLOWED_ORIGIN` (subdomain-url), `SESSION_SECRET` from `shared:JWT_SECRET`, `SESSION_SECURE` from `install-mode-tls`, health `/api/health/live` |
| Tests | vitest + supertest; `apps/api/src/routes/auth.test.ts:23` uses `request.agent(app)` (session + CSRF cookies) |

## 1. Decisions specific to this product

1. **Roles.** Vocabulary `["admin","staff"]`, `adminRole: "admin"`. Map: `vibe-admin`, `vibe-it`, `vibe-partner` → `admin`; `vibe-manager`, `vibe-staff` → `staff`. `setRole` writes `users.role`. Per-user `user_feature_access` denials are never touched (I8); JIT users start with every feature allowed, which is the product's own default for new users.
2. **Session adapter = server-side.** `create` inserts a `sessions` row exactly as `POST /api/auth/login` does (`services/auth.ts` create + `routes/auth.ts:77-85` cookie, including the signed cookie and `cookieSecure()`), and also issues the CSRF cookie the SPA expects (`middleware/csrf.ts`), because the SPA will make POSTs right after landing. Add three nullable columns to `sessions`: `oidc_issuer`, `oidc_subject`, `oidc_sid`. `destroyByIdentity` deletes by `oidc_sid`, then `(issuer, subject)`, then `user_id`. `currentUserId`/`currentIdentity` read `req.session` populated by `loadSession`.
3. **No JWT, no revocation list needed** beyond what the package writes; `isRevoked` is not wired into `loadSession` (I6 applies to JWT products only).
4. **Mount order (I3).** `app.use(vibeAuthExpress(auth))` must go **before the global `csrf()` at `server.ts:104`** or the back-channel `POST /auth/oidc/backchannel` (a form post from authentik with no CSRF cookie) 403s. It must also go **before the SPA catch-all at `:177`**, otherwise `/auth/oidc/callback` returns `index.html`. Since `loadSession` (`:102`) is harmless for `/auth/*`, mount right after it and before `csrf()`. Alternative if you prefer not to reorder: add `/auth/` to `exemptPaths` (`csrf.ts:25`); the plan prefers mount-before because it keeps CSRF semantics untouched.
5. **`stripBasePath` (`server.ts:44`) is your friend.** It strips `VITE_BASE_PATH` before routing, so the engine still runs with `basePath: ""`. Redirect URIs come from `VIBE_OIDC_PUBLIC_URL`, never from `req.url` (README lesson 4).
6. **CSP.** `connect-src 'self'` is fine: the browser never fetches the IdP; it is redirected. Add `form-action 'self' <issuer origin>` only if the product ever posts to the IdP, which the package's flow does not. Leave CSP alone; note it in `docs/sso.md`.
7. **CORS.** Same-origin only; nothing to change.
8. **`ALLOWED_ORIGIN` is declared by the console manifest but never read by the API.** The appliance's identity script derives the product's public base from `ALLOWED_ORIGIN` + `VITE_BASE_PATH` in the product env (`lib/identity.sh` `_id_product_base_url`), so keep the manifest entry; it exists for that reason now.
9. **Break-glass** in a normal node image: `breakglassCommand: ["node","apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` from `WORKDIR /app`; adapter compiled to `apps/api/dist/vibeAuthAdapter.js`. Verify the per-package symlink path resolves (`Dockerfile:55-63` explains why both node_modules dirs exist).
10. **Subdomain mismatch** (`tx` in `vibe-app.yaml`, `vibetc` in the console manifest): the console manifest wins on the appliance. Create `.appliance/manifest.json` from it in this PR and delete or mark `vibe-app.yaml` as legacy.

## 2. Steps

**A. Dependency + tables**: `apps/api/package.json` `"@kisaesdevlab/vibe-auth": "^1.0.3"`, root `.npmrc` registry line, `Dockerfile` BuildKit secret around the `pnpm install` (copy `trial-balance-app/Dockerfile.server:9-17`, adapt to pnpm). Drizzle migration: package SQL verbatim (`sql/auth_identities.sql`) or `import { authIdentities, authSettings, authRevocations } from "@kisaesdevlab/vibe-auth/sql/drizzle"` into `schema.ts`, plus the three `sessions` columns.

**B. User adapter** `apps/api/src/lib/vibeAuthUsers.ts`: Drizzle over `users`; `findByUsername` maps `vibe-breakglass` → `vibe-breakglass@vibe-tx-converter.local` (a dotted domain per the corrected recipe, `../INTEGRATION-PLAN.md` §2.B; this product only checks that the login identifier is a string, `apps/api/src/routes/auth.ts:72-74`, so either form signs in, but map the address back to the username for the engine hooks — see `break-glass-and-rollout-risks.md`); `create` uses the argon2id hash from `services/auth.ts:11-12` with a random 32-byte password; `setActive` needs a `disabled_at` column (add in the migration; honour in `loadSession`). Audit: the survey found no audit writer; add `vibe_auth_audit(id, at, type, actor, payload jsonb)` in the migration and write there.

**C. Engine** `apps/api/src/lib/vibeAuth.ts`: `createPgStores({ query })` on the pg pool Drizzle wraps; `secretWrap` via HKDF(`SESSION_SECRET`) → AES-GCM (20 lines, copy Sentinel's) since the product has no key-wrap; `basePath: ""`, `loginPath: "/login"`, `breakglassLoginPath: "/login/local"`, `trustProxy: true`, `syncRoles: true`.

**D. Wiring** per §1.4; `guardLocalLogin(auth, req => req.body.email)` on `POST /api/auth/login` (`routes/auth.ts:70`) keeping the `loginRateLimit` in front; `auth.afterLocalLogin` after success; `POST /api/auth/register` (first-admin bootstrap) is refused in `oidc_only` the same way. `await auth.start()` in `apps/api/src/index.ts`.

**E. SPA** `apps/web/src/pages/LoginPage.tsx`: `<LoginPanel basePath={APP_BASE} returnTo="/">`; keep the `users-exist` → `/register` redirect (`:33`) but only in `local`/`both`. Route `/login/local` with `breakglass`. Cookie sessions mean no fragment hand-off: after the callback the browser lands on `returnTo` already signed in, and `GET /api/auth/me` (`:108`) works. Sign-out: `POST /api/auth/logout` then `GET ${APP_BASE}auth/oidc/logout?local=1` when the session was SSO-born (expose that on `/me`). Settings: `<AuthSettingsPage basePath={APP_BASE} productName="Transaction Converter" fetch={fetchWithCsrf}>` behind `requireAdmin`; nav entry next to the users admin page.

**F. CLI + manifests**: `apps/api/src/vibeAuthAdapter.ts`; `"vibeAuth": { "adapter": "./dist/vibeAuthAdapter.js" }` in `apps/api/package.json`. New `.appliance/manifest.json` = console manifest + :
```jsonc
"requires": ["identity"],
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/api/health/*","/api/version","/api/version/*","/api/auth/csrf","/api/auth/users-exist","/api/auth/login","/api/internal/appliance/*"],
  "edgeGate": false, "internalUrl": "http://vibe-tx-converter:4000",
  "breakglassService": "vibe-tx-converter",
  "breakglassCommand": ["node","apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
No `/auth/*` matcher needed: one container serves everything. Vendor the same into `Vibe-Appliance/console/manifests/vibe-tx-converter.json`; run `npm test` in `Vibe-Appliance/console`.

**G. Tests**: `test/sso-e2e.mjs` + fake IdP (TB copies); supertest cases using `request.agent(app)`: callback sets both cookies; back-channel POST without CSRF is accepted; `oidc_only` refuses `/register` and `/login` except break-glass; a JIT user has `role` from the map and no `user_feature_access` rows.

**H. Docs + PR**: `docs/sso.md`; PR `feat: single sign-on via @kisaesdevlab/vibe-auth (Phase 8 step 14)`.

## 3. Exit gate additions

- Existing `auth.test.ts`, `server.modes.test.ts`, `middleware/base-path.test.ts` stay green (base-path handling is the thing most likely to break).
- LAN box: `sudo vibe identity register vibe-tx-converter`, mode `both`, sign in at `http://<ip>/vibetc/` (console-manifest prefix), then `oidc_only` + `/vibetc/login/local` with break-glass.

## 4. Risks

- Reordering middleware around the global CSRF guard; the supertest agent tests exist precisely to catch a regression.
- Two `node_modules` locations in the image; the break-glass path must be checked in the built image, not the source tree.
