import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Authentik } from "./authentik.js";
import type { BootstrapResult } from "./bootstrap.js";
import type { BrokerConfig } from "./config.js";
import type { Db } from "./db.js";
import { emailSettingsInput, type EmailConfig } from "./email.js";
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
    private email: EmailConfig,
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

  async complete(
    i: { token: string; firmName: string; adminEmail: string; adminName: string; password: string; smtp?: Record<string, string | undefined> },
    boot: BootstrapResult,
  ): Promise<{ ok: true; loginUrl: string; emailNote: string } | { ok: false; error: string }> {
    if (!(await this.verifyToken(i.token))) return { ok: false, error: "invalid_token" };
    if (i.password.length < 12) return { ok: false, error: "password_too_short" };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.adminEmail)) return { ok: false, error: "invalid_email" };
    // Optional outbound mail: validated before anything is created so a typo cannot half-complete setup.
    let smtp: ReturnType<typeof emailSettingsInput.parse> | null = null;
    if (i.smtp?.host?.trim()) {
      const parsed = emailSettingsInput.safeParse({ ...i.smtp, port: i.smtp.port || undefined, security: i.smtp.security || undefined, from: i.smtp.from || `vibe-auth@${i.adminEmail.split("@")[1]}` });
      if (!parsed.success) return { ok: false, error: `email settings: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}` };
      smtp = parsed.data;
    }

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

    let emailNote: string;
    if (smtp) {
      // Persisted first; a failed authentik patch is retried at the next boot and is not fatal here.
      await this.email.save(smtp, i.adminEmail).catch((e) => this.log.warn("email settings saved but not applied yet", { error: (e as Error).message }));
      emailNote = `Password-reset emails will go out through ${smtp.host}:${smtp.port}. Send yourself a test from the admin console → Email.`;
    } else {
      const status = await this.email.status();
      emailNote = status.configured
        ? `Password-reset emails use the container's mail settings (${status.host}). You can override them in the admin console → Email.`
        : "No outbound email is configured yet: users cannot reset their own passwords until you add a mail server in the admin console → Email. Until then, administrators hand out reset links from the Users page.";
    }
    return { ok: true, loginUrl: `${this.cfg.authentikPublicBase}/if/user/`, emailNote };
  }
}

export function setupPage(o: { basePath: string; token: string; brand: string; error?: string }): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.brand)} — Setup</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1b1f24}@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e6e8eb}}
main{max-width:30rem;width:100%;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12)}@media(prefers-color-scheme:dark){main{background:#181b21}}
h1{font-size:1.3rem;margin:0 0 .25rem}p{line-height:1.5}label{display:grid;gap:.25rem;margin:.75rem 0;font-size:.9rem}input{padding:.5rem .6rem;border-radius:6px;border:1px solid rgba(127,127,127,.4);font:inherit;background:transparent;color:inherit}
button{margin-top:1rem;padding:.6rem 1rem;border-radius:8px;border:none;background:#2563eb;color:#fff;font:inherit;cursor:pointer}.err{color:#dc2626}.muted{opacity:.75;font-size:.85rem}
select{padding:.5rem .6rem;border-radius:6px;border:1px solid rgba(127,127,127,.4);font:inherit;background:transparent;color:inherit}details{margin:1rem 0;padding:.5rem .75rem;border:1px solid rgba(127,127,127,.3);border-radius:8px}summary{cursor:pointer;font-size:.9rem}</style></head><body><main>
<h1>Set up ${esc(o.brand)}</h1><p>Create the firm's first identity administrator. This account can sign in to the Vibe Auth admin console and to every product as <code>vibe-admin</code>. You will be asked to enrol multi-factor authentication on first sign-in.</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<form method="post" action="${esc(o.basePath)}/setup"><input type="hidden" name="token" value="${esc(o.token)}">
<label>Firm name<input name="firmName" required maxlength="80" placeholder="Kisaes CPA"></label>
<label>Administrator name<input name="adminName" required maxlength="80" autocomplete="name"></label>
<label>Administrator email<input name="adminEmail" type="email" required autocomplete="username"></label>
<label>Password (12+ characters)<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
<details><summary>Outbound email for password reset (optional, can be set later)</summary>
<p class="muted">Without a mail server, staff cannot reset their own passwords; administrators hand out reset links instead.</p>
<label>SMTP host<input name="smtpHost" maxlength="253" placeholder="smtp.office365.com" autocomplete="off"></label>
<label>Port<input name="smtpPort" type="number" min="1" max="65535" value="587"></label>
<label>Encryption<select name="smtpSecurity"><option value="starttls">STARTTLS (port 587)</option><option value="ssl">SSL/TLS (port 465)</option><option value="none">None</option></select></label>
<label>Username<input name="smtpUser" maxlength="320" autocomplete="off"></label>
<label>Password<input name="smtpPass" type="password" autocomplete="new-password"></label>
<label>From address<input name="smtpFrom" type="email" placeholder="vibe-auth@firm.example"></label>
</details>
<button type="submit">Create administrator</button></form></main></body></html>`;
}

export function setupDonePage(o: { loginUrl: string; adminUrl: string; brand: string; emailNote?: string }): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(o.brand)} — Setup complete</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:30rem;padding:2rem}p{line-height:1.5}.muted{opacity:.75}a.btn{display:inline-block;margin:.5rem .5rem 0 0;padding:.6rem 1rem;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none}</style></head><body><main><h1>Setup complete</h1><p>Sign in now to enrol MFA, then open the admin console to connect products and identity sources.</p>${o.emailNote ? `<p class="muted">${esc(o.emailNote)}</p>` : ""}<a class="btn" href="${esc(o.loginUrl)}">Sign in</a><a class="btn" href="${esc(o.adminUrl)}">Admin console</a></main></body></html>`;
}
