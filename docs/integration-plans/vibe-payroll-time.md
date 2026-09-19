# Vibe Payroll & Time — SSO implementation plan

Repo `Vibe-Payroll-Time` · slug `vibe-payroll` · Express 4 + **stateless JWT** (access 15 min, rotating refresh rows, both in localStorage) · two containers (API `vibe-payroll-api:4000`, SPA on nginx `vibe-payroll-web:8080`) · no Tauri · **estimate 4–5 h, confidence 75%** (the lowest of the Express products: thin tests, kiosk realm, stale manifests).

Variant: **Express + stateless JWT → Trial Balance pattern** (`sid` claim, `#sso_token` hand-off, revocation check on every request). Read `README.md` here and `../INTEGRATION-PLAN.md` §1–§2 first.

> **Break-glass review, 2026-09-19.** zod `.email()` rejects the `vibe-breakglass@localhost` this plan hard-coded; it is corrected
> below. **`defaultRoleMapFor` would promote every `vibe-partner` to `super_admin`** and send `vibe-manager` to `employee`: the
> role map this plan prescribes must be passed as `defaultRoleMap`. Two mailbox-only paths (`magic/request`, `password-reset/request`) let a
> JIT account bootstrap local credentials. The schema claims in step B were wrong and are corrected below; `password_hash` is
> `varchar(72)`, which holds bcrypt and **not** argon2id. Detail and anchors: `break-glass-and-rollout-risks.md`; the corrected recipe is
> `../INTEGRATION-PLAN.md` §2.B, I7, I8, I12.

## 0. Facts the plan is built on (survey 2026-09-17)

