# Vibe MyBooks — SSO implementation plan

Repo `myBooks` · slug `vibe-mybooks` · Express 4 + **stateless JWT** (HS256 access 15 min in localStorage, rotating refresh cookie `kb_refresh`) · staff + client-portal realms · also an OAuth **provider** · **estimate 4 h, confidence 80%** (multi-tenant users and a NOT NULL password hash are the two design points).

Variant: **Express + stateless JWT → Trial Balance pattern**. Read `README.md`, `../INTEGRATION-PLAN.md` §1–§2, §4.2.

> **Break-glass review, 2026-09-19.** zod `.email()` rejects `vibe-breakglass@localhost`. **Five failed attempts lock a non-super-admin
> permanently** (`auth.service.ts:435,450-457`); the break-glass account is `owner`, not `is_super_admin`, and an
> SSO-provisioned `owner` cannot unlock it either — create it so a lockout cannot be permanent. If 2FA is enabled with no
> method the fallback is email OTP, unusable for a `.local` address. JIT accounts are resettable from their mailbox.
> `defaultRoleMapFor` sends `vibe-manager` and `vibe-staff` to `readonly`: pass this plan's role map as an explicit `defaultRoleMap`. Verify the
> break-glass command against `packages/api/Dockerfile`, which is what CI publishes, not the root Dockerfile. Detail and anchors: `break-glass-and-rollout-risks.md`; the corrected recipe is
> `../INTEGRATION-PLAN.md` §2.B, I7, I8, I12.

## 0. Facts

| Item | Anchor |
|---|---|
| Staff auth routes (`/api/v1/auth`, mounted `app.ts:479`) | `packages/api/src/routes/auth.routes.ts`: login `:145`, tfa `:176-245`, refresh `:279`, logout `:296`, me `:330`, switch-tenant `:384`; passkeys `app.ts:520`, magic link `app.ts:544`, `GET /api/v1/auth/methods` `app.ts:617` |
| Token issue | `services/auth.service.ts:60-124` (`issueSession`), `inviteUser()` `:921` |
| Verify middleware | `packages/api/src/middleware/auth.ts` `authenticate()` `:113-134` (rejects `typ`/`tfa_pending`/`checks_stepup` `:118-128`); `authKind ∈ {session, api_key, download_token}` `:36-40`; API key `middleware/api-key-auth.ts:17` |
| Refresh cookie | `utils/refresh-cookie.ts:27,60-75` (`kb_refresh`, path `<prefix>/api/v1/auth`, `Secure` via `utils/cookie-secure.ts`) |
| Staff IP allowlist | `middleware/staff-ip-allowlist.ts`, mounted `app.ts:284` after webhooks |
| Users | `db/schema/auth.ts:26-71`: `tenant_id`, `email`, **`password_hash NOT NULL`** (`:30`), `role` (owner/accountant/bookkeeper/readonly), `user_type staff|client`, `is_active`, unique `(tenant_id, email)` |
| Permissions | `packages/shared/src/constants/permissions.ts`, `middleware/permission.ts:26-40`, firm capabilities `middleware/firm-capabilities.ts` |
| Public routes | `/health`, `/api/health`, `/api/v1/health`, `/ping*`, raw-body `/api/v1/stripe` `:201`, `/api/v1/plaid/webhooks` `:207`, `/api/sms/inbound` `:213`, `/api/v1/csp-report`, `/api/setup/*`, `/api/v1/public/*`, `/api/reports/public`, `/api/portal/*` family `:585-607`, `/api/w9`, `/api/bank-connect`, `/api/peer/pm` `:610`, `/mcp` `:613`, `/api/v2` `:640`, `/oauth/*` `:552`, `/api/v1/auth/methods`, `/api/v1/coa-templates/options` |
| SPA | `packages/web/src/features/auth/LoginPage.tsx` (`:171` methods, `:219` login), token store `api/client.ts:17-23,38,55` (`API_BASE`, `X-App-Base`), base-path sentinel `vite.config.ts:24` |
| Config | `config/env.ts`: `JWT_SECRET` :19, `CORS_ORIGIN`/`ALLOWED_ORIGIN` :43/:410, `PUBLIC_URL` :191, `COOKIE_PATH` :204, `COOKIE_SECURE` :225, `TRUST_PROXY` :169 |
| Image | root `Dockerfile` (`/app/node_modules`, `/app/packages/api/dist`, uid 1001, shell present); CI publishes `packages/api/Dockerfile` + `packages/web/Dockerfile` |
| Manifest | `.appliance/manifest.json` exists (`ports { api: 3001, web: 5173 }`, subdomain `mybooks` → `vibe-mybooks-web:5173`, `publicUrlEnvVar: PUBLIC_URL`, migrations `npx tsx packages/api/src/migrate.ts`); console `vibe-mybooks.json` |
| CLI | `scripts/reset-admin-password.ts`, `scripts/disable-2fa.ts`; bins in `packages/api/package.json:14-22` |
| Tests | vitest 3 colocated `*.routes.test.ts`, `middleware/auth.test.ts`, `auth.token-shape.test.ts`; Playwright `e2e/` |

