import { z } from "zod";
import type { Authentik } from "./authentik.js";
import type { Db } from "./db.js";
import type { EmailConfig } from "./email.js";
import type { Logger } from "./log.js";

/**
 * MFA enforcement and the factors a user may enrol (D23, amended 1.0.11).
 *
 * An authenticator app and a passkey / security key are always offered. A code
 * by email and a code by text message are opt-in: an admin turns each on in the
 * console. Both are weaker than the defaults (email shares the mailbox that
 * password resets go to; SMS is open to SIM swap), so neither is ever on by default.
 *
 * Enabling a method means (1) its enrolment stage exists in authentik with
 * working delivery settings, (2) that stage is offered when a user has no device
 * and (3) its device class is accepted at sign-in. Disabling removes (2) and (3):
 * devices already enrolled stop being accepted, and a user left with no accepted
 * device is asked to enrol another at the next sign-in.
 *
 * The stages are created here, not in the blueprint: they carry delivery
 * credentials an admin enters at runtime. State lives in vibe_broker_state under
 * "mfa_methods" (SMS token wrapped with the broker key) and is re-applied at boot.
 */

export const MFA_STAGE_NAME = "vibe-mfa-validation";
/** Asks for the device a user has just enrolled, so that first sign-in also carries amr "mfa" (blueprint). */
export const MFA_CONFIRM_STAGE = "vibe-mfa-confirm";
const CONFIRM_DEVICE_CLASSES = ["totp", "webauthn", "static", "sms", "email"];
export const EMAIL_MFA_STAGE = "vibe-email-mfa-setup";
export const SMS_MFA_STAGE = "vibe-sms-setup";
export const TEXTLINK_MAPPING_NAME = "Vibe: TextLink SMS payload";
const BASE_SETUP_STAGES = ["vibe-totp-setup", "vibe-webauthn-setup"];
const BASE_DEVICE_CLASSES = ["totp", "webauthn", "static"];

/** TextLink wants {phone_number, text}; authentik's generic provider posts {From, To, Body, Message} unless a mapping says otherwise. */
export const TEXTLINK_EXPRESSION = `# Vibe Auth: JSON body for TextLink's /api/send-sms.
return {
    "phone_number": device.phone_number,
    "text": f"{token} is your sign-in code. It expires in a few minutes. Never share it.",
}
`;

const e164 = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "use international format, e.g. +15551234567");

export const smsSettingsInput = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("twilio"),
    accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, "Twilio Account SID starts with AC and has 34 characters"),
    /** Blank keeps the stored token (the UI never receives it). */
    token: z.string().max(1024).optional(),
    /** A Twilio phone number, or a Messaging Service SID (MG…). */
    from: z.union([e164, z.string().trim().regex(/^MG[0-9a-fA-F]{32}$/)]),
  }),
  z.object({
    provider: z.literal("textlink"),
    url: z.string().trim().url().default("https://textlinksms.com"),
    token: z.string().max(1024).optional(),
  }),
  z.object({
    provider: z.literal("generic"),
    /** Receives POST {From, To, Body, Message} as JSON with Authorization: Bearer <token>. */
    url: z.string().trim().url(),
    token: z.string().max(1024).optional(),
    from: z.string().trim().min(1).max(32),
  }),
]);
export type SmsSettingsInput = z.infer<typeof smsSettingsInput>;

interface StoredSms {
  provider: "twilio" | "textlink" | "generic";
  accountSid?: string;
  url?: string;
  from?: string;
  tokenEnc: string;
}
interface StoredMethods {
  email?: boolean;
  sms?: StoredSms;
  updatedAt?: string;
  updatedBy?: string;
}

export interface MfaMethodsStatus {
  email: { enabled: boolean; /** Outbound email is configured, so codes can be delivered. */ deliverable: boolean };
  sms: { enabled: boolean; provider?: StoredSms["provider"]; accountSid?: string; url?: string; from?: string };
  updatedAt?: string;
  updatedBy?: string;
}

type Store = Pick<Db, "getState" | "setState" | "wrap" | "unwrap">;
type Ak = Pick<
  Authentik,
  "validateStageByName" | "patchValidateStage" | "stagesByName" | "authenticatorStageByName" | "createAuthenticatorStage" | "patchAuthenticatorStage" | "webhookMappingByName" | "createWebhookMapping" | "updateWebhookMapping"
>;
type Mail = Pick<EmailConfig, "effective">;

export class MfaMethods {
  constructor(
    private db: Store,
    private ak: Ak,
    private mail: Mail,
    private log: Logger,
  ) {}

  private async stored(): Promise<StoredMethods> {
    return (await this.db.getState<StoredMethods>("mfa_methods")) ?? {};
  }

  async status(): Promise<MfaMethodsStatus> {
    const s = await this.stored();
    const sms = s.sms;
    return {
      email: { enabled: s.email === true, deliverable: !!(await this.mail.effective()) },
      sms: sms ? { enabled: true, provider: sms.provider, accountSid: sms.accountSid, url: sms.url, from: sms.from } : { enabled: false },
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
    };
  }

  async setEmail(enabled: boolean, actor: string, required: boolean): Promise<void> {
    if (enabled && !(await this.mail.effective())) throw new MfaConfigError("outbound email is not configured; set up a mail server first");
    await this.db.setState("mfa_methods", { ...(await this.stored()), email: enabled, updatedAt: new Date().toISOString(), updatedBy: actor });
    await this.apply(required);
  }

