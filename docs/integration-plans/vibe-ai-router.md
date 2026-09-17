# Vibe AI Router — SSO implementation plan

Repo `Vibe-AI-Router` · slug `vibe-ai-router` · **Fastify 5** · in-memory HMAC-signed sessions (`vibe_admin_sess`, `SameSite=Strict`) · two containers from one image (`gateway` :8220 internal-only, `console` :8222 behind Caddy) · `rootServedOnly` · **estimate 2–3 h, confidence 85%**.

Variant: **Fastify** (`vibeAuthFastify` + `@fastify/formbody`). Read `README.md`, `../INTEGRATION-PLAN.md` §1–§3, §4.3.

## 0. Facts

| Item | Anchor |
|---|---|
| App | `src/server/app.ts:47` (`buildApp()` split from listen); public `/healthz` :80, `/version` :98, `/role` :104, `/metrics` :110 (gateway only); SPA static + not-found fallback `:150-169` (excludes `/v1/`, `/admin`, `/healthz`, `/metrics`, `/role`, `/version`) |
| Admin auth | `src/admin-api/routes.ts`: login `:185`, logout `:206`, me `:212`, change-credentials `:224`; `requireAdmin` called **inside handlers** (~50 sites, `:123`); `x-vibe-admin: 1` header required on non-GET `:124-135`; `assertSoleFirm` `:169-181` |
| Sessions | `src/admin-api/session.ts:18-101` in-memory Map, HMAC(`SESSION_SECRET`), 12 h sliding, `destroyByUser` :98; cookie set `:133-141` (`Path=/`, HttpOnly, `SameSite=Strict`, `Secure` iff `SECURE_COOKIES=true`) |
| Users | `db/schema.ts:98-111`: `firm_id` NOT NULL, `role` enum admin/partner/staff, `email` unique nullable, `password_hash` nullable, **`external_ref` reserved for SSO sub** (`:108`); no active flag |
| Gateway auth (untouched) | `src/gateway/routes.ts:63-64` bearer app tokens (`app_tokens`), `X-Vibe-*` trust headers |
| Bootstrap surface | `src/admin-api/bootstrap.ts` under `/admin/*` when `ADMIN_BOOTSTRAP_TOKEN` set |
| Config | `src/config/env.ts`: `ROUTER_ROLE` :60, `SESSION_SECRET` :62 (optional → random per boot), `SECURE_COOKIES` :64, `MASTER_KEY` :27-31; bootstrap env `ROUTER_ADMIN_EMAIL/PASSWORD` |
| Image | `Dockerfile` node:24-alpine, `USER node`, read-only fs, node_modules `/app/node_modules`, CMD runs migrations then `node dist/src/server/index.js` (console sets `SKIP_MIGRATIONS=1`) |
| Migrations | `db/migrate.ts` up/down, `db/migrations/000N_*/` |
| SPA | `ui/src/pages/Login.tsx:3-43`; no client router (`ui/vite.config.ts:14-19`), `base: './'` (needs trailing slash) |
| Manifest | none in repo; console `vibe-ai-router.json`: `rootServedOnly`, `routing.default_upstream: vibe-ai-router-console:8222`, subdomain `airouter`, emergency 5193, `deny_paths: ["/metrics"]` |
| CLI | `src/ops/bootstrap-firm.ts` (self-executing) |
| Tests | vitest 3 with `app.inject()`; `SessionStore` constructable |

## 1. Decisions

1. **Console container only.** Mount the plugin only when `servesConsole(role)`; the gateway never sees `/auth/*`. `internalUrl: http://vibe-ai-router-console:8222`.
2. **Sessions stay in memory** (I14: no session redesign). Consequence: SSO sessions also vanish on restart, same as today. `destroyByIdentity` walks `store.destroyByUser(userId)` after resolving the user from a new `auth_sessions_oidc` table (Postgres, because the store cannot hold identity data). Document the restart behaviour in `docs/sso.md`; a Redis store is a separate ticket.
3. **`SameSite=Strict` stays.** On the appliance authentik is same-site; the callback response *sets* the cookie and the next navigation is same-origin, so Strict is not the breakage the survey feared. It matters only for a remote broker (`remote-broker.md`).
4. **Roles.** Vocabulary `["admin","partner","staff"]`, `adminRole: "admin"`; map `vibe-admin`/`vibe-it` → `admin`, `vibe-partner` → `partner`, `vibe-manager`/`vibe-staff` → `staff`. Only `admin` can use the console (`requireAdmin`), which is the product's rule and stays.
5. **Schema.** Add `is_active boolean not null default true` (for `setActive`) and write `external_ref = <issuer>#<subject>` on link/JIT (the column was reserved for this). Migration `0009_vibe_auth/`.
6. **`x-vibe-admin` header.** The `AuthSettingsPage` `fetch` prop adds it; the package's own `/auth/*` routes are outside `/admin-api` and are not subject to it.
7. **Read-only filesystem.** The package keeps discovery/JWKS in memory; nothing to write. Confirm no `fs` writes in the client package's discovery path (there are none as of 1.0.3).
8. **Emergency port `:5193` is plain http** while `SECURE_COOKIES=true` in domain mode; SSO there fails exactly like local login does today. Not an SSO regression; keep the existing doc note.
9. **Break-glass:** `["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` from `WORKDIR /app`; adapter `dist/src/vibeAuthAdapter.js`; `breakglassService: vibe-ai-router-console`.

