# Product integration checklist (Phase 8)

One PR per product. Trial Balance is the reference implementation (`trial-balance-app`, see `docs/sso.md` there). Every step below has a concrete anchor in COMPAT.md §B.

## 1. Dependency and tables
- [ ] Add `@kisaes/vibe-auth` (GitHub Packages, `.npmrc` scope `@kisaes`). CJS products (Trial Balance) use `require`; ESM products import.
- [ ] Migration that runs `sql/auth_identities.sql` (or imports `@kisaes/vibe-auth/sql/drizzle` into the Drizzle schema). Tables: `auth_identities`, `auth_settings`, `auth_revocations`.
- [ ] If the user table lacks a disabled flag (Entity) add one; if it lacks a verified-email marker, JIT users are created with the IdP's `email_verified=true` and no column is needed.

## 2. Adapters (`src/lib/vibeAuth.ts` or equivalent)
- [ ] `UserAdapter` over the product's user table (`findById/findByEmail/findByUsername/create/setRole/createLocalUser/setLocalPassword/setActive`). `createLocalUser` hashes with the product's own algorithm.
- [ ] `SessionAdapter`:
  - server-side sessions (T&B, Recap, 1040, 1099, Entity, Investments, Calculators, Connect): `create` inserts the row + sets the cookie; `destroyByIdentity` deletes by `oidc_sid` / `(issuer, subject)` / `user_id`.
  - stateless JWT (Trial Balance, MyBooks access token, Tax Research Chat, Sentinel): `create` mints the product JWT and hands it to the SPA (TB pattern: `#sso_token=` fragment); wire `vibeAuth.isRevoked({ userId }, iat)` into the verify middleware (D16); store `(sid → user)` in a small table so back-channel logout can revoke.
- [ ] `identities` / `settings` / `revocations` from `createPgStores({ query })` (works with pg, postgres.js, knex.raw, drizzle execute).
- [ ] `secretWrap` from the product's key-wrap (COMPAT.md §B "Key-wrap" column) — D24.
- [ ] `audit` sink → the product's audit writer (§B "Audit writer" column). Event names are the §5 schema.
- [ ] `product.roles`: `{ roles: [...most privileged first], adminRole }`. Default map (D22): `vibe-admin/vibe-it → admin`, `vibe-partner → partner|owner|admin`, `vibe-manager → manager|reviewer`, `vibe-staff → staff|preparer|user`. Layered-permission products (T&B, Investments, Calculators, MyBooks) map to role slugs only; per-user overrides are untouched.

## 3. Routes
- [ ] **Path prefixes in the Appliance.** Caddy mounts the product at `/<prefix>/` and *strips the prefix* before proxying, so the server sees `/auth/...` — create the engine with `basePath: ""`. The SPA lives under `/<prefix>/`, so React components get `basePath: import.meta.env.BASE_URL.replace(/\/$/, "")`. The public redirect URI is built from `VIBE_OIDC_PUBLIC_URL` (includes the prefix), never from `basePath`. Products whose SPA is a separate nginx container need a Caddy matcher `{ "name": "auth", "path": "/auth/*", "upstream": "<server>:<port>" }` in the manifest so `/auth/*` reaches the API tier.
- [ ] Express: `app.use(vibeAuthExpress(auth))` after body parsers and public/webhook routes, before authenticated routers. Fastify (AI Router, Recap, 1040): `await app.register(vibeAuthFastify, { auth })` + `@fastify/formbody`.
- [ ] Back-channel logout is delivered container-to-container: the registration's `internalUrl` (manifest `sso.internalUrl`, defaults to the `/auth/*` matcher upstream) must reach the tier that mounts the middleware.
- [ ] Local login route: `guardLocalLogin(auth, req => username)` before the handler; `auth.afterLocalLogin(...)` after success.
- [ ] `await auth.start()` at boot (throws only for `oidc_only` without break-glass — desired).
- [ ] Machine endpoints stay before the middleware (webhooks mounted before `express.json()` in MyBooks, T&B, TRC — do not move them).

