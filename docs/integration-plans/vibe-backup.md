# Vibe Backup — SSO decision: **no in-app SSO; the console is its identity boundary**

Repo `Vibe-Backup` · slug `vibe-backup` · Go 1.25, stdlib mux, **`FROM scratch` runtime (no shell)** · no users, sessions, roles or cookies · `userFacing: false`, no Caddy surface · **0.5 h (docs only)**.

## Why not

- The service authenticates nobody by design (`internal/server/server.go:1-5`); every route is public to whoever can reach port 4000, and the only trust boundary is the appliance console's authenticated proxy at `/admin/apps/vibe-backup/` (manifest `_doc`, `docs/operator-quickstart.md:88-92`).
- No user model, no session code, no roles; SSO would mean building an auth layer in Go from nothing, plus an OIDC client, in a binary that must keep working **when the rest of the stack is down** (the manifest's rationale for `depends: []`). An IdP dependency at login would break the disaster scenario the sidecar exists for.
- `FROM scratch`: no shell, so every helper must be a Go subcommand (`cmd/vibe-backup/main.go:29-50`); `docker exec` of anything else is impossible.
- The `@kisaesdevlab/vibe-auth` client is Node-only.

## What the plan is instead

1. **Console proxy remains the gate.** When the console itself gets SSO (a separate appliance item: the console's admin login is basic-auth today), Backup inherits it automatically because every request passes the console's `requireAdmin`.
2. **Manifest note** (both copies), in `_doc`: "Identity: none in-app; reachable only via the console proxy, whose sign-in (local or, later, Vibe Auth) is the control. Do not add `sso`."
3. **README note** in `Vibe-Backup`: same sentence, plus "if you ever expose port 4000 to a network, put an authenticating proxy in front; the appliance never does."
4. **Optional hardening, unrelated to SSO:** bind `VIBE_BACKUP_ADDR` to the `vibe_net` interface only (it already publishes no host port).

## Effort

Two `_doc` edits and a README paragraph: 30 minutes. No release.
