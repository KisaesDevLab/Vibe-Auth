# Products on a different box from Vibe Auth (remote broker)

Status: **not supported today**; this is the gap analysis and the design to close it. Nothing in the per-product plans changes because of it: the product-side contract (`VIBE_OIDC_*` env, `/auth/*` routes, back-channel endpoint) is already location-agnostic. All the work is in the appliance's `lib/identity.sh`, the console's Identity panel, and two small broker changes.

## What breaks today, with the anchors

| Assumption in the code | Where | Why it fails across boxes |
|---|---|---|
| The broker is a local container, reached as `http://vibe-auth:8080` via `docker exec vibe-console curl` | `Vibe-Appliance/lib/identity.sh` `_id_api` (`VA_UPSTREAM`), `_id_va_healthy`, `_id_va_enabled` (reads local `state.json`) | Box B has no `vibe-auth` container and no local state for it |
| The console token comes from the local `vibe-auth.env` | `identity.sh` `_id_console_token` | Only box A has that file |
| Registration always sends `internalUrl` = the product's container name (`http://vibe-tb-server:3001`) | `identity.sh` `_id_registration_body` | authentik on box A posts back-channel logouts to `internalUrl + /auth/oidc/backchannel` (`packages/broker/src/registrations.ts:128`); a container name on box B is unreachable from box A |
| The broker returns `VIBE_OIDC_INTERNAL_BASE = http://vibe-auth-authentik-server:9000` | `registrations.ts:96` | The product on box B cannot reach box A's container network; discovery and token calls must go to the public issuer instead |
| `requires: ["identity"]` orders boot after the local provider | `Vibe-Appliance/bootstrap.sh` capability edges | Harmless (soft), but the product on box B boots with no idea whether the remote broker is up |
| The Identity panel lists "the broker" as the manifest that `provides: identity` on this host | `console/identity.js` | Box B's panel shows Vibe Auth as not installed and disables Register |

## Network and trust prerequisites (no code, just facts)

- **Box B must reach box A's public origin** on the scheme the appliance rendered for box A: `http://<A-ip>` in LAN mode, `https://<A-tailnet-name>` in Tailscale mode, `https://<A-domain>` in domain mode. That is where the issuer (`…/auth/application/o/<slug>/`), discovery, token, JWKS and userinfo endpoints live.
- **Box A's authentik must reach box B's public product URL** for back-channel logout (`https://<B>/tb/auth/oidc/backchannel`). If it cannot, logout at the IdP does not end the product session; the product's own session TTL is the only bound. Acceptable degradation, must be documented per firm.
- **Browsers must reach both boxes**, which they do already; the redirect chain is browser → B → A → B.
- **TLS trust**: Tailscale and domain modes use publicly trusted certificates, so nothing to install. LAN mode is http on both sides; there is no trust problem, only the "no secure context" limitation already noted in the README. Mixed modes (A on Tailscale, B on LAN) work as long as B can resolve A's tailnet name, which requires Tailscale on B, so in practice: put both boxes on the firm's mesh. `docs/multi-box.pdf` in the appliance already tells firms to do exactly that for Sentinel.
- **Clock skew** under a minute between boxes (ID-token `iat`/`exp` and the back-channel logout token).

## Design: "connect this box to a remote Vibe Auth"

Mirrors how a box joins a remote Sentinel (`lib/sentinel-enroll.sh`, console Connect flow): the firm pastes one URL and one token once.

### Appliance (box B)

1. **State.** `state.json` gains `identity: { mode: "remote", brokerUrl: "http://<A>/vibe-auth", origin: "http://<A>" }` and `appliance.env` gains `VIBE_AUTH_REMOTE_CONSOLE_TOKEN` (secret; never logged). `vibe identity connect --broker-url URL` reads the token on stdin; `vibe identity disconnect` reverses it after `disable-all`.
2. **`identity.sh` abstraction.** Replace the three local-only helpers with a resolver:
   - `_id_va_present`: local provider enabled **or** `identity.mode == remote`.
   - `_id_api`: if remote, curl from the console container to `${brokerUrl}${path}` with the remote token; same JSON contract. Keep the stdin token hand-off.
   - `_id_va_healthy`: `GET ${brokerUrl}/health` (served at the base path too) for remote.
   - `_id_va_public_base` / `_id_va_origin` / `_id_va_scheme`: from `state.identity` when remote.
