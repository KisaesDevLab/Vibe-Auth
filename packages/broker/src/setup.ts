import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Authentik } from "./authentik.js";
import type { BootstrapResult } from "./bootstrap.js";
import type { BrokerConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";

/**
 * Setup wizard (D13). No superuser is pre-created; on first visit the broker
 * prompts for firm name + first administrator, gated by a one-time token that
 * is printed to the broker log and exposed to the console (console token).
 */

export interface SetupState {
  done: boolean;
  completedAt?: string;
  adminEmail?: string;
  tokenHash?: string;
}

function hash(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

export class Setup {
  private tokenPlain: string | null = null;
  constructor(
    private cfg: BrokerConfig,
    private db: Db,
    private ak: Authentik,
    private log: Logger,
  ) {}

  async init(): Promise<void> {
    const state = (await this.db.getState<SetupState>("setup")) ?? { done: false };
    if (state.done) return;
    // Token: explicit env wins; otherwise generate once per boot (previous one is invalidated — printed fresh each start).
    this.tokenPlain = this.cfg.VIBE_AUTH_SETUP_TOKEN ?? randomBytes(18).toString("base64url");
    await this.db.setState("setup", { ...state, done: false, tokenHash: hash(this.tokenPlain) });
    this.log.warn("SETUP REQUIRED: open the setup wizard", { url: `${this.cfg.brokerPublicBase}/setup?token=${this.tokenPlain}` });
    process.stdout.write(`\n==================== VIBE AUTH SETUP ====================\nOpen: ${this.cfg.brokerPublicBase}/setup\nOne-time setup token: ${this.tokenPlain}\n=========================================================\n\n`);
  }

  async state(): Promise<SetupState> {
    return (await this.db.getState<SetupState>("setup")) ?? { done: false };
  }

  /** For the console (console-token protected): returns the token while setup is incomplete. */
  async tokenForConsole(): Promise<string | null> {
    const s = await this.state();
    return s.done ? null : this.tokenPlain;
  }

  async verifyToken(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const s = await this.state();
    if (s.done || !s.tokenHash) return false;
    const a = Buffer.from(hash(token));
    const b = Buffer.from(s.tokenHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async complete(i: { token: string; firmName: string; adminEmail: string; adminName: string; password: string }, boot: BootstrapResult): Promise<{ ok: true; loginUrl: string } | { ok: false; error: string }> {
    if (!(await this.verifyToken(i.token))) return { ok: false, error: "invalid_token" };
    if (i.password.length < 12) return { ok: false, error: "password_too_short" };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.adminEmail)) return { ok: false, error: "invalid_email" };

    // Brand — persisted first so a later boot repairs the title even if this patch is lost.
    await this.db.setState("firm", { name: i.firmName });
    const brand = await this.ak.defaultBrand();
    if (brand) await this.ak.patchBrand(String(brand.brand_uuid), { branding_title: i.firmName });
    else this.log.warn("no authentik brand found; title not set", { firmName: i.firmName });

    // First administrator: authentik superuser (via "authentik Admins") + vibe-admin.
    const admins = await this.ak.groupByName("authentik Admins");
    const username = i.adminEmail.toLowerCase();
    let user = await this.ak.userByUsername(username);
    const groups = [boot.groups["vibe-admin"]!, ...(admins ? [admins.pk] : [])];
    if (!user) user = await this.ak.createUser({ username, name: i.adminName, email: i.adminEmail, is_active: true, groups, path: "users", attributes: { "vibe.setup_admin": true } });
    else await this.ak.patchUser(user.pk, { name: i.adminName, email: i.adminEmail, is_active: true, groups: [...new Set([...(user.groups ?? []), ...groups])] });
    await this.ak.setPassword(user.pk, i.password);

    // Neutralise akadmin: keep the account (owns the API token) but make it non-interactive.
    const ak = await this.ak.userByUsername("akadmin");
    if (ak) await this.ak.patchUser(ak.pk, { attributes: { ...(ak.attributes ?? {}), "vibe.service_account": true } });

    await this.db.setState("setup", { done: true, completedAt: new Date().toISOString(), adminEmail: i.adminEmail });
    await this.db.setState("firm", { name: i.firmName });
    this.tokenPlain = null;
    return { ok: true, loginUrl: `${this.cfg.authentikPublicBase}/if/user/` };
  }
}

export function setupPage(o: { basePath: string; token: string; brand: string; error?: string }): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.brand)} — Setup</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1b1f24}@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e6e8eb}}
main{max-width:30rem;width:100%;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12)}@media(prefers-color-scheme:dark){main{background:#181b21}}
h1{font-size:1.3rem;margin:0 0 .25rem}p{line-height:1.5}label{display:grid;gap:.25rem;margin:.75rem 0;font-size:.9rem}input{padding:.5rem .6rem;border-radius:6px;border:1px solid rgba(127,127,127,.4);font:inherit;background:transparent;color:inherit}
button{margin-top:1rem;padding:.6rem 1rem;border-radius:8px;border:none;background:#2563eb;color:#fff;font:inherit;cursor:pointer}.err{color:#dc2626}</style></head><body><main>
<h1>Set up ${esc(o.brand)}</h1><p>Create the firm's first identity administrator. This account can sign in to the Vibe Auth admin console and to every product as <code>vibe-admin</code>. You will be asked to enrol multi-factor authentication on first sign-in.</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<form method="post" action="${esc(o.basePath)}/setup"><input type="hidden" name="token" value="${esc(o.token)}">
<label>Firm name<input name="firmName" required maxlength="80" placeholder="Kisaes CPA"></label>
<label>Administrator name<input name="adminName" required maxlength="80" autocomplete="name"></label>
<label>Administrator email<input name="adminEmail" type="email" required autocomplete="username"></label>
<label>Password (12+ characters)<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
<button type="submit">Create administrator</button></form></main></body></html>`;
}

export function setupDonePage(o: { loginUrl: string; adminUrl: string; brand: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${o.brand} — Setup complete</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:30rem;padding:2rem}a.btn{display:inline-block;margin:.5rem .5rem 0 0;padding:.6rem 1rem;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none}</style></head><body><main><h1>Setup complete</h1><p>Sign in now to enrol MFA, then open the admin console to connect products and identity sources.</p><a class="btn" href="${o.loginUrl}">Sign in</a><a class="btn" href="${o.adminUrl}">Admin console</a></main></body></html>`;
}