  /** `null` turns SMS off (the stored provider token is dropped). */
  async setSms(input: SmsSettingsInput | null, actor: string, required: boolean): Promise<void> {
    const prev = await this.stored();
    let sms: StoredSms | undefined;
    if (input) {
      const same = prev.sms?.provider === input.provider && (input.provider === "twilio" ? prev.sms.accountSid === input.accountSid : prev.sms?.url === input.url);
      const tokenEnc = input.token ? this.db.wrap(input.token) : same ? prev.sms!.tokenEnc : undefined;
      if (!tokenEnc) throw new MfaConfigError(input.provider === "twilio" ? "Twilio auth token required" : "API key required");
      sms = input.provider === "twilio" ? { provider: "twilio", accountSid: input.accountSid, from: input.from, tokenEnc } : input.provider === "textlink" ? { provider: "textlink", url: input.url.replace(/\/+$/, ""), tokenEnc } : { provider: "generic", url: input.url, from: input.from, tokenEnc };
    }
    const { sms: _dropped, ...rest } = prev;
    await this.db.setState("mfa_methods", { ...rest, ...(sms ? { sms } : {}), updatedAt: new Date().toISOString(), updatedBy: actor });
    await this.apply(required);
  }

  /** authentik body for the SMS enrolment stage. */
  private async smsStageBody(s: StoredSms): Promise<Record<string, unknown>> {
    const token = this.db.unwrap(s.tokenEnc);
    const common = { name: SMS_MFA_STAGE, friendly_name: "Text message (SMS)", verify_only: false };
    if (s.provider === "twilio") return { ...common, provider: "twilio", from_number: s.from, account_sid: s.accountSid, auth: token, mapping: null };
    if (s.provider === "generic") return { ...common, provider: "generic", from_number: s.from, account_sid: s.url, auth: token, auth_type: "bearer", mapping: null };
    let mapping = await this.ak.webhookMappingByName(TEXTLINK_MAPPING_NAME);
    if (!mapping) mapping = await this.ak.createWebhookMapping({ name: TEXTLINK_MAPPING_NAME, expression: TEXTLINK_EXPRESSION });
    else if (mapping.expression !== TEXTLINK_EXPRESSION) await this.ak.updateWebhookMapping(mapping.pk, { expression: TEXTLINK_EXPRESSION });
    // TextLink sends from the device paired with the API key; authentik still requires a from_number.
    return { ...common, provider: "generic", from_number: "TextLink", account_sid: `${s.url}/api/send-sms`, auth: token, auth_type: "bearer", mapping: mapping.pk };
  }

  /** The email enrolment stage follows the same mail server as password reset (email.ts). */
  private async emailStageBody(): Promise<Record<string, unknown>> {
    const eff = await this.mail.effective();
    const common = { name: EMAIL_MFA_STAGE, friendly_name: "Code by email", subject: "Your sign-in code", token_expiry: "minutes=10" };
    if (!eff || eff.source === "env") return { ...common, use_global_settings: true };
    const m = eff.smtp;
    return { ...common, use_global_settings: false, host: m.host, port: m.port, username: m.username ?? "", password: m.password ?? "", use_tls: m.useTls, use_ssl: m.useSsl, timeout: 15, from_address: m.from };
  }

  private async ensureStage(kind: "email" | "sms", name: string, body: Record<string, unknown>): Promise<string> {
    const existing = await this.ak.authenticatorStageByName(kind, name);
    if (!existing) return (await this.ak.createAuthenticatorStage(kind, body)).pk;
    await this.ak.patchAuthenticatorStage(kind, existing.pk, body);
    return existing.pk;
  }

  /**
   * Idempotent: make authentik match the stored methods and the enforcement switch.
   * Called at boot, on every toggle, and after the mail server changes. Returns false
   * when the validation stage is not there yet (blueprint not applied).
   */
  async apply(required: boolean): Promise<boolean> {
    const stage = await this.ak.validateStageByName(MFA_STAGE_NAME);
    if (!stage) return false;
    const s = await this.stored();
    // "configure" requires configuration stages; resolve the enrolment stages by name so this
    // never depends on what the blueprint managed to attach.
    const setup: string[] = [];
    for (const name of BASE_SETUP_STAGES) {
      const st = (await this.ak.stagesByName(name))[0];
      if (st) setup.push(st.pk);
    }
    const classes = [...BASE_DEVICE_CLASSES];
    // A method whose stage cannot be written is left out rather than failing sign-in for everyone.
    if (s.sms) {
      try {
        setup.push(await this.ensureStage("sms", SMS_MFA_STAGE, await this.smsStageBody(s.sms)));
        classes.push("sms");
      } catch (e) {
        this.log.warn("SMS MFA stage not applied; SMS codes are unavailable", { error: (e as Error).message });
      }
    }
    if (s.email) {
      try {
        setup.push(await this.ensureStage("email", EMAIL_MFA_STAGE, await this.emailStageBody()));
        classes.push("email");
      } catch (e) {
        this.log.warn("email MFA stage not applied; email codes are unavailable", { error: (e as Error).message });
      }
    }
    // The blueprint lists the code classes on the confirmation stage, but authentik re-applies a changed
    // blueprint on its own schedule; without them a phone or email enrolment is never confirmed and
    // every product that requires MFA refuses that first sign-in.
    const confirm = (await this.ak.validateStageByName(MFA_CONFIRM_STAGE)) as { pk: string; device_classes?: string[] } | null;
    if (confirm && !CONFIRM_DEVICE_CLASSES.every((c) => confirm.device_classes?.includes(c))) await this.ak.patchValidateStage(confirm.pk, { device_classes: CONFIRM_DEVICE_CLASSES });
    await this.ak.patchValidateStage(stage.pk, {
      not_configured_action: required ? "configure" : "skip",
      ...(setup.length ? { configuration_stages: setup } : {}),
      device_classes: classes,
    });
    return true;
  }
}

/** A setting the admin can fix (reported as 400, not 500). */
export class MfaConfigError extends Error {}
