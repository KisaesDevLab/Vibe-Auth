# Vibe Calculators — SSO implementation plan

Repo `Vibe-Calculators` · slug `vibe-calculators` · Express 4 + **Postgres sessions** (`vibecalc_sid`, lax, 30/90 d) + magic link + **API keys** · **distroless runtime (no shell)** · path-mountable (base-path sentinel) · **estimate 2–3 h, confidence 90%**.

Variant: **Express + server-side sessions**. Read `README.md`, `../INTEGRATION-PLAN.md` §1–§2, §4.8.

> **Break-glass review, 2026-09-19.** `z.string().email()` at `routes/auth.ts:41` rejects `vibe-breakglass@localhost`.
> `mustChangePassword` is a hard gate in the SPA (`guards.tsx:27,48`): this plan clears it for JIT, and `createLocalUser` must
> clear it for the break-glass row too, with `status: 'active'`. Magic links give a JIT account a session from its mailbox.
> This is the one product hit by both CSP layers (Caddy and bare `helmet()`), so the package's inline-script test page will
> not close its popup. Prefer an absolute module path in `breakglassCommand`, as the migration command already does. Detail and anchors: `break-glass-and-rollout-risks.md`; the corrected recipe is
> `../INTEGRATION-PLAN.md` §2.B, I7, I8, I12.

## 0. Facts

| Item | Anchor |
|---|---|
| App | `apps/api/src/server.ts`: health `:96`, openapi `:97`, `loadSession` app-level (attach only) `:96-100`, auth router `:99`, routers `~:137` |
| Auth routes | `apps/api/src/routes/auth.ts`: login `:67` (TOTP `:115-146`, recovery codes), logout `:175`, magic-link `:194/:245`, me `:354` |
| Sessions | `apps/api/src/lib/sessions.ts:23-44` (id = sha256(cookie)), TTLs `:24-25`, `revokeAllUserSessions` `:176`; cookies `lib/cookies.ts:26-33` (**`secure: deployMode === "domain"`** via `VIBE_DEPLOY_MODE`, `sameSite: "lax"`) |
| Middleware | `middleware/auth.ts`: `loadSession` (API key first `:62-107`, bearer never falls back to cookie; cookie re-issued `:115`), `requirePermission` per route, `requireAuth` only in `routes/me.ts:44` |
| Users | `packages/db/src/schema/users.ts:35-80`: **text** id, `email` unique, nullable `passwordHash` (Argon2id), `role` enum admin/reviewer/preparer/readonly, `status` pending/active/suspended, `totp*`, **`mustChangePassword`** `:73`, `archivedAt` |
| Permissions | `packages/shared-types/src/permissions.ts` (`ROLES` :24, `ROLE_PERMISSIONS` :137) |
| Public routes | `/api/health`, `/api/health/deep`, `/api/v1/openapi.json`, `/api/v1/auth/login|logout|magic-link|magic-link/consume`; **any `/api/v1/*` with `Authorization: Bearer vibe_…`** |
| SPA | `apps/web/src/pages/Login.tsx:32-45`, `auth/AuthContext.tsx`, base path `lib/base-path.ts:17-25` (`BASE_PATH`, `apiUrl()`), sentinel `vite.config.ts:19` + `docker/web-entrypoint.sh`; shadcn/Radix |
| Config | `apps/api/src/lib/env.ts`: `VIBE_DEPLOY_MODE` (lan/domain/tailscale, the only cookie-secure control), `VIBE_KMS_KEY` :87-95, `VIBE_AI_*`; **no `ALLOWED_ORIGIN` read** (appliance declares it), `MIGRATIONS_AUTO` unread (always migrates on boot `index.ts:55-56`) |
| Image | `apps/api/Dockerfile`: **`gcr.io/distroless/nodejs20-debian12:nonroot`**, `ENTRYPOINT ["node"]`, `CMD ["dist/index.js"]`, node_modules `/app/node_modules` (`pnpm deploy`), port 3000 |
| Manifest | `.appliance/manifest.json` exists (routing client:80 + `/api/*` → `vibe-calculators-server:3000`, health `/api/health`, migrations `["/nodejs/bin/node","/app/node_modules/@vibe-calc/db/dist/migrate.js"]`); console `vibe-calculators.json` (firstLogin default creds `admin@local.test`) |
| CLI | none in `apps/api`; `lib/seed-default-admin.ts` in-process |
| Tests | vitest + supertest + testcontainers Postgres (`apps/api/src/test/auth-flows.integration.test.ts`, `api-keys.integration.test.ts`, `db-fixture.ts`); `createApp()` factory |

## 1. Decisions

