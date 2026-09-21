# Break-glass and rollout risks — cross-product register

Written 2026-09-19 from three read-only surveys: the break-glass mechanism end to end (client
package 1.0.5, `Vibe-Appliance` branch `fix/sso-policy-and-guards`), every product repository on its
checked-out branch, and the Appliance's behaviour as more products turn on single sign-on. Nothing
here was changed in code; **section D lists the work, by owner.** File and line references are to
the sibling repositories under the same parent directory as `Vibe-Auth`.

Read this before starting any remaining Phase 8 product, and before switching any product to
`oidc_only`.

**The short version**

- The shared recipe told email-login products to map `vibe-breakglass` to
  `vibe-breakglass@localhost`. That address fails login validation in **seven of the nine**
  remaining products. All three implemented email-login products (1099, 1040, Tax Research Chat)
  independently chose a dotted domain instead. The recipe is corrected as of this commit
  (`../INTEGRATION-PLAN.md` §2.B).
- The Appliance never verifies a break-glass account. Its `oidc_only` guard, its status pill and
  `identity status` all test one thing: that a password **string** is stored in `vibe-auth.env`.
- Several Appliance behaviours are O(number of SSO products): restarts, outages and breakage on an
  address change all scale with the rollout.

---

## A. How break-glass actually works

### In the client package

`packages/client/src/breakglass.ts`, `cli.ts`, `engine.ts`.

| Command | Account missing | Account exists, active | Account exists, inactive |
|---|---|---|---|
| `ensure` | creates it, **returns the password** | returns `status: "exists"`, **no password, no change, no audit** | reactivates and sets a new password only if the adapter implements `setActive`; otherwise stays disabled and reports `exists` |
| `rotate` | behaves as `ensure` | always sets and returns a new password | same, and reactivates |
| `status` | `{exists:false}` | `{exists, active, userId, role}` — never checks the password | same |

- The password is generated once (`randomBytes(24)`, ~32 URL-safe characters) unless
  `VIBE_BREAKGLASS_PASSWORD` is set in the container, in which case that value is used verbatim.
- The account is identified by **username** (`VIBE_BREAKGLASS_USERNAME`, default `vibe-breakglass`).
  Its email defaults to `${username}@localhost` unless the CLI adapter sets `breakglassEmail`
  (`breakglass.ts:51`, `cli.ts:71`). It gets the product's `adminRole`.
- The CLI finds the product's adapter through `VIBE_AUTH_ADAPTER`, else `package.json` →
  `vibeAuth.adapter`, **both resolved from `process.cwd()`** (`cli.ts:32-51`). It parses the full
  env schema first, so a malformed `VIBE_OIDC_*` value makes it throw before touching the database.
- `engine.start()` throws in `oidc_only` when the account is missing or inactive
  (`engine.ts:143-153`). It checks existence only, never the password.
- The product must call two hooks. `localLoginAllowed(identifier)` admits only the break-glass
  **username** in `oidc_only` (`engine.ts:246-251`). `afterLocalLogin(...)` audits
  `vibe.auth.breakglass.used` only when `username ?? email` equals that username
  (`engine.ts:254-259`). **An email-login product that passes only the email never emits the
  event** unless it maps the address back to the username. All three implemented email-login
  products do this by hand.
- Nothing in the package mentions a second factor for break-glass. **D12 as written says nothing
  about MFA** (`VIBE-AUTH-BUILD-PLAN.md`, D12). The phrase "no second factor by design" exists only
  in `vibe-1040-findings.md`, where the operator declined it.

### In the Appliance

`Vibe-Appliance/lib/identity.sh:306-336` (`_id_breakglass`), `:446-470` (`id_mode`),
`console/identity.js`, `console/ui/static/identity.js`, `lib/secrets.sh:606-634`.

- `register` runs `docker exec -i <sso.breakglassService> <sso.breakglassCommand>` from the
  **vendored** manifest (`console/manifests/<slug>.json`), falling back to `<slug>-server` and
  `npx vibe-auth breakglass ensure --json`. A returned password is stored as
  `VIBE_BREAKGLASS_PASSWORD_<SLUG>` in **`vibe-auth.env`** and archived in `CREDENTIALS.txt`.
