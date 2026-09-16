# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

This repository is **pre-implementation**. It contains only `VIBE-AUTH-BUILD-PLAN.md` (v2, "Q&A-locked"). There is no code, no package manifest, no CI, and no README yet. There are no build, lint, or test commands to run until Phase 1 lands.

`VIBE-AUTH-BUILD-PLAN.md` is the source of truth. Read it in full before doing any work. Its structure:

- **§1 Locked decisions (D1–D24)** — design choices that are fixed. Do not relitigate them; if a decision must change, amend the table and add a `QUESTIONS.md` entry.
- **§2 Appliance compatibility contract** — the *only* touch points between Vibe Auth and the Vibe Appliance (names, manifest schema, console behaviour, Caddy, backup, issuer split, resources, boot tolerance). Only Phase 0 findings may amend it.
- **§3 Phases 0–9** — the execution order, each with hard exit gates.
- **§5 Audit event schema**, **§6 Integration matrix** (filled in Phase 0), **§7 QUESTIONS.md**, **§8 STATE.md**, **§9 Human checkpoints H1–H4**.

The build is meant to run as autonomous, phased Claude Code work. Human checkpoints are listed in §9 and nowhere else; everything else runs unattended. Keep `STATE.md` (§8) current as phases progress.

## Phase ordering rules

- **Phase 0 blocks everything.** It is read-only discovery against a workspace with every Vibe repo checked out (D19). Output is `COMPAT.md` with file/line references, the filled §6 matrix, and any §2 amendments. Phase 1 must not start until `COMPAT.md` is committed and every Phase 0 checkbox is ticked (checkpoint H2).
- Three facts are deliberately unknown until Phase 0 discovers them: the Appliance secret-injection mechanism (D15), whether any product uses stateless JWT sessions (D16), and how Vibe Connect derives client-side keys (D17). Do not assume answers to these.
- H1 (Entra tenants) happens during Phase 1; H3 (hardware target) must be decided before Phase 7.

## Planned architecture

What the plan specifies; once code exists, verify against it rather than this summary.

**Two deliverables in one pnpm monorepo** (`packages/client`, `packages/broker`, `deploy/`, `test/`, `docs/`):

1. **Broker** (`packages/broker`, Node/Express, image `ghcr.io/kisaes/vibe-auth`) — bootstraps a bundled **Authentik** IdP (upstream image pinned by digest, never forked; configured via blueprints), exposes a registration API (`/registrations/{slug}`, `/rotate`, `/rebase`, `/registrations/verify`, `/health`, `/version`, authenticated by `VIBE_AUTH_CONSOLE_TOKEN`), hosts the firm admin UI and first-run setup wizard (D13, one-time token, no pre-created superuser), and emits audit events (§5). Env prefix `VIBE_AUTH_*`.
2. **Client package** (`packages/client`, npm `@kisaes/vibe-auth`) — shared Express middleware + React components that each Vibe product embeds. OIDC Authorization Code + PKCE only (D1). Product-side env: `VIBE_OIDC_*`, `VIBE_AUTH_MODE`, `VIBE_BREAKGLASS_*`. Products integrate through **adapters**: `SessionAdapter`, `UserAdapter`, `AuditSink`, `SecretWrap`, `TenantResolver` (single-tenant default only, D18). Ships a CLI `vibe-auth breakglass ensure|rotate|status`.

**Key cross-cutting design points:**

- **Auth modes per product** (D6/D11): `local` (default) · `both` · `oidc_only`. Enabling Vibe Auth never changes a product's mode; the firm flips each one. `oidc_only` is refused unless a break-glass local admin (`vibe-breakglass`, D12) exists and a test login succeeded.
- **Issuer split** (§2.6): browsers see `https://auth.{host}` (or `https://{ip}:8443` in LAN mode, D9); products talk to `http://vibe-auth-authentik-server:9000`. The client discovers against the public issuer, validates `iss`, then rewrites `token_endpoint`, `jwks_uri`, `userinfo_endpoint`, `end_session_endpoint` to the internal base. `authorization_endpoint` is never rewritten.
- **Boot tolerance** (§2.8): in `both` mode a product must start and serve local login even if IdP discovery fails; in `oidc_only` it serves the break-glass route and an "IdP unavailable" page.
- **Identity linking** (Phase 3): `(issuer, sub)` primary; verified-email linking; JIT provisioning; unverified email denied. Roles from `roles` claim, else groups→role map (D22).
- **Firm staff only** (D5); client-portal users never use SSO.
- **Postgres**: shared Appliance instance, database/role `vibe_auth` (D7); bundled Postgres exists only for standalone installs (`VIBE_AUTH_PG_MODE=shared|bundled`).
- **Platform**: amd64 only (D8). Caddy `forward_auth` edge gate is opt-in (D10).

**Reference product**: `test/ref-app` (minimal Express app using the client package) is the first integration target and is used in every phase's exit gate. Trial Balance is the reference real product for roll-out (Phase 8).

## Naming contract (§2.1)

Compose services `vibe-auth`, `vibe-auth-authentik-server`, `vibe-auth-authentik-worker`, `vibe-auth-cache`; volumes `vibe-auth-*`; manifest slug `vibe-auth`. Authentik 9000/9443 and broker 8080 are always container-internal; only LAN mode publishes a host port (`:8443`, via Caddy). Do not introduce new names without amending §2.1.