## 4. UI
- [ ] Login page: wrap the local form in `<LoginPanel basePath returnTo>`; add the hidden break-glass route `/login/local` with `breakglass`.
- [ ] Settings → Authentication: `<AuthSettingsPage basePath productName fetch>` (pass a fetch that adds bearer/CSRF headers where the product needs them). Nav entry in the admin section.
- [ ] Sign-out: call `/auth/oidc/logout` (RP-initiated) when the session came from SSO.
- [ ] Tauri products (T&B, Connect): `loopbackLogin({ serverUrl, basePath })` from `@kisaes/vibe-auth/tauri`; `SessionAdapter.issueToken` returns a bearer for the desktop app.

## 5. CLI + manifest
- [ ] `vibeAuth.adapter` in `package.json` → module exporting `{ users, audit, adminRole, breakglassEmail, close }`. Verify `npx vibe-auth breakglass status` in the image (distroless images: point `sso.breakglassCommand` at `node <path>/dist/cli.js`).
- [ ] `.appliance/manifest.json`: `"requires": ["identity"]` and the `sso` block (capable, redirectPaths, logoutPaths, publicPaths, breakglassService/Command). Vendor into `Vibe-Appliance/console/manifests/<slug>.json`.

## 6. Exit checks (per product)
- [ ] `local` mode unchanged behaviour; `/auth/status` reports `oidc.enabled=false`.
- [ ] `both`: SSO login via the test stack (`test/compose.yml`) JIT-provisions with the mapped role; local login still works.
- [ ] `oidc_only` refused without break-glass; with it, only `vibe-breakglass` logs in locally.
- [ ] Back-channel logout ends the product session (server-side) or is honoured by the revocation list within one request (JWT).
- [ ] IdP down at boot: product serves local login; `/auth/oidc/start` → 503 page.

## Per-product notes (from COMPAT.md)

| Product | FW | Session adapter | Roles vocabulary | Special |
|---|---|---|---|---|
| Trial Balance | Express CJS | JWT (`#sso_token`) + revocation list | admin/reviewer/preparer | reference; `authMiddleware` 30 s cache → revocation check added before it |
| Time & Billing | Express | Redis session store; CSRF header on settings calls | partner/manager/senior/staff/admin | Tauri loopback; realms: staff only |
| MyBooks | Express | access JWT + refresh row; revocation list | owner/accountant/bookkeeper/readonly | `user_type='client'` denied (Q13); portal untouched |
| AI Router | Fastify | in-memory cookie sessions → add `destroyByUser` hook | admin/partner/staff | `external_ref` = SSO sub |
| Recap | Fastify | Postgres sessions | viewer/staff/preparer/admin (ordered) | zod 4 — no conflict (package uses its own zod) |
| 1040 | Fastify | Postgres sessions with `mfa_satisfied_at` → set from `amr` when MFA satisfied at IdP | admin/partner/staff | `requireUser` expects MFA satisfied |
| 1099 | Express | Redis sessions, CSRF double-submit | admin/preparer/reviewer | staff IP allowlist stays before the middleware |
| Entity | Express | Postgres sessions | admin/staff/viewer | add `disabled` column; replace stub `auth.ts` |
| Investments | Express | Postgres sessions | ADMIN/MANAGER/REVIEWER/PREPARER/READ_ONLY (role join table) | add `/me`; roles written to `user_role` |
| Calculators | Express | Postgres sessions + API keys | admin/reviewer/preparer/readonly | keep bearer API-key path first |
| Tax Research Chat | Express | access JWT + refresh; revocation list | admin/user/viewer | localStorage tokens (existing) |
| Sentinel | Express | JWT cookie; revocation list | owner/admin/analyst/auditor | replace Authentik-specific flow with the package; issuer = Vibe Auth (Q8); add `/api/ingest/vibe-auth` (Q15) |
| Connect | Express | express-session pg | is_admin boolean → roles `["admin","staff"]` | keep device passphrase (D17); fix enrolment copy; add unique index on lower(email) |
| Backup | Go | n/a | n/a | protected by the console proxy (Q10) |
