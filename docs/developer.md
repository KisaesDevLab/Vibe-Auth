# Developer guide

## Layout
```
packages/client   @kisaesdevlab/vibe-auth — Express/Fastify OIDC engine, adapters, React, Tauri helper, CLI
packages/broker   ghcr.io/kisaesdevlab/vibe-auth — authentik bootstrap, registration API, setup wizard, admin console
deploy/           compose profile, blueprints, backup contract, D9 "port" Caddyfile
test/             compose.yml integration stack + ref-app (Express reference product) + scripts
docs/             this file, firm guides, entra setup, integration checklist
```

## Commands
```
pnpm install
pnpm -r run typecheck
pnpm -r run build
pnpm --filter @kisaesdevlab/vibe-auth test          # 36 tests, in-process fake OpenID provider
cd test && cp .env.example .env && docker compose --env-file .env up -d --build
node test/scripts/integration.mjs             # real authentik + broker + ref-app matrix
```
The test stack listens on http://localhost:18080 (`/auth/` authentik, `/vibe-auth/` broker, `/ref/` reference product).

## How a request flows (client package)
`engine.ts` handles a neutral `HttpRequest` (`http.ts`); `express.ts` / `fastify.ts` translate. Routes under `{basePath}/auth`:

| Route | Purpose |
|---|---|
| `GET /status` | mode, IdP name/reachability, whether local login is visible |
| `GET /oidc/start?return_to=&test=1&loopback_port=` | builds the authorization URL (PKCE S256, state, nonce; 5-min pending store) |
| `GET /oidc/callback` | code exchange (client_secret_basic + code_verifier), ID-token validation (iss/aud/exp/nonce/at_hash), userinfo fallback, MFA `amr` check, link/JIT, session create |
| `POST /oidc/backchannel` | OIDC back-channel logout: validates the logout token, ends sessions by sid/sub/user, revokes (D16) |
| `GET|POST /oidc/logout` | destroys the session, RP-initiated logout with `id_token_hint` |
| `POST /oidc/exchange` | Tauri loopback: one-time code → bearer token |
| `GET|PUT /settings`, `POST /settings/test` | admin-only settings API with mode guards |

`discovery.ts` fetches the well-known document through `VIBE_OIDC_INTERNAL_BASE` when set, validates the returned issuer against the public one, rewrites server-to-server endpoints to the internal base and sends `X-Forwarded-Host/Proto` so authentik computes the public issuer (§2.6). `authorization_endpoint` and `end_session_endpoint` are never rewritten.

## Broker (`packages/broker`)
Boot: `db.ensureDatabase()` (only with `VIBE_AUTH_PG_ADMIN_URL`) → migrate → bootstrap authentik (wait, groups, scope mapping, brand flows, MFA stage) → setup wizard token → self-registration (`vibe-auth-admin`) → admin router → event forwarder. Registration API and admin API are in `server.ts` / `admin.ts`; authentik calls in `authentik.ts`.

Routing modes (`VIBE_AUTH_ROUTING`): `subpath` (default), `subdomain`, `port`; authentik always serves under `VIBE_AUTH_AUTHENTIK_PATH` (`/auth/`). In the Appliance the broker derives everything from `VIBE_AUTH_APPLIANCE_ORIGIN` + `VIBE_AUTH_APPLIANCE_MODE`.

### Password reset and outbound email
Self-service reset is authentik's `vibe-recovery` flow (identify → email a one-time link → new password → sign in), linked from the sign-in page ("Forgot password?") and bound to the brand by bootstrap. authentik's *global* mail settings are env-only (`AUTHENTIK_EMAIL__*`, seeded from `VIBE_AUTH_SMTP_*` in `deploy/compose.yml`), so `email.ts` writes admin-entered SMTP settings onto the recovery flow's email stage instead (`use_global_settings=false`), stores them in `vibe_broker_state.email` (password wrapped with the broker key) and re-applies them at every boot. `smtp.ts` is a dependency-free SMTP client (implicit TLS, STARTTLS, AUTH PLAIN/LOGIN) used only for the synchronous "send test email" check, because authentik queues mail and never reports delivery failures to the API caller.

Admin API (`/api/admin`, session-protected):

