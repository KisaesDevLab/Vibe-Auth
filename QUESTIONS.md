# QUESTIONS.md

All items were answered in the Q&A session of 2026-09-16 and folded into the build plan as D25–D30. Kept for the record.

## Open

- **H1 (Entra tenants)** — deferred, not part of v1 (D26). `docs/entra-setup.md` stays ready.
- **H3 (Phase 7)** — bare-metal box on the office LAN, run by the human with `test/scripts/phase7.sh` (D30, `docs/phase7-checklist.md`). Results to be pasted into `STATE.md`.
- **H4** — runbooks in `docs/firm/runbooks.md` still need execution by a non-author.
- **Follow-up: restore ordering in Vibe Backup** (separate PR in `Vibe-Backup`: ordering field in the contract + multi-module restore).
- **What should `vibe-it` mean inside products?** (raised 2026-09-19, v1.0.5) — The firm guide and the `10-vibe-groups.yaml` description said "Vibe Auth administration only, no product access", but `defaultRoleMapFor()` in `packages/client/src/config.ts` maps `vibe-it` to each product's **administrator** role and every plan under `docs/integration-plans/` repeats that. Nothing ever enforced "no product access"; D22 only lists the group. Decide: (a) IT staff are product administrators and the old wording was a documentation error (the guide now says this), or (b) drop `vibe-it` from the default role map (client package change, twelve integration plans, behaviour change for anyone relying on it). Until decided, per-product access gives firms the practical control: restrict a product and do not tick IT staff.
- **Directory-driven app access** (raised 2026-09-19) — v1.0.5 assigns apps per user in the console only. Letting Entra/Google group names drive `vibe-app-<slug>` membership is possible but must be all-or-nothing per product, because a source-linked group is stripped from federated users whose directory does not send it. Not built; ask if a firm wants it.
- **What does D12 mean for a second factor?** (raised 2026-09-19) — D12 says nothing about MFA. Trial Balance and 1099 provision a password-only break-glass account; 1040's operator declined that (GLBA) and requires TOTP; Time & Billing's mandatory second factor leaves a factor-less break-glass account unable to sign in at all. Decide: one suite-wide rule (password-only, or TOTP enrolled at provisioning), or a per-product policy that each plan must state. See `docs/integration-plans/break-glass-and-rollout-risks.md` §B.
- **Must the Appliance verify break-glass, not just store a password?** (raised 2026-09-19) — Today the `oidc_only` guard, the console pill and `identity status` test only for a non-empty `VIBE_BREAKGLASS_PASSWORD_<SLUG>`; a product database restore silently breaks the pair and nothing notices. Register §A and §D.
- **Is Tailscale-mode SSO in scope?** (raised 2026-09-19) — It cannot work today: origins render as `http://<default-route-ip>` while the browser is on the tailnet HTTPS name, so sign-in fails on redirect mismatch. Register §C item 5.

## Answered 2026-09-16

| # | Question | Decision |
|---|---|---|
| Q1–Q5 | Phase 0 unknowns (secret injection, JWT sessions, Connect keys, LAN routing, Redis) | Resolved by discovery — COMPAT.md |
| Q6 | Phase 7 hardware | Bare-metal LAN box; human runs `phase7.sh` (D30) |
| Q7 | D9 premise false (subpath supported) | **Subpath `/auth/` is the default**; `:8443` kept as `port` profile (D9 revised) |
| Q8 | `sentinel-core` bundles Authentik | **Vibe Auth is the only IdP**; Sentinel consumes it (D25) |
| Q9 | Vibe Backup has no restore ordering | Accept runbook for v1; **follow-up PR** to add ordering |
| Q10 | Console uses shared Basic auth | Stays for v1 |
| Q11 | LAN internal CA not distributed | Accept per-device click-through (D29) |
| Q12 | Entra tenants (H1) | **Not for v1** (D26) |
| Q13 | MyBooks `user_type='client'` | **Denied** SSO (D5/D29) |
| Q14 | Default role maps | Confirmed (D29) |
| Q15 | Sentinel has no audit-ingest endpoint | Added in the **Sentinel roll-out** (Phase 8 step 7, D25) |
| Q16 | Tauri loopback plugin | Use `@fabianlars/tauri-plugin-oauth` (D29) |
| Q17 | Artifact owner | **KisaesDevLab** (D27) — renamed everywhere |
| Q18 | `oidc_only` guard split console/product | Accepted (D28) |
| Q19 | Sibling-repo changes | **Committed on `vibe-auth-integration` branches** |
| Q20 | Pre-existing failing Appliance test on Windows | Ignore |
