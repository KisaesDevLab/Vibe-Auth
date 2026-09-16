# Phase 7 — compatibility matrix on the office LAN box (H3)

Run by a human on the bare-metal Appliance host. One pass per routing mode; paste each table into `STATE.md`.

## Prepare (once)
1. Reimage the box (Ubuntu 24.04 LTS) and note the reset procedure you used.
2. `git clone` `KisaesDevLab/Vibe-Appliance` branch `vibe-auth-integration` to `/opt/vibe/appliance` and run `bootstrap.sh` in the mode under test.
3. Ensure every product to be tested has a published image whose server contains the `@kisaesdevlab/vibe-auth` package (Trial Balance branch `vibe-auth-integration` builds one; publish it to GHCR or build locally and tag as the manifest `defaultTag`).
4. Copy `test/scripts/phase7.sh` from `Vibe-Auth` to the box.

## Per mode (lan, domain, tailscale)
```
sudo bash phase7.sh --products "vibe-tb"          # add slugs as products are rolled out
```
When the script reports the setup wizard as not done: open the printed URL in a browser, create the first administrator, enrol MFA, then re-run.

Then by hand, in a browser:
| Check | How |
|---|---|
| Console Identity panel shows Vibe Auth healthy and Trial Balance registered | Appliance console → Identity |
| SSO login into Trial Balance in `both` mode → role resolved from group | put your admin in `vibe-partner` → sign in with SSO → role `admin` |
| `oidc_only` → local login refused, break-glass works | `/tb/login/local` with `vibe-breakglass` + password from `sudo vibe credentials` |
| Logout at Authentik terminates the product session | Vibe Auth admin → Users → End sessions → Trial Balance asks to sign in again |
| Edge gate (optional) | set `sso.edgeGate: true` in the manifest, re-enable, confirm webhooks in `publicPaths` still reach the product |
| Memory under a 10-user burst | `docker stats` while 10 users sign in within a minute |
| Authentik upgrade | bump the digest in `apps/vibe-auth.yml`, `sudo vibe update vibe-auth`, confirm blueprints re-apply |

Record results in `STATE.md` under "Phase 7", one table per mode, plus the reset procedure used.
