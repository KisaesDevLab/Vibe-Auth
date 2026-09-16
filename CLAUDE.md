# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
pnpm install                                   # workspace: packages/client, packages/broker, test/ref-app
pnpm -r run typecheck                          # tsc across all packages (broker/ref-app also check their Vite UIs)
pnpm -r run build                              # client (tsup esm+cjs+dts), broker (tsc + vite ui), ref-app
pnpm --filter @kisaes/vibe-auth test           # vitest: 36 unit + flow tests against an in-process fake OpenID provider
pnpm --filter @kisaes/vibe-auth exec vitest run test/flow.test.ts -t "back-channel"   # one test
cd test && cp .env.example .env && docker compose -f compose.yml --env-file .env up -d --build
node test/scripts/integration.mjs              # real authentik 2026.8 + broker + ref-app matrix (http://localhost:18080)
docker compose -f test/compose.yml --env-file test/.env down -v
```

The Docker build context is the repo root (`.dockerignore` excludes node_modules; never `COPY` a host `node_modules`). Port 8080 is used by other projects on the dev box; the test stack listens on 18080.

## Source of truth

`VIBE-AUTH-BUILD-PLAN.md` (locked decisions D1–D24, §2 contract) as amended by `COMPAT.md` (Phase 0 findings with file:line refs). `QUESTIONS.md` holds the open decisions for the human; `STATE.md` tracks phases. Do not relitigate a locked decision; if reality contradicts one, amend §2 and add a QUESTIONS item.

Key amendments already made: authentik ≥2025 needs no Redis (no cache service); authentik supports subpath (`AUTHENTIK_WEB__PATH=/auth/`) so the default routing is `/auth/` on the product host instead of `:8443` (D9 kept as `VIBE_AUTH_ROUTING=port`); the Appliance manifest gained `provides`/`requires`/`sso`/`routing.mounts`; three products are Fastify (engine is framework-neutral); `end_session_endpoint` is never rewritten to the internal base.

## Architecture

**`packages/client` (`@kisaes/vibe-auth`)** — `engine.ts` is the framework-neutral core (`HttpRequest → HttpResponse | null`); `express.ts` and `fastify.ts` are thin adapters. Products supply `UserAdapter` + `SessionAdapter` (`adapters/types.ts`); `createPgStores({ query })` gives identity/settings/revocation stores over any SQL runner. `discovery.ts` fetches through `VIBE_OIDC_INTERNAL_BASE`, validates the public issuer, rewrites server-to-server endpoints and sends `X-Forwarded-Host/Proto` so authentik computes the public issuer. `identity.ts` (link by (issuer,sub) → verified email → JIT), `roles.ts` (D22), `tokens.ts` (ID/logout token validation), `breakglass.ts` + `cli.ts` (D12), `react/` (LoginPanel, AuthSettingsPage), `tauri.ts` (loopback login). Tests: `test/fake-idp.ts` is a full fake OP; `test/harness.ts` shows a complete integration.

**`packages/broker`** — Express service: `bootstrap.ts` (idempotent authentik repair on top of `deploy/blueprints`), `registrations.ts` (one OAuth2 provider + application per product; env block; rotate/rebase/verify; optional forward-auth edge gate), `setup.ts` (one-time-token wizard, D13), `admin.ts` (dogfoods the client package: admins log in via authentik app `vibe-auth-admin`), `audit.ts` (Postgres + JSONL + Sentinel webhook + authentik event forwarding), `config.ts` (routing modes; Appliance hints). Broker tables are prefixed `vibe_broker_` because they share the `vibe_auth` database with authentik.

**Appliance integration (Phase 6, lives in `../Vibe-Appliance`)** — `console/manifests/vibe-auth.json`, `apps/vibe-auth.yml`, `env-templates/per-app/vibe-auth.env.tmpl`, `lib/identity.sh` (register/rotate/disable/mode/rebase/setup-token; spawned by `console/identity.js` and by enable/disable hooks), `lib/render-caddyfile.sh` (`routing.mounts`, edge gate), `bootstrap.sh` (capability-aware boot order).

## Conventions

- authentik image is pinned by digest in three places (`deploy/compose.yml`, `test/compose.yml`, `Vibe-Appliance/apps/vibe-auth.yml`); change all three together.
- Never log secrets; the setup token and break-glass passwords are printed once by design.
- The client package must stay Node 20 / ESM+CJS; products range from Node 20 CJS (Trial Balance) to Node 24 ESM.