- A failure is swallowed: `_id_breakglass "$slug" ensure || true` (`identity.sh:415`), followed by
  an unconditional "registered" success line. The JSON parse is also `|| true`, so any non-JSON
  stdout is indistinguishable from "already exists".
- The `oidc_only` guard (`:463-464`), the console pill (`identity.js:123-125`) and `id_status`
  (`:383`) all test a **non-empty env value**. Nothing asks the product whether the account
  exists, is active, is an admin, or whether that password authenticates. The Appliance never
  runs `breakglass status`.
- `rotate-breakglass` is shell-only (`sudo vibe identity rotate-breakglass <slug>`). There is no
  console route and no button. It works by replacing the literal token `ensure` in the manifest's
  argv, so a command without that token can never be rotated.
- `disable` and `unregister` remove **neither** the stored password **nor** the account. A
  product with SSO disabled keeps an active local admin with a live password, and the pill keeps
  saying "break-glass ready".
- The banner and `CREDENTIALS.txt` print `username: vibe-breakglass` and **no email address**.

**Consequence: password and account drift apart silently.** The password lives in `vibe-auth.env`;
the hash lives in the product database. Restore an older product database, or run
`update.sh --rollback --with-db`, and they no longer match. `ensure` cannot repair this (the
account exists, so it returns `exists`). The Appliance still shows "break-glass ready" and still
permits `oidc_only`. If the account is gone entirely, the product refuses to start on its next
restart (`engine.ts:148`). The only repair for absence is `identity register <slug>`; the only
repair for a mismatched password is the shell-only `rotate-breakglass`.

---

## B. Break-glass, product by product

### Implemented

