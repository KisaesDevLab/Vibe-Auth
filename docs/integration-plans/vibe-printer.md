# Vibe Printer — SSO decision: **do not integrate**

Repo `Vibe-Printer` · slug `vibe-printer` · Python 3.12 / FastAPI · no users, no sessions, no roles · `userFacing: false`, `rootServedOnly: true` · **0 h of product work**.

## Why not

Survey 2026-09-17:

- The only credential is a shared bearer secret compared in constant time (`app/auth.py:52-58`, `VIBE_PRINT_SECRET`, refused-to-boot-if-empty `app/main.py:123-126`). The admin SPA is a secret prompt, not a login (`web/src/App.tsx:24-60`, sessionStorage `vibe_print_secret`).
- There is no user table, no session table and no role model (`app/models.py`, `app/migrations/`). `require_auth` yields an actor string `"secret"` unless Cloudflare Access supplied an identity (`app/deps.py:24-35`).
- Callers of `/v1/print*`, `/v1/jobs/*`, `/v1/printers*` are other machines (`Authorization: Bearer`). They must keep the secret; SSO could only ever cover `/admin` + `/v1/admin/*`, giving one router two parallel auth schemes.
- The SPA's base path is compiled in (`web/vite.config.ts` `base: "/admin/"`), so a callback path cannot be reconfigured at runtime, and in LAN mode the only entry is the emergency port `:5194`.
- Cloudflare Access already occupies the "identity at the edge" slot for `/v1/admin/*` (`app/access.py`, `app/deps.py:38-59`, LAN bypass `:50`). Adding authentik in-app would double it.

The `@kisaesdevlab/vibe-auth` client is Node-only anyway; a Python port for a product with no users is not worth building.

## What to do instead (when the firm asks for "SSO on the printer admin page")

1. **Edge gate, not in-app SSO.** The appliance already supports `sso.edgeGate: true` (Caddy `forward_auth` to authentik's embedded outpost, D10). Set it on the printer manifest with `publicPaths` covering everything machines call:
   ```jsonc
   "sso": { "capable": false, "edgeGate": true,
     "publicPaths": ["/healthz","/readyz","/v1/print","/v1/print/*","/v1/jobs/*","/v1/printers","/v1/printers/*","/v1/version"] }
   ```
   The gate then challenges `/admin/*` and `/v1/admin/*` at Caddy; the secret prompt remains as the second factor. This is opt-in and off by default, and only works on a Caddy-routed surface (domain or Tailscale mode; in LAN mode the printer is reached through the emergency port, which bypasses Caddy by design). The renderer needs a small change to emit the gate for `capable: false` apps; today it keys on `sso.edgeGate` alone (`lib/render-caddyfile.sh` `edge_gate_lines`), so this may already work. Verify with `tests/routing/edge-gate.test.js` before promising it.
2. **Keep Cloudflare Access for tunnel installs.** Nothing changes.
3. **Manifest note.** Add to `_doc` in both manifests: "Identity: machine bearer secret; human admin page is gated at the edge (Cloudflare Access or Caddy forward_auth), never by in-app SSO."

## Effort

Manifest note: 10 min. Edge-gate opt-in verification on the LAN box in Tailscale mode: 1 h, appliance-side only.
