# STATE.md

Updated 2026-09-16 after the Q&A session (decisions D25–D30 in the plan; QUESTIONS.md is closed).

```
Phase 0: DONE — COMPAT.md, §6 filled, §2 amended, D15/D16/D17 resolved. H2 review done in the Q&A.
Phase 1: DONE — monorepo, CI, test stack, ref-app, docs/entra-setup.md. H1 deferred (Entra not in v1, D26).
Phase 2: DONE — client core. 36 vitest tests green.
Phase 3: DONE — identities, roles, modes, break-glass CLI, logout (RP + back-channel), revocation list, audit.
Phase 4: DONE — React LoginPanel + AuthSettingsPage, Tauri loopback helper (plugin decision D29).
Phase 5: DONE — broker, deploy profile (subpath default per revised D9), blueprints, backup contract.
         Integration matrix vs authentik 2026.8.2: 34/34 PASS (test/scripts/integration.mjs).
Phase 6: DONE — Vibe-Appliance branch `vibe-auth-integration` (commit ed117ab). Console suite 163/164 (1 pre-existing).
         Not yet executed on a real host (Phase 7).
Phase 7: READY TO RUN — bare-metal office LAN box, run by the human: test/scripts/phase7.sh + docs/phase7-checklist.md.
         Paste per-mode tables here.
Phase 8: Trial Balance DONE — trial-balance-app branch `vibe-auth-integration`. Exit gate met 2026-09-17: consumes
         @kisaesdevlab/vibe-auth ^1.0.1 from GitHub Packages (both images build with a NODE_AUTH_TOKEN secret),
         committed test/sso-e2e.mjs + test/fake-idp.mjs (14 steps, CI workflow sso-e2e.yml), 322/322 server tests,
         manifest vendored from the console copy (breakglassCommand path fixed, /auth/* matcher, internalUrl),
         passkey sign-in gated in oidc_only, docs/sso.md with the deviations list.
         Sentinel DONE — Vibe-Sentinel branch `vibe-auth-integration` (commit 6834a61): package integration, POST /api/ingest/vibe-auth,
         SENT-V-AUTH-000..004 rules, password-only vibe-breakglass; 229/229 tests, fake-IdP e2e 22/22.
         Remaining: T&B, MyBooks, AI Router, TRC, 1099, Entity, Investments, Calculators, 1040, Recap, Connect, Backup
         (docs/integration-checklist.md).
Phase 9: docs done. v1.0.0 published (npm + GHCR); v1.0.1 adds the authentik-blueprint wait for slow hosts. Repo: github.com/KisaesDevLab/Vibe-Auth.
         H4 (runbooks executed by a non-author) outstanding.
Artifacts: @kisaesdevlab/vibe-auth 1.0.1 · ghcr.io/kisaesdevlab/vibe-auth:1.0.1 (CI on tag push)
Confidence: ~90% for Appliance deployment pending Phase 7; Google federation untested live; Entra out of v1.
Next: push the three branches/tag, run Phase 7 on the LAN box, then continue Phase 8 roll-outs.
```

2026-09-17 (first LAN-box enable, Appliance Phase 7 in progress): v1.0.2 — the broker now takes its scheme from VIBE_AUTH_APPLIANCE_ORIGIN (Appliance LAN mode is plain http on :80; COMPAT row corrected). Earlier the same day the Appliance side fixed: console image missing identity.js, DB-password extraction for VIBE_AUTH_DATABASE_URL, compose depends_on so worker + blueprints start, and Caddy no longer strips /vibe-auth (routing.stripPrefix=false).

2026-09-17: v1.0.3 — authentik 2026.8 "Base URL" system setting (scheme + host, no path; required from 2026.11) is now written by the broker at bootstrap and on /rebase (ensureBaseUrl) and seeded by deploy/compose.yml via AUTHENTIK_WEB__BASE_URL; the LAN box showed "The base URL has not been configured" after the wizard.

2026-09-19: v1.0.5 (first half; v1.0.4 was the upstream MFA amr fix) — password reset without depending on container env: admin console gains an Email page (SMTP settings written onto the vibe-recovery email stage, stored in vibe_broker_state.email with the password wrapped, re-applied at boot; "Send me a test email" via a dependency-free SMTP client in smtp.ts) and per-user "Send reset email" / "Reset link" actions (authentik recovery + recovery_email endpoints); user creation emails the link when mail exists and always returns a one-time link; setup wizard has an optional SMTP section; blueprint email stage is state: created.

