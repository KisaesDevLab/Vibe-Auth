# Client package test matrix (Phase 3 exit)

Run: `pnpm --filter @kisaes/vibe-auth test` (unit + flow against the in-process fake OpenID provider, `test/fake-idp.ts`). Real-IdP coverage: `node test/scripts/integration.mjs` against `test/compose.yml`.

| Plan item | Test | Status |
|---|---|---|
| D1 code + PKCE only | flow: `logs in with PKCE…` asserts `code_verifier` sent; fake IdP refuses non-S256 | ✅ |
| §2.6 discovery via internal base, issuer validated | `internal-base rewrite` ×2 (rewrite + mismatch refused); unit `discovery rewrite` | ✅ |
| §2.6 authorization endpoint never rewritten | `discovers through the internal base…` asserts public authorize URL | ✅ |
| §2.8 boot tolerance | `boot tolerance: unreachable IdP…` (local login works, 503 page, `idp.unreachable` audit) | ✅ |
| ID token validation iss/aud/exp/nonce/at_hash | tokens.ts + flow login; fake IdP signs at_hash; `rejects a replayed/unknown state` | ✅ |
| userinfo fallback | callback merges userinfo when email/roles missing (fake IdP userinfo) | ✅ (exercised when claims absent) |
| Linking (issuer, sub) primary | `logs in… /auth/me lists identity` | ✅ |
| Verified-email link + role sync | `links by verified email…` | ✅ |
| JIT | `logs in with PKCE, JIT-provisions…` | ✅ |
| Unverified denied | `denies unverified email` | ✅ |
| D22 roles claim preferred, groups fallback, default | unit `roles (D22)` ×4 | ✅ |
| `VIBE_OIDC_REQUIRE_MFA_AMR` | `enforces MFA via amr when required` + unit `amr` | ✅ |
| Modes + guards; startup refusal (oidc_only w/o break-glass) | `modes and guards` ×2 | ✅ |
| Break-glass local login audited | `oidc_only… breakglass.used` | ✅ |
| RP-initiated logout | `RP-initiated logout redirects to end_session…` | ✅ |
| Back-channel logout (sid/sub), replay rejected, revocation (D16) | `back-channel logout…`, `rejects logout tokens with a nonce or wrong audience`, unit `revocation list` | ✅ |
| Settings API: authz, validation, secret wrap, mode guards, test-connection, MFA ack (D23) | `settings API` ×2 | ✅ |
| Tauri loopback exchange | `Tauri loopback…` | ✅ |
| Audit events (§5) | asserted throughout via the in-memory sink | ✅ |
| Real authentik: subpath routing, setup wizard, registration, MFA enrolment, TOTP validation, back-channel logout, rotate/verify/rebase | `test/scripts/integration.mjs` | ✅ (see STATE.md for the last run) |
| Entra `kisaes-test` login | Phase 7 (needs H1) | ⏳ |
