# Per-product SSO implementation plans

One file per product, each self-contained enough to hand to an engineer (or a Claude Code session) with the repo checked out. They instantiate the shared recipe in `../INTEGRATION-PLAN.md` §2 against each product's actual code, with `file:line` anchors verified on 2026-09-17, and they fold in what the first real appliance run taught us (below). Read `../INTEGRATION-PLAN.md` §1 (rules I1–I14) once; every plan assumes it.

Reference implementation: `trial-balance-app` (Express + stateless JWT). Files to copy from, all on its `main`:

| Concern | File |
|---|---|
| Engine, session adapter, `/auth/*` middleware, local-login policy | `server/src/lib/vibeAuth.ts` (409 lines) |
| User adapter + audit sink | `server/src/lib/vibeAuthUsers.ts` |
| Break-glass CLI adapter | `server/src/vibeAuthAdapter.ts` (31 lines) |
| Migration (package SQL + `auth_sessions_oidc`) | `server/migrations/20260916000001_vibe_auth.js` |
| SPA login flow, `#sso_token` hand-off | `client/src/utils/loginFlow.ts`, `client/src/pages/LoginPage.tsx`, `client/src/pages/AuthenticationSettingsPage.tsx` |
| Private package in a Docker build | `Dockerfile.server` (BuildKit secret `NODE_AUTH_TOKEN`, `server/.npmrc`) |
| End-to-end test against the fake IdP | `test/sso-e2e.mjs` (648 lines), `test/fake-idp.mjs`, `.github/workflows/sso-e2e.yml` |
| Operator note | `docs/sso.md` |
| Manifest `sso` block | `.appliance/manifest.json` and `Vibe-Appliance/console/manifests/vibe-tb.json` |

## Lessons from the first LAN-box run (2026-09-17) that every plan must respect

These are not in `INTEGRATION-PLAN.md`; they were learned enabling Vibe Auth and Trial Balance on `vibebackup01` (Ubuntu 24.04, LAN mode, `http://192.168.68.50`).

1. **Scheme follows the rendered origin.** LAN mode is plain `http://<ip>`; Caddy binds :443 with `tls internal` but its CA never issues a certificate for a bare IP, so `https://<ip>` fails the TLS handshake. Every URL a product builds or registers (`VIBE_OIDC_PUBLIC_URL`, redirect URIs, the issuer, the SPA's callback) must carry the scheme of `ALLOWED_ORIGIN` as rendered, never a hardcoded `https`. Appliance fixes: `lib/identity.sh` (broker origin and product base URL), broker 1.0.2 (`applyApplianceHints`). If your product computes an absolute URL anywhere in the login flow, derive it from `X-Forwarded-Proto` (the package's `requestOrigin` with `trustProxy: true`) or from `VIBE_OIDC_PUBLIC_URL`.
2. **No secure context on the LAN.** WebAuthn/passkeys are unavailable at `http://<ip>`; authentik's MFA enrolment silently offers only TOTP/static there. Do not make a product's SSO session depend on a passkey step. Session cookies must honour the product's existing `SESSION_SECURE`-style switch (Trial Balance: `cookiesAreSecure()`); the appliance renders it `false` in LAN mode.
3. **`Cross-Origin-Opener-Policy` warnings are noise on http.** Helmet-style COOP headers are ignored by browsers on untrustworthy origins and logged to the console. Trial Balance strips the header only on the package's own HTML pages (popup hand-off). Do not chase this warning.
4. **Caddy strips the product prefix, and the `/auth/*` matcher is mandatory when the SPA is a separate container.** The API sees `/auth/oidc/callback`; the browser sees `/<prefix>/auth/oidc/callback`. Engine `basePath: ""`, React `basePath: import.meta.env.BASE_URL`. (The one app that must keep its prefix, the broker, uses the new manifest flag `routing.stripPrefix: false`; products do not.)
5. **Every overlay service must hang off the routed service's `depends_on`.** `enable-app.sh` runs `compose up -d <routed services>`; anything outside that closure never starts. `Vibe-Appliance/tests/compose/overlay-closure.test.js` enforces it. If your product adds a worker for SSO (none should), wire it in.
6. **The DB password extractor reads `DATABASE_URL=`, `DB_PASSWORD=`, any `*_DATABASE_URL=` or `*POSTGRESQL__PASSWORD=`.** A product env template that names its database URL differently must use one of those shapes.
7. **`breakglassCommand` runs inside the shipped image, from its `WORKDIR`.** Trial Balance's is `["node","server/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"]` because its `WORKDIR` is `/app` and the server package lives under `server/`. Verify with `docker run --rm --entrypoint sh <image> -c 'ls <path>'` (or `node -e` on distroless) before committing the manifest. The console token travels on stdin, never argv.
8. **Console images copy the whole directory; guard the require graph.** A new top-level module that is not copied into the image crash-loops the container and aborts bootstrap. Products with hand-listed `COPY` lines in their Dockerfiles have the same exposure: prefer `COPY . ./` + `.dockerignore`, and add a build-time `require.resolve` pass (see `Vibe-Appliance/console/scripts/check-requires.js`).
9. **authentik 2026.8 wants its Base URL.** The appliance seeds `AUTHENTIK_WEB__BASE_URL` and broker 1.0.3 writes the setting. Nothing for products to do; noted so nobody "fixes" it product-side.
10. **Registration only happens on enable or via the Identity panel.** After changing a product's `sso` block, the host needs `sudo vibe identity register <slug>` (or "Fix registration"); a rebuilt image alone does not re-register.