## 2. Steps

**A.** Dependency (`package.json` `^1.0.3`, `.npmrc`, BuildKit secret in `Dockerfile`). Migration `db/migrations/0009_vibe_auth/{up,down}.sql`: package SQL + `users.is_active` + `auth_sessions_oidc(sid, user_id, issuer, subject, idp_sid, created_at)`.

**B.** `src/lib/vibeAuthUsers.ts` (Drizzle): firm = the sole firm (`assertSoleFirm` semantics); `create` inserts with null `password_hash`, mapped role, `external_ref`; audit → `writeAudit()` (`src/protect/audit.ts:229`; register the `vibe.auth.*` event names first, it throws on unknown events).

**C.** `src/lib/vibeAuth.ts`: `SessionAdapter` over `SessionStore`: `create(req, reply, user)` = `store.create(user)` + set the cookie exactly as `session.ts:133-141` (cast Fastify `request`/`reply`); insert `auth_sessions_oidc`; `destroy`, `currentUserId` (from the cookie via `store.get`), `destroyByIdentity`. Engine with `createPgStores` on the `postgres` client (`sql.unsafe(text, params)` → rows), `secretWrap` via `src/vault/crypto.ts` (`MASTER_KEY` envelope), `basePath: ""`, `trustProxy: true`.

**D.** In `buildApp()`: `await app.register(formbody); await app.register(vibeAuthFastify, { auth })` inside `if (servesConsole(role))`, before the static/not-found registration (`:150`) and add `/auth` to the not-found exclusion list. `guardLocalLogin` equivalent as a `preHandler` on `POST /admin-api/auth/login` (`routes.ts:185`) returning the product's error envelope; `auth.afterLocalLogin` after success. `await auth.start()` in `src/server/index.ts` before listen (console role only).

**E.** SPA: `ui/src/pages/Login.tsx` wraps the form in `<LoginPanel basePath="" returnTo="./">` (root-served; relative base); `PAGES` in `ui/src/App.tsx:14-24` gains `auth` for `<AuthSettingsPage productName="AI Router" fetch={fetchWithAdminHeader}>`; break-glass page state `login-local`. Sign-out → `/auth/oidc/logout?local=1` when SSO-born.

**F.** Manifests: create `.appliance/manifest.json` from the console one; add to both:
```jsonc
"requires": ["identity"],
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/healthz","/version","/role","/admin-api/auth/login","/admin-api/auth/logout","/admin/*"],
  "edgeGate": false, "internalUrl": "http://vibe-ai-router-console:8222",
  "breakglassService": "vibe-ai-router-console",
  "breakglassCommand": ["node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
`/v1/*` never reaches Caddy (gateway is internal), so it is not listed. Existing `deny_paths` stays.

**G.** Tests: `test/sso-e2e.mjs`; vitest with `app.inject()`: callback sets `vibe_admin_sess`; `/admin-api/auth/me` works; back-channel → `destroyByUser`; gateway role never registers `/auth/*` (qa-clean-room style 404 check).

**H.** `docs/sso.md` (+ note the restart-drops-sessions behaviour); PR `(Phase 8 step 3)`. Out of scope, note in PR: 1040 probes `GET /v1/policy/regions`, which does not exist.

## 3. Exit gate additions

- LAN box: register, `both`, sign in at `http://<ip>:5193/` (root-served → emergency port in LAN mode), `oidc_only` + break-glass.
- `vibe-ai-router` (gateway) container: `curl -s -o /dev/null -w '%{http_code}' http://vibe-ai-router:8220/auth/status` from the console container returns 404.
