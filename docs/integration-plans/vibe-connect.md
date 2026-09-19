# Vibe Connect — SSO implementation plan

Repo `Vibe-Connect` · slug `vibe-connect` · Express 4 + **express-session (pg store)**, Knex · staff + client-portal + intake realms · **existing OIDC via openid-client** · Tauri desktop · **estimate 4 h, confidence 80%**.

Variant: **Express + server-side sessions**, replacing an existing OIDC route. Read `README.md`, `../INTEGRATION-PLAN.md` §1–§2, §4.11, and `COMPAT.md` D17.

> **Break-glass review, 2026-09-19.** Best case of the nine: username login accepts `vibe-breakglass` natively, no MFA, no self-service
> reset, no lockout. The risks are elsewhere: `validateIssuerUrl` rejects the Appliance's own `http://192.168.x.x` issuer
> (this plan already says it is the first thing that fails), and `setRole` demoting `is_admin` on a single-admin install
> needs the last-admin guard. Detail and anchors: `break-glass-and-rollout-risks.md`; the corrected recipe is
> `../INTEGRATION-PLAN.md` §2.B, I7, I8, I12.

## 0. Facts

| Item | Anchor |
|---|---|
| App | `apps/server/src/app.ts`: ACME `:55`, CORS `:83-119` (no CSRF tokens by design), raw-body bridges `:127-131`, session `:167-197` (`vibe.sid`, `SESSION_COOKIE_PATH`, `SESSION_SECURE`, `SESSION_SAMESITE` default lax, 12 h rolling), ping/health `:257/:261`, oidc router `:312`, mounts `:311-400` |
| Existing OIDC | `apps/server/src/routes/oidc.ts` (328 lines): `openid-client` v5, PKCE, state/nonce in session `:39-45`, enabled when 4 env keys set `:49-53`, **`validateIssuerUrl` SSRF guard rejects private/loopback issuers `:67-128`**, routes config/login/callback `:169-320`, email-only linking (no `sub` persisted), JIT `:322-328`, admin claim `:258-285` |
| Staff auth | `routes/auth.ts`: login `:49-93` (**username**, bcryptjs, `session.regenerate`), logout `:98`; `middleware/auth.ts` `requireAuth`/`requireAdmin` per route; `services/sessions.ts:17` `terminateSessionsForUser` |
| Users | migration `20260101000002_users_and_groups.js:5-20`: `username` unique, `email` nullable **non-unique**, `password_hash`, `is_admin`, `is_active`; `usersRepo.create()` `repositories/users.ts:46` |
| Client realm | `routes/portal.ts` (`vibe.portal` cookie, `client_sessions`, step-up) |
| Public routes | `/.well-known/acme-challenge/*`, `/ping`, `/health`, `/__vibe-boot.js`, `/auth/login|logout`, `/auth/oidc/*`, `/install/*`, `/portal/identify|verify|invite-accept`, `/api/public/intake/*` (+ tus uploads with upload-token bearer), `/bridges/*`, `/attachments/intake-headshots/*`, `POST /admin/backup-heartbeat` (token) |
| SPA | `apps/web/src/pages/Login.tsx:13-26,91-105` (SSO button via `oidcConfig()`), runtime base path via `/__vibe-boot.js` + `lib/boot.ts:44-58`; `apps/web/src/pages/Enrollment.tsx:49-53` (device passphrase copy) |
| Config | `src/env.ts`: `SITE_URL` :85, `PORTAL_URL` :86, `BASE_PATH` :96 (appliance `/connect`), `SESSION_COOKIE_PATH` :101, `ALLOWED_ORIGIN` :117, `SESSION_SECRET` :125, `SESSION_SECURE` :127 (must be set in prod), `SESSION_SAMESITE` :128, OIDC keys `:256-262` |
| Image | `infra/docker/Dockerfile` node:24-alpine, uid 10001, `/app/apps/server/dist`, node_modules at `/app/node_modules` (yarn), entrypoint runs knex migrations then `node dist/index.js` |
| Manifests | `.appliance/manifest.json` (path-prefix distribution, `basePathDefault: /connect`, `sessionCookiePathEnv`, ingress staff :443 / portal :8443); console `vibe-connect.json` (routing `vibe-connect-client:80`, websocket matcher, subdomains `connect`/`client`, emergency 5181/5182, only `OIDC_ISSUER_URL` as optional env) |
| CLI | none (yarn/knex scripts only) |
| Tests | vitest 1.6 + supertest, 52 files, real Postgres; one OIDC test (`new-endpoints.test.ts:571`) |

## 1. Decisions

