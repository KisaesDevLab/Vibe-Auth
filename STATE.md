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
