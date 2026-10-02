# QUESTIONS.md

The Q&A session of 2026-09-16 was folded into the build plan as D25–D30, and the session of 2026-10-02 as D31–D33. Kept for the record.

## Open

- **H1 (Entra tenants)** — deferred, not part of v1 (D26). `docs/entra-setup.md` stays ready.
- **H3 (Phase 7)** — bare-metal box on the office LAN, run by the human with `test/scripts/phase7.sh` (D30, `docs/phase7-checklist.md`). Results to be pasted into `STATE.md`.
- **H4** — runbooks in `docs/firm/runbooks.md` still need execution by a non-author.
- **Follow-up: restore ordering in Vibe Backup** (separate PR in `Vibe-Backup`: ordering field in the contract + multi-module restore).
- **Follow-up: the Appliance verifies break-glass** (D33) — the `oidc_only` guard, the console pill and `identity status` should prove the stored `VIBE_BREAKGLASS_PASSWORD_<SLUG>` signs in, so a product database restore that breaks the pair is caught. Not built yet; lands in `Vibe-Appliance`. Register §A and §D.
- **Follow-up: per-product break-glass factor** (D33) — each plan under `docs/integration-plans/` must state password-only or TOTP at provisioning; Time & Billing's plan must provision a factor.

## Answered 2026-10-02

| Question | Decision |
|---|---|
| Email / SMS codes and regulated products | **Treated as MFA**; no product-side refusal. A firm that needs app/passkey only leaves both off (D31) |
| What should `vibe-it` mean inside products? | **Product administrators**; the "no product access" wording was a documentation error (D32) |
| What does D12 mean for a second factor? | **Per-product policy** stated in each integration plan (D33) |
| Must the Appliance verify break-glass, not just store a password? | **Yes, in scope** — follow-up above (D33) |
| Is Tailscale-mode SSO in scope? | **Not now**; revisit if a firm asks (D33) |
| Directory-driven app access | **Not now**; revisit if a firm asks (D33) |

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