2026-09-19: v1.0.5 — per-product access: a product is open to everyone until an admin restricts it (D11 kept); then authentik policy bindings admit only group vibe-app-<slug> (ticked per user in the admin console's Users page) and vibe-admin. access.ts owns group/bindings/flag (vibe_broker_state access:<slug>, survives registration removal); upsert and broker start re-sync; verify reports hand-deleted bindings (fail-open drift); unticking ends the user's authentik sessions; source group mapping now excludes vibe-app-* and self-repairs; console-token GET|PUT /registrations/:slug/access; no client package change (authentik renders the denial page itself). QUESTIONS.md gained the vibe-it item.

2026-09-19: docs only — Vibe 1040 findings committed after review against 1.0.5 and the Appliance; new `docs/integration-plans/break-glass-and-rollout-risks.md` (break-glass mechanism, per-product matrix, Appliance risks that scale with the rollout, follow-up work by owner). Recipe corrected: break-glass address is a dotted domain, never `@localhost` (§2.B); I7, I8, I12 extended; nine plans annotated; Payroll & Time schema claims and the Recap command path fixed; runbook R2 and three QUESTIONS items added. No code changed; nothing released.

2026-09-20: Phase 8 step 13, Payroll & Time — implemented (`Vibe-Payroll-Time` PR #3, `Vibe-Appliance` PR #9), **exit gate not met** (no real-authentik sign-in; LAN-box register pending). Consumes @kisaesdevlab/vibe-auth ^1.0.5; 25-case fake-IdP vitest suite (backend 339/339), both images build with the NODE_AUTH_TOKEN secret, `breakglassCommand` verified inside the built image. Two plan errors caught before shipping and written back as `docs/integration-plans/README.md` lessons 11 (`/auth/*` collides with the SPA-owned `/auth/magic` and `/auth/reset`: route the engine's paths one by one; Appliance manifest validator generalised) and 12 (break-glass provisioned before first-run setup bricks a product whose wizard locks on any admin row); lessons 13 and 14 cover the session role and `sid` across refresh. Plan annotated in place. `vibe-it` → `super_admin` kept per the plan; the QUESTIONS.md item stays open. No package change; nothing released.

2026-09-20: client v1.0.6 on main, NOT tagged (break-glass by username or email; `breakglass status` with product readiness and `breakglass verify` over stdin; `defaultRoleMapFor` no longer guesses; last-admin guard and `setRole` false in role sync; `login.success` only after the session exists; inline-script escaping; framework-neutral adapter types, optional express peer; `auth.ready()`). Appliance branch `feat/identity-full-management`: break-glass verified by the product before `oidc_only`, console rotate + status, image gate and broker floors at register, selective recreate, identity keys survive re-render, per-product access control, LAN address-drift detection and re-apply, Tailscale refused, update warning; manifests for 1040 and Tax Research. Five products hardened on branches (TB and 1099 `fix/sso-hardening`; 1040, Tax Research, Sentinel on their SSO branches). Status table: docs/integration-plans/break-glass-and-rollout-risks.md §D.

2026-09-20: v1.0.7 — broker start-up race: the standard openid/email/profile scope mappings are created by an authentik default blueprint after the API starts answering; the broker captured the list once at bootstrap, so a fresh install could register every provider WITHOUT the email mapping and every sign-in failed with no_email (hit by the v1.0.6 release CI; present since 1.0.0). waitForDefaults now waits for the three mappings, ensureScopeMapping throws rather than cache an incomplete list, the broker repairs already-registered providers at start, and verify reports the drift. v1.0.6 artifacts are functionally fine but its release run is red for this reason.

2026-09-22: client v1.0.8 — step-up re-authentication for products whose sensitive actions demand a fresh factor (Time & Billing's 30-minute step-up gates, decision Q4 there): `GET /auth/oidc/start?reauth=1` requires a current product session and sends `prompt=login&max_age=0`; the callback verifies `auth_time` (≤ `reauthMaxAgeSeconds`, default 120) and that the subject is the identity linked to that session's user, then calls the new optional `SessionAdapter.markStepUp` and audits `vibe.auth.stepup.success` (never creates a session, never provisions). Fake IdP now reports `auth_time` and honours `prompt=login`; React `authClient().reauthPath()`. 54/54 client tests. First consumer: Vibe-Time-Billing (branch `feat/staff-sso`).