| Item | Anchor |
|---|---|
| App wiring | `backend/src/http/app.ts:30-86` (helmet, cors `credentials:true` with `parseAllowedOrigins` :41-46, CSP disabled :38) |
| Login / refresh / logout / me | `backend/src/http/routes/auth.ts:42, :53, :97, :200`; magic link `:125-186`; password reset `:166` |
| Tokens | `backend/src/services/tokens.ts:41-51` (HS256, `JWT_SECRET`), refresh rotation `:73-139`, table `refresh_tokens` |
| Client token store | `frontend/src/lib/auth-store.ts:13,34` (localStorage key `vibept.session`), API base `frontend/src/lib/api.ts:14` (`${BASE_URL}api/v1`) |
| Auth middleware | `backend/src/http/middleware/auth.ts` `requireAuth:31`, `requireSuperAdmin:50`, `requireCompanyRole:64` (DB-checked memberships) |
| Kiosk realm (must stay non-SSO) | `backend/src/http/middleware/kiosk-auth.ts:34`, routes `backend/src/http/routes/kiosk.ts:48-219` |
| Users | migration `backend/migrations/20260420000002_users.js` (`email`, `password_hash`, `role_global ∈ {super_admin,none}`) |
| Roles / tenancy | `company_memberships` (`20260420000004_company_memberships.js:18-20`, `company_admin|supervisor|employee`); `TENANT_MODE` `backend/src/config/env.ts:120` (`single` on the appliance) |
| Public routes | `/api/v1/ping`, `/health`, `/health/ready`, `/version`, `/appliance/info`, `/setup/status`, `/setup/initial`, `/auth/*` (login, refresh, magic/*, password-reset/request), `/kiosk/pair`; device-token routes `/kiosk/me|verify-pin|scan|punch/*` |
| Config | `env.ts`: `ALLOWED_ORIGIN` :70 (alias `CORS_ORIGIN` :48), `PUBLIC_URL` :77, `JWT_SECRET` :153, `COOKIE_SECURE`/`COOKIE_PATH` :140-146 (unused by the JWT flow) |
| Image | `backend/Dockerfile`: node:20-alpine, **tsx at runtime, no `dist/`**, `CMD ["node","--import","tsx/esm","--enable-source-maps","backend/src/server.ts"]` (:70), root-hoisted `/app/node_modules`, uid 2000 |
| Migrations | Knex, `backend/migrations/*.js`, runner `backend/src/db/migrate.ts` |
| Manifests | in-tree `.appliance/manifest.json` is **stale** (ports 3000/80, `node dist/migrate.js`); console `vibe-payroll.json` is current: `routing.default_upstream: vibe-payroll-web:8080`, matcher `/api/*` → `vibe-payroll-api:4000`, health `/api/v1/health` |
| Tests | vitest, only `backend/src/__tests__/health.test.ts` and `routes/__tests__/ping.test.ts`; no auth helper |

## 1. Decisions specific to this product

1. **Staff realm only.** SSO covers `users` with `company_memberships`. The kiosk realm (device token + PIN) is untouched; the engine is mounted so `/api/v1/kiosk/*` never passes through it (I3, I11).
2. **Roles.** The product has two layers: `role_global` (`super_admin|none`) and per-company `company_admin|supervisor|employee`. On the appliance `TENANT_MODE=single`, so there is exactly one company. Vocabulary handed to the package: `["super_admin","company_admin","supervisor","employee"]`, `adminRole: "super_admin"`. Map: `vibe-admin`, `vibe-it` → `super_admin`; `vibe-partner` → `company_admin`; `vibe-manager` → `supervisor`; `vibe-staff` → `employee`. `UserAdapter.setRole` writes `role_global` for `super_admin` and otherwise upserts the single company's membership row with that role and resets `role_global` to `none`. Document that `TENANT_MODE=multi` installs must set `VIBE_OIDC_DEFAULT_ROLE` and assign companies by hand (out of scope).
3. **Session adapter = TB pattern.** `create` mints the same access + refresh pair `POST /auth/login` mints (`tokens.ts:41-51, :73-139`), adds a `sid` claim to the access token, stores `(sid, user_id, issuer, subject, idp_sid)` in a new `auth_sessions_oidc` table, and lands the SPA on `<return_to>#sso_token=<access>&sso_refresh=<refresh>`. The refresh token must travel too, because the SPA's store expects both (`auth-store.ts:13`); put it in the fragment as well, never in a query string.
4. **Revocation on every request** (I6): in `requireAuth` (`middleware/auth.ts:31`), right after JWT verify, `await auth.isRevoked({ userId }, iat * 1000)` and 401 when true. Also reject refresh for a revoked user in `tokens.ts:73-139` so a revoked session cannot rotate back in.
5. **`destroyByIdentity`**: delete the user's `refresh_tokens` rows and the `auth_sessions_oidc` rows, then revoke (the package does the revoke; the adapter deletes rows).
6. **Two containers → `/auth/*` matcher is mandatory** (I12, README lesson 4). `internalUrl: http://vibe-payroll-api:4000`.
7. **CORS.** `parseAllowedOrigins` already accepts the appliance origin; the IdP is never called cross-origin from the browser (redirects only), so no change.
8. **Break-glass in a tsx-only image**: `breakglassCommand: ["node","--import","tsx/esm","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` with `WORKDIR /app` and the adapter pointed at `backend/src/vibeAuthAdapter.ts` (tsx loads TS). Verify inside the image before committing (README lesson 7).

## 2. Steps

**A. Dependency + tables**
- `backend/package.json`: `"@kisaesdevlab/vibe-auth": "^1.0.3"`; `backend/.npmrc` with `@kisaesdevlab:registry=https://npm.pkg.github.com`; `backend/Dockerfile` gets the BuildKit-secret `npm ci` from `trial-balance-app/Dockerfile.server:9-17` (the workspace `npm ci` at lines 20-24 is where the token is needed). `.github` publish workflow passes `NODE_AUTH_TOKEN`.
- Migration `backend/migrations/2026MMDD000000_vibe_auth.js`: execute the package's `sql/auth_identities.sql` verbatim (copy TB's migration) and create `auth_sessions_oidc(sid text pk, user_id uuid, issuer text, subject text, idp_sid text, id_token text, created_at timestamptz)` with an index on `(user_id)` and `(issuer, subject)`.

**B. User adapter** `backend/src/lib/vibeAuthUsers.ts` (copy `trial-balance-app/server/src/lib/vibeAuthUsers.ts`, swap to Knex + **bigint ids** + email — `users.id` is `bigIncrements`, not uuid, `20260420000002_users.js:10`). `findByUsername` maps `vibe-breakglass` → `vibe-breakglass@vibe-payroll.local` (**not `@localhost`**, which `shared/src/schemas/auth.ts:30` rejects; also admit the literal username in that schema). `create` (JIT): insert `users` with an unusable **bcrypt** hash (`password_hash` is `varchar(72)`; an argon2id string does not fit), `role_global` per the map, and the single company membership. `setActive`: **`disabled_at timestamptz` already exists** with a partial index (`20260420000002_users.js:23,26`); use it, add no column, and confirm `requireAuth` honours it. Audit sink → the product's audit writer if one exists, else a `vibe_auth_audit` table (the survey found none; check `backend/src/services` for an audit module before inventing one).

**C. Session adapter + engine** `backend/src/lib/vibeAuth.ts` (copy TB's; the `vibeAuthMiddleware()` that rewrites the callback 302 to the fragment hand-off is the part to keep verbatim). `createPgStores({ query })` with a pg `Pool.query` (Knex: `knex.client.acquireConnection()` → `conn.query`, as TB does; `knex.raw` does not return rows in the shape the stores expect). `secretWrap` = the product's key-wrap; the survey found none, so use `ENCRYPTION_KEY`-style AES-GCM from `packages/shared` if present, otherwise add a 20-line `lib/secretWrap.ts` keyed from `JWT_SECRET` via HKDF (document in `docs/sso.md`). `basePath: ""`, `loginPath: "/login"`, `breakglassLoginPath: "/login/local"`, `trustProxy: true`, `syncRoles: true`.

**D. Wiring** in `backend/src/http/app.ts`: after body parsers and after the `/api/v1/kiosk` router, before any `requireAuth`-guarded router: `app.use(vibeAuthExpress(auth))`. `guardLocalLogin(auth, req => req.body.email)` on `POST /api/v1/auth/login` (`routes/auth.ts:42`) and on `magic/consume` (`:186`); both call `auth.afterLocalLogin(user)` on success. Revocation check per §1.4. `await auth.start()` in `backend/src/server.ts` before `listen` (I4). The worker (`worker.ts`) does not mount the engine.

**E. SPA** `frontend/src/pages/LoginPage.tsx`: wrap the form in `<LoginPanel basePath={import.meta.env.BASE_URL.replace(/\/$/, "")} returnTo="/">`; add route `/login/local` with `breakglass`. New `frontend/src/lib/ssoHandoff.ts` (copy `trial-balance-app/client/src/utils/loginFlow.ts`): on any route, read `#sso_token=…&sso_refresh=…`, write `vibept.session` via `auth-store.ts`, `history.replaceState` to drop the fragment. Sign-out: when the stored session is SSO-born, call `GET ${BASE_URL}auth/oidc/logout?local=1` then clear the store. Settings: `<AuthSettingsPage basePath productName="Payroll & Time" fetch={apiFetchWithBearer}>` behind `requireSuperAdmin` on the API and the super-admin nav on the SPA.

**F. CLI + manifests**
- `backend/src/vibeAuthAdapter.ts` default-exporting `{ users, audit, adminRole: "super_admin", breakglassEmail: "vibe-breakglass@vibe-payroll.local", close }`; `"vibeAuth": { "adapter": "./backend/src/vibeAuthAdapter.ts" }` in `backend/package.json`.
- **Rewrite** `.appliance/manifest.json` from `Vibe-Appliance/console/manifests/vibe-payroll.json` (ports 4000/8080, tsx migrate command), then add to both:
  ```jsonc
  "requires": ["identity"],
  "routing": { "default_upstream": "vibe-payroll-web:8080",
    "matchers": [ { "name": "api", "path": "/api/*", "upstream": "vibe-payroll-api:4000" },
                  { "name": "auth", "path": "/auth/*", "upstream": "vibe-payroll-api:4000" } ] },
  "sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
    "publicPaths": ["/api/v1/ping","/api/v1/health","/api/v1/health/ready","/api/v1/version","/api/v1/appliance/info",
                    "/api/v1/setup/*","/api/v1/auth/*","/api/v1/kiosk/*"],
    "edgeGate": false, "internalUrl": "http://vibe-payroll-api:4000",
    "breakglassService": "vibe-payroll-api",
    "breakglassCommand": ["node","--import","tsx/esm","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
  ```
  Appliance env template `env-templates/per-app/vibe-payroll.env.tmpl`: nothing new (mode and OIDC block are written at registration). Run `npm test` in `Vibe-Appliance/console` (manifest validation).

**G. Tests** (I13): `backend/test/sso-e2e.mjs` from `trial-balance-app/test/sso-e2e.mjs` + `test/fake-idp.mjs`; cases per §2.I of the plan, plus two product-specific ones: a kiosk device-token call succeeds in `oidc_only` (realm untouched), and a JIT user gets one `company_memberships` row with the mapped role. A vitest for `requireAuth` revocation. Keep `health`/`ping` tests green.

**H. Docs + PR**: `docs/sso.md` (copy TB's, adjust env names: this product reads `PUBLIC_URL`, `ALLOWED_ORIGIN`); PR titled `feat: single sign-on via @kisaesdevlab/vibe-auth (Phase 8 step 13)`.

## 3. Exit gate additions

- `both`: password login, magic-link login and SSO login all mint the same token shape; the SPA cannot tell them apart except by the `sid` claim.
- `oidc_only`: `POST /api/v1/auth/login` refused for everyone but `vibe-breakglass`; `magic/request` refused too (it is a local credential).
- Kiosk pairing and punches keep working in every mode.
- LAN box: `sudo vibe identity register vibe-payroll`, then the console's mode switch to `both`, then a sign-in from a browser at `http://<ip>/payroll/`.

## 4. Risks

- Thin test suite: budget an extra hour for the auth test scaffold.
- The stale in-tree manifest is a landmine for anyone deploying from the repo instead of the appliance; fix it in this PR even though it is not SSO work.
- `otplib` is a dependency with no usages; do not build MFA into this PR, the IdP's MFA covers SSO sessions (set `VIBE_OIDC_REQUIRE_MFA_AMR=true` in the env template).