| | Trial Balance (`vibe-tb`, merged) | 1099 (`vibe-1099`, merged) | 1040 (branch, PR #1 open) | Tax Research Chat (branch `feat/sso-vibe-auth`) |
|---|---|---|---|---|
| Sign in as | username `vibe-breakglass` | **`vibe-breakglass@vibe-1099.local` only**; the bare username is a 400 from zod (`apps/api/src/routes/auth.ts:33`) and nothing prints the address | the literal username or `vibe-breakglass@appliance.local` (`src/api/routes.ts:93`) | `vibe-breakglass@vibe-tax.local`, mapped by `localLoginIdentifier()` |
| Second factor | firm flag, **default off** → password only; when on, break-glass enrols like anyone | per-user opt-in TOTP, off → **password only** (stated in the adapter) | **mandatory, not exempt**; enrols TOTP at first sign-in; **nothing enrols it at provisioning** | — not surveyed in depth |
| Self-service reset | by **username or email**, no guard; **JIT accounts fully resettable** (`passwordReset.ts:110-114`) | by email, no guard; JIT reset is intentional (`vibeAuthUsers.ts:72`) | **JIT refused** (`isSsoOnlyAccount`); break-glass is not refused by rule, only by its undeliverable domain | — |
| Admin can disable or demote it | yes; only a self-deactivation guard (`routes/users.ts:189-192,265-268`). An admin-set password also forces `must_change_password` | yes, **no guard at all**; changing its email breaks `findByUsername` | **409 `breakglass_required`**, but only while mode is `oidc_only` (`admin-routes.ts:182-197`); `set-password` unguarded | — |
| Command resolves in the image | yes; image sets `VIBE_AUTH_ADAPTER` because cwd `/app` cannot see `server/package.json` | yes; needs `--import tsx`; image sets `VIBE_AUTH_ADAPTER` | yes in the image, **no on the Appliance today**: vendored manifest has `sso: null` → wrong container, `npx`, failure swallowed | — |

### Remaining

"Rejects" means the product's own login validation refuses the identifier before any password
check. Anchors are in the product repository named in the first column.

| Product | Identifier vs `vibe-breakglass` / `@localhost` | Local MFA | JIT account can bootstrap local credentials from its mailbox | Traps for the break-glass row | Command / image |
|---|---|---|---|---|---|
| **Time & Billing** | **Rejects both**: regex requires a dotted domain (`apps/api/src/auth/staff-routes.ts:80`) | **Mandatory, fails closed** (`second-factor-policy.ts:15-29`). A factor-less account gets `no_factor_enrolled` and is told to use a **magic link** (`staff-routes.ts:604-609`), which needs SMTP and a real mailbox | yes (`/password/forgot` `:314`, magic link `:154`) | **Redis is on the login path**; admin routes need a fresh step-up factor | pnpm; path plausible, verify in the built image |
| **MyBooks** | **Rejects**: zod `.email()` (`packages/shared/src/schemas/auth.ts:14`) | optional per user; **email-OTP fallback** when enabled with no method (`tfa.service.ts:54-65`) | yes (`auth.routes.ts:305`, magic link) | **Permanent lockout after 5 failures** for anyone who is not `is_super_admin` (`auth.service.ts:435,450-457,487`); break-glass is `owner`, and an SSO-provisioned `owner` is not a super-admin either, so nobody can unlock it | verify against `packages/api/Dockerfile`; the root Dockerfile is not what CI publishes |
| **AI Router** | **Rejects**: `z.string().email()` (`src/admin-api/routes.ts:186`) | none | no (change-credentials needs the current password) | sessions are in memory and die on restart; **no recovery path of any kind** if the single admin is demoted | fits the layout |
| **Entity** | **Rejects**: `z.string().email()` (`apps/api/src/routes/auth.ts:14`) | none | yes, via magic link (`:126,147`) | **`passwordResetRequired` defaults true** in the column and in `createUser` (`schema/users.ts:19`, `auth-service.ts:252`); `ensureAdminSeed` can re-arm it | fits; adapter key must be in the deployed `apps/api/package.json` |
| **Investments** | **Rejects**: `z.string().email().max(254)` (`apps/api/src/routes/auth.ts:34`) | optional TOTP | no reset route at all | **`checkBruteForce` is awaited unguarded** (`routes/auth.ts:67`): a Redis outage takes break-glass down | `WORKDIR /repo/apps/api`, modules at `/repo`; use the absolute path the plan already gives as fallback |
| **Calculators** | **Rejects**: `z.string().email()` (`apps/api/src/routes/auth.ts:41`) | optional TOTP | yes, via magic link (`:194,245`) | **`mustChangePassword`** is a hard SPA gate (`apps/web/src/auth/guards.tsx:27,48`) | **distroless, no shell**: only verifiable with `docker run --entrypoint /nodejs/bin/node`; prefer the absolute path the repo's own migration command uses |
| **Recap** | accepts (`z.string().max(200)`, `apps/api/src/routes/auth.ts:49`) | none | yes, SMTP-gated (`:186-208`) | `mustChangePassword`; temporary lockout only | **the plan's relative path was wrong**: the entrypoint does `cd /app/apps/api` and modules exist only at `/app/node_modules` (corrected in `vibe-recap.md`) |
| **Payroll & Time** | **Rejects**: `z.string().email().max(254)` (`shared/src/schemas/auth.ts:30`) | none | **yes, twice** (magic `:141`, reset `:166`) | `password_hash varchar(72)` holds bcrypt but not argon2id | tsx-only image; the plan's `--import tsx/esm` shape is right |
| **Connect** | **accepts natively**: username login (`apps/server/src/routes/auth.ts:15`) | none | no (admin-only reset) | none found | fits. SSO itself is blocked first: `validateIssuerUrl` rejects `http://` and RFC 1918 issuers (`routes/oidc.ts:67-128`), i.e. the Appliance's own IdP on a LAN box |
| **Backup** | n/a — `FROM scratch`, no users; the console proxy is the boundary | | | | |

### What every remaining integration must do

1. **Use a dotted break-glass domain** and admit the literal username in login validation, then
   map the address back to the username for both engine hooks (`../INTEGRATION-PLAN.md` §2.B).
2. **Create the break-glass row usable**: active, not locked, forced-change flags cleared
   (Entity, Calculators, Recap), and in MyBooks with `is_super_admin` or an equivalent that a
   lockout cannot make permanent.
3. **Decide the second-factor policy per product and write it down.** Password-only is what Trial
   Balance and 1099 do today. 1040 requires TOTP, which works during an outage only if enrolled at
   provisioning. **Time & Billing cannot work either way as the code stands**: it needs an exemption
   or an enrol-at-provisioning step, because its only factor-less path is an emailed link.
4. **Guard the account in the admin UI** against disable, demote and re-address, in every mode,
   not only in `oidc_only`.
5. **Close the JIT takeover** (findings item 6): an SSO-created account must not obtain local
   credentials from its mailbox. Eight products are exposed today, including the two merged ones.
6. **Pass an explicit `defaultRoleMap`.** `defaultRoleMapFor` matches case-sensitively and falls
   back to the **least** privileged role (`packages/client/src/config.ts:112-123`):

   | Product | `vibe-manager` | `vibe-staff` | `vibe-partner` | Plan wants |
   |---|---|---|---|---|
   | Investments | `READ_ONLY` | `READ_ONLY` | `ADMIN` | MANAGER / PREPARER / ADMIN |
   | MyBooks | `readonly` | `readonly` | `owner` | accountant / bookkeeper / owner |
   | Entity | `viewer` | `staff` | `admin` | staff / staff / admin |
   | **Payroll & Time** | `employee` | `employee` | **`super_admin`** | supervisor / employee / company_admin |

   Payroll's is the dangerous direction: every partner becomes an appliance super administrator.
7. **Protect the last admin from role sync** (findings item 5). Most exposed: AI Router (one
   bootstrapped admin, no recovery path), Connect (`setRole` is specified to demote `is_admin`),
   Investments (one seeded admin, recovery is SQL), Payroll & Time.

### Plan errors found along the way

- **Payroll & Time**: `users.id` is `bigIncrements`, not uuid, and `disabled_at` already exists
  (`backend/migrations/20260420000002_users.js:11,23,27`). Corrected in `vibe-payroll-time.md`.
- **Payroll & Time, found while implementing (2026-09-20)**: the prescribed `/auth/*` matcher would have broken every emailed login and
  reset link (the SPA owns `/auth/magic`, `/auth/reset`); and provisioning break-glass before the first-run wizard bricks setup, because any
  `super_admin` row locks it. Both are now README lessons 11 and 12 and should be checked on every remaining product.
- **Recap**: command path, above. Corrected in `vibe-recap.md`.
- **Entity**: a dormant bearer-only OIDC stub (`apps/api/src/auth.ts:19-57`) replaces cookie auth
  entirely if `VIBE_APPLIANCE_OIDC_ISSUER` is ever set. The plan deletes it; do that first.
- **Tax Research Chat** was listed as "planned" but is implemented on a local branch.

---

## C. Appliance risks

### That get worse with every SSO product

1. **Serial restart storms.** `_id_recreate` force-recreates a product and waits up to 120 s for
   health. `register-all`, `disable-all` and `rebase` are loops over it
   (`lib/identity.sh:493-535`). Disabling Vibe Auth runs a full `disable-all` inside the disable of
   one app (`lib/disable-app.sh:86-93`). Bootstrap and mode switches recreate each SSO product
   **twice** (once by `enable_app`, once by its register hook, `lib/enable-app.sh:328-350`).
2. **Configuration actions re-run migrations and bounce workers.** `_overlay_services` returns
   every service in the overlay, one-shots included, and `register`, `rotate`, `disable`, **`mode`**
   and `rebase` all recreate them. Affected: 1040 (migrate one-shot, worker, sidecar), Recap
   (migrate, worker), Time & Billing (an init one-shot that `rm -rf`s a static volume the web
   container is serving live, plus migrate-then-serve and a worker). Adoption is automatic: any
   enabled app that answers `/auth/status` enters the set through `_id_sso_detected`, with no
   manifest change.
3. **One address change breaks every product at once, silently.** In LAN mode a DHCP move updates
   `state.config.host_ip` and nothing else (`console/server.js:599-612`; the comment explaining why
   predates SSO). Every product's `ALLOWED_ORIGIN`, the broker's host and every registered redirect
   URI keep the old address, so every SSO sign-in fails on redirect mismatch. `rebase` is manual
   (one console button); nothing detects the drift. `oidc_only` products are down to break-glass.
4. **Updating Vibe Auth is an N-product sign-in outage.** `update.sh` has no identity awareness at
   all. It stops all four Vibe Auth services, migrates and waits up to 300 s for health. Products
   in `oidc_only` are break-glass-only for that window; nothing warns the operator.
5. **Tailscale mode cannot do SSO today.** Origins render as `http://<default-route-ip>`
   (`lib/enable-app.sh:1291-1293`; `_host_ip_effective` never returns the tailnet name, although
   `state.config.tailscale_hostname` is cached). The browser is on `https://<host>.<tailnet>.ts.net`
   through `tailscale serve`, and Caddy binds `127.0.0.1` there. Registration therefore records
   redirect URIs on a host the browser is not using, and sign-in fails on **redirect mismatch**
   before cookies matter. The setup-wizard link is unopenable for the same reason. Root-served
   products register a second shape again (`http://<ip>:<emergencyPort>`).
6. **An un-backed-up single point of failure.** `/opt/vibe/env/vibe-auth.env` holds
   `VIBE_AUTH_SECRET_KEY` (loss orphans every stored client secret), the console token and **every
   product's break-glass password**. It is deliberately excluded from the Vibe Backup set
   (`env-templates/per-app/vibe-backup.env.tmpl:32-43`), as is `CREDENTIALS.txt`. The stated
   fallback is a Duplicati job the operator must create by hand.
7. **`VIBE_AUTH_MODE` survives an env re-render only by accident.** No template names it and it is
   not an operator-owned key (`lib/operator-keys.sh`). The day a product template adds
   `VIBE_AUTH_MODE=local` as a documented default, every re-render drops that product out of
   `oidc_only`.
8. **No version floors.** The broker's `GET /vibe-auth/version` is never called, and every
   manifest pins `defaultTag: latest`.

### Per-product one-offs

- **Declared but absent SSO.** A manifest with `sso.capable` against an image that predates SSO
  registers successfully and shows "registered"; only the swallowed break-glass warning hints at it.
- **Missing `ALLOWED_ORIGIN`** makes `register` die. Templates without it: `vibe-1040`,
  `vibe-ai-router`, `vibe-connect`, `vibe-time-billing` (renders it as `APP_BASE_URL`),
  `vibe-printer`, `vibe-backup`. **Missing `VITE_BASE_PATH`** is harmless for root-served apps and
  silently wrong for a path-mounted one.
- **`sso.edgeGate` gates nothing for root-served apps outside domain mode.** Their only surface is
  an HAProxy emergency port with no auth hook (`lib/render-haproxy.sh:132-305`); in domain mode the
  vhost is gated while the emergency port stays open behind the firewall alone. `false` everywhere
  today.
- **Trial Balance declares no operator policy keys**, so it has no MFA or JIT policy to preserve
  across `disable`.
- **Per-product access (broker 1.0.5) is not wired into the Appliance.** The console-token routes
  `GET|PUT /vibe-auth/registrations/:slug/access` are never called. A control would sit beside
  `id_mode` in `lib/identity.sh`, beside the `mode` route in `console/identity.js`, and beside the
  sign-in mode select in `console/ui/static/identity.js`. It is the one identity action that needs
  no container recreate.

---

## D. Follow-up work, by owner

### Status, 2026-09-20

Most of this list was built the day after it was written. **Nothing below is merged or released
except the client package commit on `Vibe-Auth` main**; every other item sits on a pushed branch
waiting for review.

| Where | Branch | What landed | Tests run |
|---|---|---|---|
| `Vibe-Auth` client | `main` (v1.0.6 in `package.json`, **not tagged**, so not on npm) | items 1–5 below | 50 client, 28 broker |
| `Vibe-Appliance` | `feat/identity-full-management` | items 1, 2, 3 (detect + one-click re-apply), 6, 7, 8 below; Tailscale is refused rather than fixed (4); backup (5) not done | 62 identity, full suite 261/262 (one pre-existing Windows CRLF failure) |
| Trial Balance | `fix/sso-hardening` | break-glass protected in every mode, no forced change on admin set, SSO-only accounts cannot self-reset (`sso_only_since`), last-admin guard, explicit role map | 339 unit, 18-step e2e |
| 1099 | `fix/sso-hardening` | bare `vibe-breakglass` accepted at login, protection incl. re-address, SSO-only reset refused, last-admin guard, role map pinned | 178 unit, 19-step e2e |
| 1040 | `vibe-auth-integration` (PR #1) | guard in every mode, reset refused by rule, readiness command `node dist/auth/breakglass-status.js` | 290 |
| Tax Research Chat | `feat/sso-vibe-auth` | bare username at login, protection, SSO-only reset refused (`has_local_password`), last-admin guard | 448 api (e2e not run: no database) |
| Sentinel | `vibe-auth-integration` | address moved off `@localhost`, bare username at login, protection, last-admin guard, rule `SENT-V-AUTH-005` | 257 (nothing database-backed was run) |

Still open after that: the nine products in section B that have not started; Tailscale-mode
origins; `vibe-auth.env` in a working backup path; per-box console tokens and remote brokers
(`remote-broker.md`); the three decisions in `../../QUESTIONS.md`. Found along the way and **not**
fixed: Trial Balance's `PATCH /users/:id` without an `email` field nulls the user's email (the UI's
Reactivate button does exactly that); its password-reset lookup lets an inactive user match by
username; Tax Research Chat's login rate limiter has no pass-on-store-error, so a Redis outage
blocks break-glass too; Sentinel's `Dockerfile.node` runs Node 20 with `--experimental-strip-types`.
No path forwards a product's own `vibe.auth.breakglass.used` event to the broker: Sentinel sees it
only through that product's own log shipping.

### The list as written on 2026-09-19

Order within each list is by how much it would bite.

**Client package (`Vibe-Auth/packages/client`)**
1. Break-glass email default that passes validators (a dotted domain), and compare
   `username` **or** the break-glass email in `afterLocalLogin` so the audit event cannot be lost.
2. `defaultRoleMapFor`: match case-insensitively and refuse to guess (no fall-back to the least
   privileged role); log which groups were unmapped.
3. Last-admin protection in `linkOrProvision`, and let `setRole` report a refusal.
4. Audit `login.success` only after `session.create()` returns; route a throw through `fail()`.
5. Optional Express peer; framework-neutral adapter types; drop the inline script from
   `testResultPage` and escape `<` in any payload that remains; ship the fake IdP as
   `@kisaesdevlab/vibe-auth/testing`; offer `await auth.ready()`.

**Appliance (`Vibe-Appliance`)**
1. Verify break-glass instead of trusting a stored string: run `breakglass status` in
   `id_status` and the `oidc_only` guard; surface a swallowed provisioning failure as a failed
   registration; add a console rotate action; re-run `ensure` and compare after a product
   restore or rollback.
2. Recreate only the service that serves `/auth/*`, not the whole overlay.
3. Re-derive issuers automatically when `host_ip` changes, or at least flag the drift in the
   console and in `doctor.sh`.
4. Make Tailscale-mode origins the tailnet HTTPS name, for products and for Vibe Auth.
5. Put `vibe-auth.env` and `CREDENTIALS.txt` in a backup path that works.
6. Broker and app version floors; make `VIBE_AUTH_MODE` an operator-owned key; warn before
   updating Vibe Auth while any product is in `oidc_only`.
7. Print the full break-glass sign-in identifier, not just the username.
8. Wire per-product access into the Identity page.

**Each product plan** — items 1 to 7 of "What every remaining integration must do", plus the
product-specific trap in the table above. Trial Balance and 1099, already merged, need items 4
and 5 retrofitted.

**Decisions needed** — recorded in `../../QUESTIONS.md`: what D12 means for a second factor;
whether the Appliance must verify break-glass; whether Tailscale-mode SSO is in scope.