3. **Registration body when remote.** Omit `internalUrl` entirely so the broker's `logout_uri` falls back to `baseUrl + logoutPath` (`registrations.ts:128` already does that when `internalUrl` is null). `baseUrl` is already the product's public origin + prefix.
4. **Env block written to the product.** Drop `VIBE_OIDC_INTERNAL_BASE` when remote (the client treats it as optional: `packages/client/src/config.ts:34`); discovery then uses the public issuer. Everything else identical.
5. **Break-glass** is unchanged: it runs `docker exec` against the product container on box B, which is where the product lives.
6. **Rebase** (`vibe identity rebase`) stays a box-A operation. When box B's own host/IP changes, box B re-registers its products (`register-all`), which updates redirect URIs at the broker; add that to the host-IP-change runbook.
7. **Console Identity panel.** When `identity.mode == remote`, render a "Connected to Vibe Auth at `<origin>`" card with health, in place of the local broker card; Register/Fix/mode buttons work unchanged because they call the same script.
8. **Doctor.** New check: remote broker reachable, and (warn-only) box B's public URL reachable from box A is not testable from B, so print the exact curl for the operator to run on A.

### Broker (box A)

1. **`remote: true` on a registration** (schema: `packages/broker/src/registrations.ts` input). Effect: (a) never persist or return an `internalUrl`; (b) omit `VIBE_OIDC_INTERNAL_BASE` from the env block; (c) label the application group "Vibe (remote)" so the admin console shows which products live elsewhere. Without the flag, behaviour is unchanged.
2. **Console tokens per box** (optional, second step). Today one console token registers everything. Issue a per-box registration token from the broker admin console (`/vibe-auth/admin` → Boxes → "New box"), scoped to `registrations` for that box's slugs, revocable. Until then the firm shares box A's console token with box B, which is acceptable inside one firm's mesh but should be replaced.
3. **Verify** (`GET /registrations/verify`) already probes authentik state; extend it to attempt a `HEAD` on each remote product's `baseUrl + /auth/status` so the admin console can show "unreachable from the identity box" per product.

### Product side

Nothing. The `@kisaesdevlab/vibe-auth` client already:
- uses the public issuer when `VIBE_OIDC_INTERNAL_BASE` is unset (`discovery.ts`),
- builds redirect and logout URIs from `VIBE_OIDC_PUBLIC_URL`,
- accepts back-channel logout from any address (no IP allow-list; the logout token is signature-verified).

One caveat for stateless-JWT products (Trial Balance, MyBooks, Tax Research Chat): revocation is local to the product's database, so a lost back-channel call is not recoverable later; the token simply expires. Server-side-session products behave the same way. Document, don't engineer around.

## Effort

Appliance: about a day including tests (`tests/console/identity-script.test.js` gains a remote fixture; `identity.test.js` covers the panel card). Broker: half a day for `remote: true` and the env-block change, plus a config unit test; per-box tokens are a separate half day. No product release is required.

## Interim manual procedure (works now, unsupported)

For a test on two boxes before the above ships:

1. On box A: `sudo grep VIBE_AUTH_CONSOLE_TOKEN /opt/vibe/env/vibe-auth.env`.
2. From box B, register by hand (replace values; `baseUrl` is B's public product URL):
   ```
   curl -X POST http://<A>/vibe-auth/registrations -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
     -d '{"slug":"vibe-tb","displayName":"Vibe Trial Balance","baseUrl":"http://<B>/tb","redirectPaths":["/auth/oidc/callback"],"logoutPaths":["/auth/oidc/backchannel"],"publicPaths":[]}'
   ```
3. Append the returned `VIBE_OIDC_*` lines to `/opt/vibe/env/vibe-tb.env` on B, **omitting `VIBE_OIDC_INTERNAL_BASE`**, then `cd /opt/vibe/appliance && sudo docker compose -f docker-compose.yml -f apps/vibe-tb.yml up -d --force-recreate vibe-tb-server`.
4. Provision break-glass on B: `docker exec -i vibe-tb-server node server/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass ensure --json`, store the password.
5. Flip the mode in Trial Balance's Settings → Authentication (the console's mode button on B will refuse until the remote design lands, because it cannot see a broker).