1. **Three principals, one rule:** the API-key path (`Bearer vibe_…`) and the magic link are untouched; only the cookie session is SSO-aware. Since `loadSession` never rejects and API keys are resolved first, mounting the engine after `loadSession` cannot interfere with bearer calls.
2. **Roles.** Vocabulary `["admin","reviewer","preparer","readonly"]`, `adminRole: "admin"`; map `vibe-admin`/`vibe-it`/`vibe-partner` → `admin`, `vibe-manager` → `reviewer`, `vibe-staff` → `preparer`.
3. **JIT user shape:** `status: 'active'`, `passwordHash: null` (already allowed for magic-link users), **`mustChangePassword: false`** (I7; otherwise the SPA gate `/onboarding/change-password` traps SSO users). `setActive(false)` → `status: 'suspended'`; `findById` treats `archivedAt` as inactive.
4. **Session adapter.** `create` mirrors `routes/auth.ts:67` + `lib/cookies.ts` (including the `VIBE_DEPLOY_MODE`-driven `secure`); `sessions` gains OIDC columns; `destroyByIdentity` = `revokeAllUserSessions`. TOTP skipped for SSO sessions (`VIBE_OIDC_REQUIRE_MFA_AMR=true`).
5. **Cookie `secure` follows `VIBE_DEPLOY_MODE`**, which the appliance sets per install mode. In LAN it is `lan` → not secure; correct. Add `tailscale` → not secure too (Tailscale mode is http on the loopback behind `tailscale serve`; the manifest already treats it that way for 1040).
6. **Path-mounted (`/calc/`)**: engine `basePath: ""`, React `basePath = BASE_PATH` from `lib/base-path.ts`. Two containers → `/auth/*` matcher to `vibe-calculators-server:3000`.
7. **Distroless:** `breakglassCommand: ["/nodejs/bin/node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` (the migrations command already uses `/nodejs/bin/node`; `WORKDIR /app`). Adapter compiled to `dist/vibeAuthAdapter.js` and passed through `scripts/fix-esm-extensions.mjs`. The console runs it with `docker exec -i`, which works without a shell as long as the argv is a plain binary path.
8. **Dead config:** `ALLOWED_ORIGIN` is declared but unread; the appliance's identity script derives the product base from it, so it stays declared. `MIGRATIONS_AUTO` unread; note only.
9. **First-login default credentials** (`admin@local.test` / `vibe-admin-changeme`, forced reset): in `oidc_only` this seed cannot log in locally (only break-glass); document.

## 2. Steps

**A.** Dependency in `apps/api/package.json`, `.npmrc`, BuildKit secret in `apps/api/Dockerfile` (pnpm, before `pnpm deploy`). Drizzle migration in `packages/db`: package SQL (or the drizzle schema import) + `sessions` OIDC columns.

**B.** `apps/api/src/lib/vibeAuthUsers.ts` (text ids: `VibeUser.id` is a string, fine); Argon2id via `@node-rs/argon2` for `createLocalUser`; audit → `recordAuthEvent()` + `lib/audit-events.ts`.

**C.** `apps/api/src/lib/vibeAuth.ts`; `secretWrap` via `lib/kms.ts` (`VIBE_KMS_KEY` AES-GCM); stores on the `pg` pool.

**D.** Mount `vibeAuthExpress(auth)` in `server.ts` after `loadSession` (`:100`) and before the routers (`~:137`), inside the same `if (options.auth)` guard so tests without auth stay unaffected; `guardLocalLogin` on `POST /api/v1/auth/login` (`:67`) and `magic-link/consume` (`:245`); `afterLocalLogin`; `await auth.start()` in `index.ts` after `applyMigrations`.

**E.** SPA: `pages/Login.tsx` `<LoginPanel basePath={BASE_PATH} returnTo="/">` with shadcn `classNames`; `/login/local`; `NAV_ITEMS` in `components/layout/AppShell.tsx:45-68` + route with `RequirePerm perm="settings:write"` in `App.tsx:~385` for `<AuthSettingsPage basePath={BASE_PATH} productName="Calculators" fetch={apiFetch}>`; sign-out → `/auth/oidc/logout?local=1` when `me.ssoBorn`.

**F.** Manifests (both):
```jsonc
"requires": ["identity"],
"routing": { "default_upstream": "vibe-calculators-client:80",
  "matchers": [ { "name": "api", "path": "/api/*", "upstream": "vibe-calculators-server:3000" },
                { "name": "auth", "path": "/auth/*", "upstream": "vibe-calculators-server:3000" } ] },
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/api/health","/api/health/deep","/api/v1/openapi.json","/api/v1/auth/login","/api/v1/auth/logout","/api/v1/auth/magic-link","/api/v1/auth/magic-link/consume","/api/v1/*"],
  "edgeGate": false, "internalUrl": "http://vibe-calculators-server:3000",
  "breakglassService": "vibe-calculators-server",
  "breakglassCommand": ["/nodejs/bin/node","node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```
`/api/v1/*` is public at the edge because API keys authenticate it in-app; the edge gate is off anyway. Env template: `VIBE_OIDC_REQUIRE_MFA_AMR=true`.

**G.** Tests: extend `auth-flows.integration.test.ts` (testcontainers): callback sets `vibecalc_sid`; API-key call unaffected by mode; `mustChangePassword=false` for JIT; back-channel revokes; `test/sso-e2e.mjs`.

**H.** `docs/sso.md`; PR `(Phase 8 step 8)`.

## 3. Exit gate additions

- `docker run --rm --entrypoint /nodejs/bin/node <image> node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass status` runs (distroless has no `sh`; this is the only way to verify).
- LAN box: register, `both`, sign in at `http://<ip>/calc/`.
