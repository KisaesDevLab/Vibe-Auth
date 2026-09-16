# STATE.md

Updated 2026-09-16 (end of the autonomous build run).

```
Phase 0: DONE — COMPAT.md (Appliance + 14 products, file:line refs), §6 filled, §2 amended in the plan, D15/D16/D17 resolved.
         H2 review pending: QUESTIONS.md Q6–Q20.
Phase 1: DONE — pnpm monorepo, CI (.github/workflows/ci.yml), test/compose.yml stack, ref-app, docs/entra-setup.md.
         H1 pending (Entra tenants) — Q12.
Phase 2: DONE — client core (discovery + internal-base rewrite + X-Forwarded-Host, PKCE, ID-token validation,
         userinfo fallback, adapters, boot tolerance). 36 vitest tests green.
Phase 3: DONE — identities, roles (D22), modes + guards, break-glass CLI (D12), RP-initiated + back-channel logout,
         revocation list (D16), audit events (§5). packages/client/test/matrix.md.
Phase 4: DONE — React LoginPanel + AuthSettingsPage (role-map editor, mode guards, Test connection popup),
         Tauri loopback helper (needs @fabianlars/tauri-plugin-oauth — Q16). Desktop login not yet exercised on real OS shells.
Phase 5: DONE — broker (bootstrap, registration API, setup wizard, admin console, audit export, event forwarder,
         edge-gate provider), deploy/ profile (subpath default; D9 port fallback), blueprints, backup contract.
         Integration matrix (test/scripts/integration.mjs) against authentik 2026.8.2: 34/34 PASS
         (setup wizard, registration, subpath issuer, MFA enrolment + TOTP re-login, JIT + role mapping,
          back-channel logout, RP-initiated logout, rotate, verify, rebase, delete).
Phase 6: DONE in ../Vibe-Appliance working tree (UNCOMMITTED — Q19): manifest schema (provides/requires/sso/
         routing.mounts/Identity category), console/manifests/vibe-auth.json, apps/vibe-auth.yml, env template,
         lib/identity.sh (+ `vibe identity`), enable/disable hooks, Caddy renderer (mounts + edge gate),
         capability-aware boot order, console Identity panel (console/identity.js + UI + 12 tests),
         CREDENTIALS.txt break-glass section, emergency port 5180. Console suite 163/164 (1 pre-existing — Q20).
         NOT yet executed on a real Ubuntu appliance host (that is Phase 7).
Phase 7: BLOCKED on H3 (Q6) — hardware target.
Phase 8: Trial Balance DONE in ../trial-balance-app working tree (UNCOMMITTED): package wired (JWT session adapter,
         revocation check, guard, settings page, login panel, break-glass CLI adapter, migration, nginx /auth/ route,
         .appliance/manifest.json sso block). Server tests 317/317; agent e2e 41/41 against the fake IdP.
         Other 12 products: docs/integration-checklist.md (per-product notes) — not started.
Phase 9: docs written (firm guide, runbooks, developer guide, integration checklist, package README).
         v1.0.0 NOT tagged; npm/image not published (owner question Q17; H1/H3/H4 outstanding).
Confidence: ~90% for Appliance deployment (everything verified except on a real host); Entra federation untested (H1).
Next: answer QUESTIONS.md (esp. Q7 routing, Q8 Sentinel identity, Q19 commits), then Phase 7 on the chosen hardware.
```