## 1. Decisions

1. **Staff only; clients denied.** `findByEmail`/`findById` return null for `user_type !== 'staff'` (I11, Q13). Portal, preview cookie, peer tokens, API keys, download tokens, OAuth-provider tokens are all untouched.
2. **Tenant.** The appliance is single-tenant in practice. Resolve the tenant as: the tenant of the linked user; for JIT, the only tenant if exactly one exists, else the tenant named by `VIBE_OIDC_DEFAULT_TENANT` (new optional env, documented), else refuse with a clear audit event. `switch-tenant` keeps working for users who exist in several tenants; SSO links the identity to the first match by `(email)` across tenants and records `tenant_id` in `auth_identities` metadata.
3. **Password hash NOT NULL.** Do not relax the constraint in this PR (242 migrations, portal code paths assume it). JIT users get a random 32-byte bcrypt hash (unusable; `preferred_login_method` stays `password` so nothing else changes). `createLocalUser` (break-glass) uses `inviteUser()` semantics with a real password.
4. **Roles.** Vocabulary `["owner","accountant","bookkeeper","readonly"]`, `adminRole: "owner"`; map `vibe-admin`/`vibe-it`/`vibe-partner` → `owner`, `vibe-manager` → `accountant`, `vibe-staff` → `bookkeeper`. Firm capabilities and permission maps untouched (I8). H7 review before `oidc_only` is offered.
5. **Session adapter = TB pattern.** `create` calls `issueSession()` for the user (access + refresh; the refresh cookie is set with the same `X-App-Base`-derived path, so the callback handler must receive the SPA base: read `VIBE_OIDC_PUBLIC_URL`'s pathname as `COOKIE_PATH` fallback) and lands on `<return_to>#sso_token=<access>`. Access JWT gains `sid`; store `(sid, user_id, tenant_id, issuer, subject, idp_sid)` in `auth_sessions_oidc`. `destroyByIdentity` deletes the user's refresh rows (`sessions` table) and the oidc rows.
6. **Revocation on every request** (I6): in `authenticate()` after `jwt.verify` (`:113`) and before the `is_active` re-read: `if (await auth.isRevoked({ userId }, iat*1000)) 401`. Also in `POST /refresh` (`:279`).
7. **`authKind` stays `session`** for SSO-born tokens; only `session` may mint credentials or elevate firm capabilities, which is correct for SSO too.
8. **Mount order (I3):** after Stripe/Plaid/SMS raw-body routers (`:201-213`) and after `staffIpAllowlist` (`:284`) so the allowlist still applies to the browser callback (the IdP never calls the product except back-channel, which arrives from `vibe-auth-authentik-server` on `vibe_net` and must be allowlisted: add the container network CIDR or exempt `/auth/oidc/backchannel` in the allowlist middleware).
9. **Route prefix collision check:** the package uses `/auth/*`; MyBooks uses `/oauth/*` and `/api/v1/auth/*`. No collision. Add `/auth` to the SPA catch-all exclusion list at `app.ts:670-682` so `/auth/oidc/callback` is never served as `index.html` in the combined image.
10. **Two containers → `/auth/*` matcher**, `internalUrl: http://vibe-mybooks-api:3001`. Break-glass command from `WORKDIR /app`: `["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` (hoisted root node_modules); adapter `packages/api/dist/vibeAuthAdapter.js`.

## 2. Steps

**A.** Dependency in `packages/api/package.json`, `.npmrc`, BuildKit secret in `packages/api/Dockerfile` (and root `Dockerfile`). Migration `packages/api/src/db/migrations/0243_vibe_auth.sql` + `.rollback.sql`: package SQL + `auth_sessions_oidc` (with `tenant_id`).

**B.** `packages/api/src/lib/vibeAuthUsers.ts`: `create` via `inviteUser()` (`auth.service.ts:921`) with a random temp password then set `password_hash` to an unusable random hash; staff filter; audit → `auditLog()` (`middleware/audit.ts:7`).

**C.** `packages/api/src/lib/vibeAuth.ts` from TB's; `secretWrap` = `utils/encryption.ts` (`PLAID_ENCRYPTION_KEY` AES-GCM); stores on the pg pool.

**D.** Wiring per §1.8; `guardLocalLogin` on `POST /login` (`:145`), `tfa/verify` (`:176`), passkeys verify and magic-link verify; `afterLocalLogin` on each. `await auth.start()` in `bootstrap.ts`.

**E.** SPA: `LoginPage.tsx` `<LoginPanel basePath={APP_BASE.replace(/\/$/, "")} returnTo="/">`; `/login/local` route; fragment hand-off in `api/client.ts` (`setTokens`) copied from TB's `loginFlow.ts`; sign-out → `/auth/oidc/logout?local=1` when SSO-born. Settings tile in `features/settings/SettingsPage.tsx:171`, route in `App.tsx`, `fetch` prop adds the bearer.

**F.** Manifests (`.appliance/manifest.json` + console):
```jsonc
"requires": ["identity"],
"routing": { "default_upstream": "vibe-mybooks-web:5173",
  "matchers": [ { "name": "api", "path": "/api/*", "upstream": "vibe-mybooks-api:3001" },
                { "name": "oauth", "path": "/oauth/*", "upstream": "vibe-mybooks-api:3001" },
                { "name": "mcp", "path": "/mcp", "upstream": "vibe-mybooks-api:3001" },
                { "name": "auth", "path": "/auth/*", "upstream": "vibe-mybooks-api:3001" } ] },
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/health","/api/health","/api/v1/health","/ping","/api/ping","/api/v1/ping","/api/v1/stripe/*","/api/v1/plaid/webhooks/*","/api/sms/inbound",
                  "/api/v1/csp-report","/api/setup/*","/api/v1/public/*","/api/reports/public/*","/api/portal/*","/api/w9","/api/bank-connect","/api/peer/pm/*",
                  "/mcp","/api/v2/*","/oauth/*","/api/v1/auth/*","/api/v1/coa-templates/options"],
  "edgeGate": false, "internalUrl": "http://vibe-mybooks-api:3001",
  "breakglassService": "vibe-mybooks-api",
  "breakglassCommand": ["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
(Keep whatever matchers the console manifest already carries; the list above is the minimum for SSO.)

**G.** Tests: `test/sso-e2e.mjs`; vitest: `authenticate` revocation; client-type denial; tenant resolution (one tenant, several, none); token-shape test still rejects `tfa_pending`.

**H.** `docs/sso.md` with a paragraph that `/oauth/*` is MyBooks-as-provider and unrelated; PR `(Phase 8 step 2)`.

## 3. Exit gate additions

- `both`: password, passkey, magic-link and SSO all produce the same token shape; `switch-tenant` still works for an SSO-born token.
- `oidc_only`: `/register` (self-register first user) refused once an admin exists, as today.
- LAN box: `sudo vibe identity register vibe-mybooks`, sign in at `http://<ip>/mybooks/`.

## 4. Risks

- Tenant resolution is the design risk; keep it explicit and audited rather than clever.
- Refresh-cookie path derivation for the callback response; assert it in a test with `VIBE_OIDC_PUBLIC_URL=http://h/mybooks`.
