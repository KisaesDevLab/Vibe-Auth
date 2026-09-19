# Vibe 1040 — integration findings (first Fastify consumer)

Written 2026-09-19 from the Vibe 1040 integration (`Vibe-1040` PR #1, branch
`vibe-auth-integration`, package `@kisaesdevlab/vibe-auth` 1.0.4). 1040 is the first product to
mount `vibeAuthFastify`, so some of this is about Fastify and some is simply what the first
consumer with a strict Content-Security-Policy and a mandatory MFA gate ran into.

Status of the integration itself: **implemented, exit gate not met.** Everything below was
found against the package's own code and a fake IdP; no real browser has signed in and no
token has come from a real authentik. See `Vibe-1040/STATE.md`.

Reviewed 2026-09-19 against the package at **1.0.5** (`^1.0.4` resolves to it; the client code is
unchanged since 1.0.3, so every reference below still holds) and against `Vibe-Appliance`. That
review added the last section, [Gaps when this reaches the Appliance](#gaps-when-this-reaches-the-appliance).
The cross-product view — how break-glass behaves in every product and what gets worse as more
products turn on SSO — is in `break-glass-and-rollout-risks.md`.

## Package issues

Ordered by how much they would bite the next product.

### 1. `express` is a required peer dependency

`packages/client/package.json` lists `express >=4.18` under `peerDependencies` with no entry
in `peerDependenciesMeta`, so npm 7+ installs it automatically. In Vibe 1040 that put Express
5.2.1 and roughly sixty transitive packages into a Fastify server's production
`node_modules`, and into `ui/node_modules` as well, because the React entry point lives in the
same package. `dist/index.js`, `dist/cli.js` and `dist/react/index.js` contain no runtime
import of it — only `crypto`, `jose` and `zod` — so it is dead weight in every non-Express
image.

**Suggested fix:** mark it optional, as `react` and `drizzle-orm` already are:
`"peerDependenciesMeta": { "express": { "optional": true } }`. Applies to AI Router and Recap
too. Longer term the React components want their own package; a browser bundle should not
resolve a server framework at install time.

### 2. `login.success` is audited before the session exists, and a throwing adapter is a bare 500

`engine.ts` `handleCallback` emits `vibe.auth.login.success` (`:510`) and only then calls
`session.create()` (`:527`). If `create()` throws, the top-level handler turns it into
`500 {"error":"internal_error"}` (`:306-309`): the audit log says the sign-in succeeded, the
user sees raw JSON on a top-level navigation, and no failure is recorded.

A `SessionAdapter` has legitimate reasons to refuse — 1040's re-checks `amr`, and any product
could hit a unique-constraint or a disabled-since-lookup race. **Suggested fix:** call
`session.create()` inside a try, audit success only after it returns, and route a throw through
the existing `fail()` helper so it gets a `login.failure` row and the HTML error page.
1040 works around it by writing its own failure row from inside the adapter; that leaves a
contradictory success row in front of it.

### 3. The connection-test result page needs an inline script, and builds it unsafely

`pages.ts` `testResultPage` (`:42-52`) reports back to the opener from an inline `<script>`.

- Any product with a CSP that lacks `script-src 'unsafe-inline'` blocks it. 1040's is
  `default-src 'self'` and is not going to be loosened for this. The test still *works* — the
  result is recorded server-side (`lastTestOkAt`) — but the popup never closes and the settings
  page never updates. 1040 re-mounts `AuthSettingsPage` on window focus to compensate.
- The payload is interpolated with `JSON.stringify`, which does not escape `</script>` or
  `<!--`. `message` can carry the IdP's `error_description` query parameter verbatim
  (`handleCallback` → `fail(errParam, query.get("error_description"))`). Reaching it needs a
  live test-login `state`, so it is not readily exploitable, but it is an injection into a
  script context from a URL parameter and should not be there.

**Suggested fix:** drop the inline script. Have the settings page poll `GET /auth/settings`
while the popup is open (the `testLogin` block already carries the result), or serve the
hand-off from a static same-origin `.js` file. If the inline script stays, escape `<` as
`\u003c` in the payload. `loopbackHandoffPage` (`:57`) has the same shape.

### 4. The adapter types are Express types under every framework

`adapters/types.ts` imports `Request`/`Response` from `express` and uses them in
`SessionAdapter` and `TenantResolver`. Under `vibeAuthFastify` the adapter receives the
Fastify request and reply (`fastify.ts:46`, `raw: { req, res: reply }`), so every Fastify
product casts, and the types actively mislead: `res.cookie(...)` type-checks and fails at
runtime where `reply.setCookie(...)` is right. `INTEGRATION-PLAN.md` §3 already says "the raw
objects are typed `never` in the package — cast", which is not quite what the types say.

**Suggested fix:** make the adapter generic over the raw request/response
(`SessionAdapter<Req = unknown, Res = unknown>`) with Express and Fastify aliases exported
beside their respective plugins. That also removes the package's type-level dependency on
Express, which pairs with (1).

### 5. Role sync can lock a firm out, and the adapter cannot veto it

`identity.ts` calls `users.setRole()` whenever the resolved role differs — at `:56-60` for an
identity that is already linked and at `:76-80` for a verified-email link — so it fires on
the *first* SSO sign-in of an existing local account linked by email. If that account is the
firm's only admin and its IdP groups map lower — the seeded admin whose authentik user is in
`vibe-staff`, which is the natural state right after enabling SSO — the sync demotes it and
nobody is left who can open the product's user admin or its Authentication page. In `both`
mode no break-glass account need exist, so recovery is a database edit.

`setRole` returns `void`, so an adapter can only refuse by throwing (which fails the sign-in)
or by silently not writing (after which the engine still audits `role.changed` and returns the
*new* role in the user object). 1040 does the latter, keeps the last active admin's role, and
writes its own `refused: true` row beside the engine's misleading one.

**Suggested fix:** let `setRole` return `boolean | void` (false = kept), audit accordingly, and
consider doing the last-admin check in `linkOrProvision` itself using `adminRole` — every
product has this hole, and T&B/MyBooks have layered permissions that make it harder to see.
This one is worth a line in I8.

### 6. JIT accounts + self-service reset + first-sign-in MFA enrolment = one-factor takeover

Not a package bug, but a consequence of I7 that the plans do not mention and that applies to
any product where (a) local MFA is enrolled at first local sign-in and (b) password reset is
self-service by email — at least 1040 and Time & Billing. A JIT user never enrols a local
factor. In `both` mode, whoever can read that mailbox resets the "unusable" password, signs in
locally, is offered enrolment, and enrols their own authenticator: the mailbox alone yields a
fully MFA-satisfied session, for every JIT user, indefinitely.

1040 refuses self-service reset for an account that has an `auth_identities` row and no local
factor (same response as an unknown address; an admin can still set a password). **Suggested
fix:** add it to the recipe next to I7 — "a JIT account must not be able to bootstrap local
credentials without an admin" — and have each plan say how its product satisfies it.

### 7. Smaller things

- **`start()` returns before discovery.** It does `void this.ensureProvider()` (`:155`), so
  `status().oidc.reachable` is always `false` immediately after `await auth.start()`. 1040
  logged "identity provider NOT reachable" on every healthy boot until this was noticed. Either
  document it on `start()` or offer `await auth.ready()`.
- **`/auth/settings` answers 403 to an anonymous request**, where 401 is the convention and
  what a product's own API usually returns. Harmless, but it surprised a test.
- **The fake IdP is not shipped.** `files` is `dist`, `sql`, `README.md`, so every product
  copies `test/fake-idp.ts` by hand and the copies drift (Trial Balance's says it was synced at
  1.0.1). Exporting it as `@kisaesdevlab/vibe-auth/testing` would remove a file from fifteen
  repositories. 1040's typed port is `Vibe-1040/test/helpers/fake-idp.ts`.
- **`defaultRoleMapFor` maps `vibe-manager` through a "least privileged role" fallback** when
  the vocabulary has none of `manager|reviewer|editor|user`. For 1040 that yields `staff`,
  which is right, but it is an accident of array order rather than a stated rule. 1040 pins
  every group mapping with a test for that reason.

## Corrections to `vibe-1040.md`

Things that plan says about the Vibe-1040 repo that were not so, for whoever reads it next:

| Plan says | Actually |
|---|---|
| §0 Migrations: "drizzle-kit, `src/db/migrate.ts up\|down`" | Hand-written `NNNN_name.up.sql` / `.down.sql` pairs with a hand-written runner; forward **and back** is a P0 exit criterion there. `drizzle-kit generate` is in `package.json` and its output is not what runs. The package SQL was inlined into `0011_vibe_auth.up.sql` so that a package upgrade cannot change an already-run migration |
| §1.8 break-glass: "mark break-glass sessions MFA-satisfied at password login … the plan prefers the latter" | **Declined by the operator, 2026-09-19.** MFA is a locked decision and a GLBA obligation in that repo; a password-only admin path into taxpayer data is what it forbids. Break-glass is a local admin that enrols TOTP through the normal first-sign-in flow. TOTP needs no SMTP, SMS or IdP, so it works in the outage break-glass exists for, provided it is enrolled at provisioning. D12's "no second factor by design" does not hold for this product |
| §1.1 "`VIBE_OIDC_REQUIRE_MFA_AMR=true` … env template default" | Not sufficient on its own: `settings.ts:44` lets a stored `requireMfaAmr` beat the environment, and the settings page offers to turn it off. 1040 forces the env value in code, wraps the settings store to pin it, refuses the `PUT` with `409 mfa_locked`, and re-checks `amr` in the session adapter. The template line is now cosmetic |
| §2.B `findByUsername` → `vibe-breakglass@localhost` (from `INTEGRATION-PLAN.md` §2.B) | `@appliance.local`. 1040's login route validates with zod `.email()`, which rejects a dotless domain |
| §2.A "`^1.0.3`" | `^1.0.4`. The client is byte-identical; what changed in 1.0.4 (`98e0026`) is the **sign-in blueprint** (`deploy/blueprints/20-vibe-flows.yaml`), which makes an MFA-**enrolling** sign-in carry `amr: mfa`. On the Appliance the blueprints are copied out of the broker image by the `vibe-auth-blueprints` one-shot (`Vibe-Appliance/apps/vibe-auth.yml`), so "broker image ≥ 1.0.4" is the right floor there; a standalone install must update its mounted blueprints too. Against an older one, every user's first SSO sign-in to 1040 is refused. Worth stating as a floor for any product that sets `requireMfaAmr`. Nothing enforces it yet (see the last section) |
| §2.E "Surface the callback's error" (implied) | There is nothing to surface: a failed callback renders the package's own HTML error page with a link back to `loginPath`; it does not redirect with `?error=` |
| §2.F both manifests | Only `Vibe-1040/.appliance/manifest.json` was written. The vendored `Vibe-Appliance/console/manifests/vibe-1040.json` and the env template were scoped out by the operator; checklist in `Vibe-1040/docs/sso.md`. Until then 1040 is registered by hand on the appliance too |

## What would make the 1040 exit gate pass

1. Register `vibe-1040` with a broker ≥ 1.0.4, `VIBE_AUTH_MODE=both`, sign in from a real
   browser. This is the first real test of `SameSite=Strict` on the session cookie across the
   redirect back from authentik. The reasoning says it holds — the callback *sets* the cookie
   and nothing needs to *send* one until the SPA's same-origin `/api/me` — but it has not been
   watched.
2. Read the `vibe.auth.login.success` row and record authentik's actual `amr` for TOTP,
   WebAuthn and static recovery codes. If static codes report as a bare `pwd`, a user signing
   in with a recovery code is refused by 1040, which may or may not be what the firm wants.
3. The Vibe-Appliance manifest and env-template change, then `sudo vibe identity register
   vibe-1040` on the LAN box.

## Gaps when this reaches the Appliance

Found 2026-09-19 by reading `Vibe-Appliance` (branch `fix/sso-policy-and-guards`) against this
integration. None of these is a defect in the 1040 code; each is something the Appliance does, or
does not do, once the vendored manifest gains its `sso` block.

1. **Release ordering.** `Vibe-1040` PR #1 is open, the latest 1040 release (v0.9.0) has no SSO,
   and the Appliance manifest pins `defaultTag: latest`. In `lib/identity.sh`, `_id_sso_declared`
   short-circuits the runtime probe: once the manifest says `sso.capable`, `register` succeeds
   against an image that ignores every `VIBE_OIDC_*` line, and the console shows "registered" on
   an app with no SSO. Merge and release 1040 **before** the manifest change lands. There is no
   minimum-app-version gate.
2. **As vendored today, break-glass provisioning fails silently.** `console/manifests/vibe-1040.json`
   has `sso: null`, so `_id_breakglass` falls back to container `vibe-1040-server` and
   `npx vibe-auth …`. Neither exists (the service is `vibe-1040`; there is no `vibe-auth` bin on
   PATH). The failure is swallowed by `|| true` at `identity.sh:415`; registration still logs
   success and the card shows "no break-glass".
3. **Break-glass is provisioned password-only, against the decision recorded above.** `register`
   runs `breakglass ensure` and stores the password in `vibe-auth.env` and `CREDENTIALS.txt`.
   1040 requires that account to enrol TOTP and offers enrolment, at first sign-in, to whoever
   holds the password. Until a person enrols, the stored password alone yields an admin session
   with a self-enrolled factor — item 6's pattern, on the emergency account. Nothing in the
   Appliance prompts for enrolment, and the `oidc_only` guard (`identity.sh:463`) checks only that
   a password string is stored. Enrol the authenticator as part of provisioning, and treat the
   account as unready until that is done.
4. **Config actions restart the whole product.** `register`, `rotate` and `mode` all call
   `_id_recreate`, which force-recreates every service in `apps/vibe-1040.yml`: the
   `vibe-1040-migrate` one-shot re-runs, and the worker and the rasterisation sidecar bounce
   mid-job. Rotating a client secret should not interrupt document processing.
5. **The broker floor is not enforced.** The broker exposes `GET /vibe-auth/version`; the
   Appliance never calls it. An existing box must update Vibe Auth to ≥ 1.0.4 before 1040 is
   registered, or every user's first SSO sign-in is refused.
6. **`ALLOWED_ORIGIN`.** `env-templates/per-app/vibe-1040.env.tmpl` does not render it, and
   `_id_product_base_url` dies without it. This is step 2 of the checklist in
   `Vibe-1040/docs/sso.md`; it is a hard prerequisite, not a nicety.
7. **Per-product access (broker 1.0.5).** An administrator can now restrict which users may sign
   in to a product. 1040 holds taxpayer data and is the obvious product to restrict. The
   restriction gates single sign-on only: in `both` mode a user with a local 1040 password still
   gets in, so the restriction is complete only in `oidc_only`.

Two checks came back clean: 1040's login schema admits the literal `vibe-breakglass` username, so
the credentials the Appliance prints will work; and the break-glass command resolves in the
shipped image (root `package.json` carries `vibeAuth.adapter`, `WORKDIR /app`, compiled `dist/`).