| Route | Purpose |
|---|---|
| `GET|PUT|DELETE /email` | status / save / remove the SMTP settings (PUT body: `host, port, security=starttls|ssl|none, username?, password?, from`; blank password keeps the stored one) |
| `POST /email/test` | send a test message through the broker's own SMTP client (`{to?}`, defaults to the signed-in admin); 502 with the server's reason on failure |
| `POST /users/:pk/recovery-email` | ask authentik to email a reset link via the recovery stage (400 when no mail is configured) |
| `POST /users/:pk/recovery-link` | mint a one-time reset link (authentik `/core/users/{pk}/recovery/`) to hand over out of band; shown once, never logged |

`POST /users` now emails the new user when mail is configured and always returns a one-time `recoveryLink`. The setup wizard has an optional SMTP section that is validated before anything is created.

### Per-product access (which apps a user may sign in to)
A product is open to every firm user until an administrator marks it *restricted* (D11: nothing changes until the firm opts in). Enforcement is authentik's own application policy bindings, managed by `access.ts`:

- One group per product, `vibe-app-<slug>` (attributes `vibe.managed`, `vibe.app`). Access = membership; authentik is the only store of membership.
- Restricting binds two groups to the application (`policy_engine_mode: any`): `vibe-app-<slug>` and `vibe-admin` (lockout protection; the policy engine has no superuser bypass, so even `akadmin` is denied unless it is in one of them). The `<slug>-edge` forward-auth application gets the same bindings. An application with zero bindings admits everyone, so "open" means "no bindings".
- The restricted flag lives in `vibe_broker_state` under `access:<slug>`, which `Registrations.remove()` never touches: disable then re-register cannot silently reopen a product. `Registrations.upsert()` calls `access.sync(reg)` after the edge gate (a re-created application has a new pk and no bindings), and the broker syncs every registration at start because deleting both bindings by hand in authentik fails open. `verify()` reports that drift.
- When restricting, the group is created and optionally seeded with every active person *before* the bindings exist, so nobody is denied half-way. Opening deletes only the broker's own bindings (plain group bindings for those two groups) and keeps the group and its members.
- A denied user sees authentik's "Permission denied" page at the authorize endpoint; authentik does not redirect back with `error=access_denied`, so the client package is not involved. The product also disappears from the user's authentik "My applications" page.
- Unticking a restricted product ends the user's authentik sessions, which fires back-channel logout in every product; they sign back in to what they still have.
- The federated-source group mapping excludes `vibe-app-*` names: under `group_matching_mode=name_link` a single directory claim with that name would link the group to the source, and authentik would then strip it from every other federated user at their next sign-in. v1 is console-managed only.
- Limit: this gates single sign-on. In `both` mode a user who still has a local product password can sign in locally (D6); full enforcement needs `oidc_only`. The admin console application (`vibe-auth-admin`) can never be restricted.

| Route | Purpose |
|---|---|
| `GET /api/admin/access` | `{apps:[{slug, displayName, restricted, registered, members}], users:[{pk, apps, admin}]}` from one users call; restricted-but-unregistered products appear with `registered:false` |
| `PUT /api/admin/registrations/:slug/access` | `{restricted, seed?: "everyone" \| "none"}` |
| `PUT /api/admin/users/:pk/apps` | `{apps: string[]}` exact set among registered products; returns `{added, removed, revoked, sessionsEnded}` |
| `DELETE /api/admin/access/:slug` | forget the restriction of an unregistered product |
| `GET\|PUT /registrations/:slug/access` | the same switch for the Appliance console (console token) |

## Blueprints (`deploy/blueprints`)
`10-vibe-groups.yaml` (five groups), `20-vibe-flows.yaml` (recovery flow; MFA-required authentication flow with TOTP/WebAuthn/static enrolment; brand flow bindings). The MFA validation stage and the recovery email stage are `state: created` so the broker's runtime patches (`not_configured_action`; SMTP settings) are not reverted by the hourly reconcile.

## Release
Tag `vX.Y.Z` → CI publishes `@kisaesdevlab/vibe-auth` to GitHub Packages and pushes `ghcr.io/<owner>/vibe-auth:X.Y.Z` (amd64). Bump the authentik digest in `deploy/compose.yml`, `test/compose.yml`, `Vibe-Appliance/apps/vibe-auth.yml` together.
