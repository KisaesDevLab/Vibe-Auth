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
type Ak = Pick<Authentik, "emailStageByName" | "patchEmailStage">;

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

  /** Idempotent: make the recovery email stage match the stored settings (or global settings when none). Called at boot. */
  async apply(): Promise<boolean> {
    const stage = await this.ak.emailStageByName(RECOVERY_EMAIL_STAGE);
    if (!stage) {
      this.log.warn("recovery email stage not found; email settings kept for next boot", { stage: RECOVERY_EMAIL_STAGE });
      return false;
    }
    const s = await this.stored();
    if (!s) {
      if (stage.use_global_settings !== true) await this.ak.patchEmailStage(stage.pk, { use_global_settings: true });
      return true;
    }
    const smtp = this.toSmtp(s);
    await this.ak.patchEmailStage(stage.pk, {
      use_global_settings: false,
      host: smtp.host,
      port: smtp.port,
      username: smtp.username ?? "",
      password: smtp.password ?? "",
      use_tls: smtp.useTls,
      use_ssl: smtp.useSsl,
      timeout: 15,
      from_address: smtp.from,
    });
    return true;
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
