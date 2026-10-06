import { z } from "zod";
import type { Authentik } from "./authentik.js";
import type { BrokerConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { smtpSend, type SmtpSettings } from "./smtp.js";

/**
 * Outbound email for password reset. authentik's *global* mail settings are
 * environment-only (AUTHENTIK_EMAIL__*), so settings entered by an admin at
 * runtime are written onto the recovery flow's email stage instead
 * (use_global_settings=false). They live in vibe_broker_state under "email"
 * (password wrapped with the broker key) and are re-applied at every boot, so a
 * lost authentik patch or a blueprint reconcile never silently breaks reset mail.
 */

export const RECOVERY_EMAIL_STAGE = "vibe-recovery-email";

/**
 * The invitation a new user receives (admin "Add user" / "Resend invite"). Same recovery flow and
 * one-time link as a reset, but its own subject and wording — a person who never had a password
 * should not be told "you recently requested to change your password" — and a link that lasts
 * days, not 30 minutes. authentik takes the link lifetime from the API call (INVITE_TOKEN_DURATION),
 * not from the stage.
 */
export const WELCOME_EMAIL_STAGE = "vibe-welcome-email";
/** Shipped in deploy/templates; mounted at /templates/vibe in the authentik containers. */
export const WELCOME_TEMPLATE = "vibe/welcome.html";
/** authentik built-in, used until the custom template is mounted (an older deployment). */
export const WELCOME_FALLBACK_TEMPLATE = "email/account_confirmation.html";
export const INVITE_TOKEN_DURATION = "days=3";
/**
 * Admin-sent password resets (Users page "Send reset email" / "Reset link"). Explicit because
 * authentik ignores the recovery stage's token_expiry on that API path and would otherwise apply
 * its own default (a day) — the console tells the admin 30 minutes, as the self-service flow does.
 */
export const RESET_TOKEN_DURATION = "minutes=30";
export const INVITE_VALID_FOR = "3 days";
export const welcomeSubject = (brand: string) => `Set up your ${brand || "Vibe"} sign-in`;

export const emailSettingsInput = z.object({
  host: z.string().trim().min(1, "host required").max(253),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  username: z.string().trim().max(320).optional(),
  /** Blank keeps the stored password (the UI never receives it). */
  password: z.string().max(1024).optional(),
  security: z.enum(["starttls", "ssl", "none"]).default("starttls"),
  from: z.string().trim().min(3).max(320).refine((s) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(/<([^>]+)>/.exec(s)?.[1] ?? s), "from must be an email address"),
});
export type EmailSettingsInput = z.infer<typeof emailSettingsInput>;

interface StoredEmail {
  host: string;
  port: number;
  username?: string;
  passwordEnc?: string;
  security: "starttls" | "ssl" | "none";
  from: string;
  updatedAt: string;
  updatedBy: string;
}

export interface EmailStatus {
  /** Some outbound mail path exists (admin settings or container env). */
  configured: boolean;
  source: "admin" | "env" | "none";
  host?: string;
  port?: number;
  username?: string;
  security?: "starttls" | "ssl" | "none";
  from?: string;
  updatedAt?: string;
  updatedBy?: string;
  recoveryUrl: string;
}

type Store = Pick<Db, "getState" | "setState" | "deleteState" | "wrap" | "unwrap">;
type Ak = Pick<Authentik, "emailStageByName" | "patchEmailStage" | "createEmailStage" | "emailTemplates">;

export class EmailConfig {
  constructor(
    private cfg: () => BrokerConfig,
    private db: Store,
    private ak: Ak,
    private log: Logger,
    private send: typeof smtpSend = smtpSend,
  ) {}

  private async stored(): Promise<StoredEmail | null> {
    return this.db.getState<StoredEmail>("email");
  }

  /** Container-level defaults (VIBE_AUTH_SMTP_* → AUTHENTIK_EMAIL__* on the authentik side). */
  private env(): SmtpSettings | null {
    const c = this.cfg();
    if (!c.VIBE_AUTH_SMTP_HOST) return null;
    return {
      host: c.VIBE_AUTH_SMTP_HOST,
      port: c.VIBE_AUTH_SMTP_PORT,
      username: c.VIBE_AUTH_SMTP_USER || undefined,
      password: c.VIBE_AUTH_SMTP_PASS || undefined,
      useTls: c.VIBE_AUTH_SMTP_TLS,
      useSsl: false,
      from: c.VIBE_AUTH_SMTP_FROM,
    };
  }

  private toSmtp(s: StoredEmail): SmtpSettings {
    return {
      host: s.host,
      port: s.port,
      username: s.username || undefined,
      password: s.passwordEnc ? this.db.unwrap(s.passwordEnc) : undefined,
      useTls: s.security === "starttls",
      useSsl: s.security === "ssl",
      from: s.from,
    };
  }

  /** Effective settings the broker can use to send mail itself (test email). */
  async effective(): Promise<{ source: "admin" | "env"; smtp: SmtpSettings } | null> {
    const s = await this.stored();
    if (s) return { source: "admin", smtp: this.toSmtp(s) };
    const e = this.env();
    return e ? { source: "env", smtp: e } : null;
  }

  async status(): Promise<EmailStatus> {
    const recoveryUrl = `${this.cfg().authentikPublicBase}/if/flow/vibe-recovery/`;
    const s = await this.stored();
    if (s) return { configured: true, source: "admin", host: s.host, port: s.port, username: s.username, security: s.security, from: s.from, updatedAt: s.updatedAt, updatedBy: s.updatedBy, recoveryUrl };
    const e = this.env();
    if (e) return { configured: true, source: "env", host: e.host, port: e.port, username: e.username, security: e.useTls ? "starttls" : "none", from: e.from, recoveryUrl };
    return { configured: false, source: "none", recoveryUrl };
  }

  /** Validate, persist and push to authentik. Returns false when the stage is not there yet (settings are still kept). */
  async save(input: EmailSettingsInput, actor: string): Promise<boolean> {
    const prev = await this.stored();
    const username = input.username || undefined;
    let passwordEnc: string | undefined;
    if (username) {
      if (input.password) passwordEnc = this.db.wrap(input.password);
      else if (prev?.username === username && prev.passwordEnc) passwordEnc = prev.passwordEnc;
    }
    const next: StoredEmail = { host: input.host, port: input.port, username, passwordEnc, security: input.security, from: input.from, updatedAt: new Date().toISOString(), updatedBy: actor };
    await this.db.setState("email", next);
    return this.apply();
  }

  /** Drop admin settings; the recovery stage falls back to authentik's global (env) settings. */
  async clear(): Promise<boolean> {
    await this.db.deleteState("email");
    return this.apply();
  }

  /**
   * Idempotent: make the recovery and welcome email stages match the stored settings (or global
   * settings when none), and the welcome stage's subject and template match the brand and what is
   * mounted. Called at boot and on every settings change. Returns false when the recovery stage
   * is not there yet (settings are still kept); a welcome-stage problem is logged, never fatal.
   */
  async apply(): Promise<boolean> {
    const stage = await this.ak.emailStageByName(RECOVERY_EMAIL_STAGE);
    if (!stage) {
      this.log.warn("recovery email stage not found; email settings kept for next boot", { stage: RECOVERY_EMAIL_STAGE });
      return false;
    }
    const smtp = await this.smtpPatch();
    await this.syncStage(stage, smtp);
    await this.applyWelcome(smtp).catch((e) => this.log.warn("could not apply the welcome email stage; invitations use it once it is repaired", { stage: WELCOME_EMAIL_STAGE, error: (e as Error).message }));
    return true;
  }

  /**
   * The welcome stage's pk, re-synced first (brand renamed in the wizard, template mounted since
   * boot, SMTP settings) so an invitation always goes out as configured right now. Null when it
   * cannot be made usable.
   */
  async welcomeStagePk(): Promise<string | null> {
    try {
      await this.applyWelcome(await this.smtpPatch());
      return (await this.ak.emailStageByName(WELCOME_EMAIL_STAGE))?.pk ?? null;
    } catch (e) {
      this.log.warn("welcome email stage unavailable", { stage: WELCOME_EMAIL_STAGE, error: (e as Error).message });
      return null;
    }
  }

  /** The connection fields every broker-managed email stage carries, or null for authentik's global (env) settings. */
  private async smtpPatch(): Promise<Record<string, unknown> | null> {
    const s = await this.stored();
    if (!s) return null;
    const smtp = this.toSmtp(s);
    return {
      use_global_settings: false,
      host: smtp.host,
      port: smtp.port,
      username: smtp.username ?? "",
      password: smtp.password ?? "",
      use_tls: smtp.useTls,
      use_ssl: smtp.useSsl,
      timeout: 15,
      from_address: smtp.from,
    };
  }

  private async syncStage(stage: { pk: string; use_global_settings?: boolean }, smtp: Record<string, unknown> | null, extra: Record<string, unknown> = {}): Promise<void> {
    if (smtp) return void (await this.ak.patchEmailStage(stage.pk, { ...smtp, ...extra }));
    const patch: Record<string, unknown> = { ...extra };
    if (stage.use_global_settings !== true) patch.use_global_settings = true;
    if (Object.keys(patch).length) await this.ak.patchEmailStage(stage.pk, patch);
  }

  /**
   * The welcome stage: created when missing (the blueprint normally does it), subject from the
   * brand, and the custom template when authentik can see it — else authentik's built-in account
   * confirmation, so an appliance that has not mounted /templates/vibe yet still sends a welcome
   * rather than a "you requested a password change" email.
   */
  private async applyWelcome(smtp: Record<string, unknown> | null): Promise<void> {
    const templates = await this.ak.emailTemplates().catch(() => [] as string[]);
    const template = templates.includes(WELCOME_TEMPLATE) ? WELCOME_TEMPLATE : WELCOME_FALLBACK_TEMPLATE;
    const subject = welcomeSubject(this.cfg().VIBE_AUTH_BRAND_NAME);
    let stage = await this.ak.emailStageByName(WELCOME_EMAIL_STAGE);
    if (!stage) {
      stage = await this.ak.createEmailStage({
        name: WELCOME_EMAIL_STAGE,
        use_global_settings: true,
        template,
        subject,
        token_expiry: INVITE_TOKEN_DURATION,
        activate_user_on_success: true,
      });
      this.log.info("welcome email stage created", { stage: WELCOME_EMAIL_STAGE, template });
    }
    const extra: Record<string, unknown> = {};
    if (stage.template !== template) extra.template = template;
    if (stage.subject !== subject) extra.subject = subject;
    await this.syncStage(stage, smtp, extra);
  }

  /** Synchronous end-to-end check through the broker's own SMTP client. Throws with a readable reason. */
  async sendTest(to: string, firm: string): Promise<{ source: "admin" | "env"; to: string }> {
    const eff = await this.effective();
    if (!eff) throw new Error("no outbound email configured");
    await this.send(eff.smtp, {
      to,
      subject: `${firm}: email test from Vibe Auth`,
      text: `This is a test message from Vibe Auth for ${firm}.\n\nIf you are reading it, password-reset emails will be delivered through ${eff.smtp.host}:${eff.smtp.port}.\n\nNo action is needed.`,
    });
    return { source: eff.source, to };
  }
}
