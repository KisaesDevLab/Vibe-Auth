# Developer guide

## Layout
```
packages/client   @kisaes/vibe-auth — Express/Fastify OIDC engine, adapters, React, Tauri helper, CLI
packages/broker   ghcr.io/kisaes/vibe-auth — authentik bootstrap, registration API, setup wizard, admin console
deploy/           compose profile, blueprints, backup contract, D9 "port" Caddyfile
test/             compose.yml integration stack + ref-app (Express reference product) + scripts
docs/             this file, firm guides, entra setup, integration checklist
```

## Commands
```
pnpm install
pnpm -r run typecheck
pnpm -r run build
pnpm --filter @kisaes/vibe-auth test          # 36 tests, in-process fake OpenID provider
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

## Blueprints (`deploy/blueprints`)
`10-vibe-groups.yaml` (five groups), `20-vibe-flows.yaml` (recovery flow; MFA-required authentication flow with TOTP/WebAuthn/static enrolment; brand flow bindings). The MFA validation stage is `state: created` so the broker's enforcement toggle (`not_configured_action`) is not reverted by the hourly reconcile.

## Release
Tag `vX.Y.Z` → CI publishes `@kisaes/vibe-auth` to GitHub Packages and pushes `ghcr.io/<owner>/vibe-auth:X.Y.Z` (amd64). Bump the authentik digest in `deploy/compose.yml`, `test/compose.yml`, `Vibe-Appliance/apps/vibe-auth.yml` together.