1. **Replace `routes/oidc.ts` with the package**, keeping two things from it: the `validateIssuerUrl` SSRF guard as the validator behind the product's `PUT /auth/settings` wrapper **with a private-address allowance when the issuer host equals the appliance origin's host** (the guard as written blocks the in-appliance IdP; that is the first thing that would fail), and the audit event names mapped onto `auditRepo.write()`. Env mapping `OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI` → `VIBE_OIDC_*` with a one-release fallback (read the old names when the new are absent, log a deprecation).
2. **Path prefix.** Connect is path-mounted at `/connect` with a runtime base path and a cookie path. Engine `basePath: ""` (Caddy strips), React `basePath` from `window.__VIBE_BOOT__.basePath`; redirect URI from `VIBE_OIDC_PUBLIC_URL` (= `https://host/connect`). The session cookie path is `SESSION_COOKIE_PATH` (`/connect`); the callback is `/connect/auth/oidc/callback` in the browser, under that path, so the cookie is sent. Good as is.
3. **Users.** `username` is the key, `email` nullable and non-unique. Migration: unique partial index on `lower(email) WHERE email IS NOT NULL` after a duplicate audit. `findByEmail` uses it; `findByUsername` supports `vibe-breakglass` directly (real username column). JIT creates `username = slugifyUsername(email, sub)` (reuse `oidc.ts:322-328`) with a random bcrypt hash; store `sub` via the package's `auth_identities` (fixing the "email change re-provisions" problem).
4. **Roles.** Vocabulary `["admin","staff"]`, `adminRole: "admin"`; map `vibe-admin`/`vibe-it`/`vibe-partner` → `admin`, `vibe-manager`/`vibe-staff` → `staff`. `setRole` flips `is_admin` **both ways** (the old route only promoted). `setActive` → `is_active`.
5. **Session adapter.** `create` = `req.session.regenerate` + set `userId/isAdmin/username` exactly like `routes/auth.ts:77-82`; add `oidcIssuer/oidcSubject/oidcSid` to the session object (express-session JSON) and `destroyByIdentity` = query the `session` table's JSON for matches → `terminateSessionsForUser`. `currentUserId` = `req.session.userId`.
6. **D17 device keys.** Untouched: E2EE device enrolment keeps its own passphrase. Change the copy at `Enrollment.tsx:49-53` to stop suggesting the login password, and document the "two secrets" story in `docs/sso.md`.
7. **`SESSION_SAMESITE=lax`** default is required for the IdP round-trip; keep.
8. **Client portal and intake untouched** (I11).
9. **Tauri.** `apps/desktop` with `script-src 'self'` CSP: `loopbackLogin` + `issueToken` minting a session row and returning its cookie value as a bearer; add a bearer→session shim in `requireAuth`. H6.
10. **Break-glass:** add `apps/server/src/vibeAuthAdapter.ts` → `dist/vibeAuthAdapter.js`; command `["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` from `WORKDIR /app`; `breakglassService: vibe-connect-server` (confirm the overlay's server container name).
11. **Manifest env.** Remove the lone `OIDC_ISSUER_URL` optional entry from the console manifest; the `sso` block replaces it.

## 2. Steps

**A.** Dependency (`apps/server/package.json`, yarn 1: `.npmrc` still works for `npm.pkg.github.com`; add a BuildKit secret in `infra/docker/Dockerfile` around `yarn install`). Knex migration `20260917000001_vibe_auth.js`: package SQL + the email index. Remove `openid-client` once the old route is gone.

**B.** `apps/server/src/lib/vibeAuthUsers.ts` over `usersRepo`; audit → `auditRepo.write()` (`repositories/audit.ts:15`).

**C.** `apps/server/src/lib/vibeAuth.ts`: session adapter per §1.5; `secretWrap` via `services/kekSeal.ts` (HKDF(`SESSION_SECRET`) secretbox); `createPgStores` on a pg connection borrowed from Knex (`knex.client.acquireConnection()`), not `knex.raw`.

**D.** Replace `app.use('/auth/oidc', oidcRouter)` (`:312`) with `app.use(vibeAuthExpress(auth))` at the same position (after body parsers, bridges, install, portal/intake public routers); `guardLocalLogin(auth, req => req.body.username)` on `POST /auth/login` (`:49`); `afterLocalLogin`; `await auth.start()` in `index.ts` after migrations. Port the SSRF validator into the settings wrapper.

**E.** SPA: `Login.tsx` SSO button URL → `${basePath}/auth/oidc/start`, or wrap with `<LoginPanel basePath returnTo>`; `/login/local`; admin tab in `pages/Admin.tsx:14-31` + route `:88-110` for `<AuthSettingsPage basePath productName="Connect" fetch={fetch}>`; Enrollment copy per §1.6; sign-out → `/auth/oidc/logout?local=1` when SSO-born.

**F.** Manifests (both; keep existing routing and websocket matcher):
```jsonc
"requires": ["identity"],
"routing": { "default_upstream": "vibe-connect-client:80",
  "matchers": [ { "name": "websocket", "path": "/socket.io/*", "upstream": "vibe-connect-client:80", "streaming": true },
                { "name": "auth", "path": "/auth/*", "upstream": "vibe-connect-server:4000" } ] },
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/ping","/health","/__vibe-boot.js","/.well-known/acme-challenge/*","/auth/login","/auth/logout","/install/*","/portal/*","/api/public/intake/*","/bridges/*","/attachments/intake-headshots/*","/admin/backup-heartbeat"],
  "edgeGate": false, "internalUrl": "http://vibe-connect-server:4000",
  "breakglassService": "vibe-connect-server",
  "breakglassCommand": ["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
Check whether the client container's nginx already proxies `/auth/` to the server (its staff regex includes `auth`), in which case the matcher can target `vibe-connect-client:80`; the direct-to-server matcher is safer.

**G.** Tests: replace the single OIDC test; supertest: callback regenerates the session and sets `vibe.sid` under `SESSION_COOKIE_PATH`; demotion via `setRole`; SSRF validator allows the appliance origin host and still rejects metadata hosts; back-channel terminates sessions; `test/sso-e2e.mjs`.

**H.** `docs/sso.md` (D17 two-secrets, env migration); PR `(Phase 8 step 11)`.

## 3. Exit gate additions

- LAN box: register, `both`, sign in at `http://<ip>/connect/`; device enrolment still asks for the passphrase after SSO.
- Desktop loopback login on Windows (H6).