## Order and status

| # | Product | Plan | Variant | Est. | Status |
|---|---|---|---|---|---|
| 0 | Trial Balance | (reference, shipped) | Express + JWT | — | done, image `sha-51331d9` |
| 1 | Time & Billing | `vibe-time-billing.md` | Express + Redis sessions, Tauri | 3–4 h | planned |
| 2 | MyBooks | `mybooks.md` | Express + JWT | 3 h | planned |
| 3 | AI Router | `vibe-ai-router.md` | Fastify + memory sessions | 2 h | planned |
| 4 | Tax Research Chat | `vibe-tax-research-chat.md` | Express + JWT | 2–3 h | implemented on branch `feat/sso-vibe-auth` (`05def3e`, `57dc67e`); not merged, no pull request yet |
| 5 | 1099 | `vibe-1099.md` | Express + Redis sessions | 2 h | planned |
| 6 | Entity | `vibe-entity.md` | Express + Postgres sessions | 2 h | planned |
| 7 | Investments | `vibe-investments.md` | Express + Postgres sessions | 2–3 h | planned |
| 8 | Calculators | `vibe-calculators.md` | Express + Postgres sessions, distroless | 2 h | planned |
| 9 | 1040 | `vibe-1040.md`, findings in `vibe-1040-findings.md` | Fastify + Postgres sessions, MFA gate | 2–3 h | implemented 2026-09-19 (`Vibe-1040` PR #1); **exit gate not met** — no real-browser or real-authentik sign-in yet, appliance manifest pending |
| 10 | Recap | `vibe-recap.md` | Fastify + Postgres sessions | 2 h | planned |
| 11 | Connect | `vibe-connect.md` | Express + express-session, existing OIDC, Tauri | 3–4 h | planned |
| 12 | Backup | `vibe-backup.md` | Go, no auth, console-proxied | 0.5 h docs | decided: no in-app SSO |
| 13 | Payroll & Time | `vibe-payroll-time.md` | Express + JWT, kiosk realm untouched | 4–5 h | planned |
| 14 | Printer | `vibe-printer.md` | no users; edge gate only | 0 h product | decided: no in-app SSO |
| 15 | Transaction Converter | `vibe-transaction-convertor.md` | Express + Postgres sessions, single image | 2–3 h | planned |

Products on a different box from Vibe Auth: see `remote-broker.md` (not supported yet; gap analysis and design).

Each plan ends with the same exit gate (`../INTEGRATION-PLAN.md` §2 "Exit gate per product") plus one appliance check: `sudo vibe identity register <slug>` on the LAN box, then a sign-in in `both` mode, then `oidc_only` with the break-glass login.
