import { describe, expect, it, vi } from "vitest";
import { EMAIL_MFA_STAGE, MfaConfigError, MfaMethods, SMS_MFA_STAGE, smsSettingsInput, TEXTLINK_MAPPING_NAME } from "./mfa.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const TWILIO = { provider: "twilio" as const, accountSid: "AC" + "0".repeat(32), token: "tw-secret", from: "+15551234567" };

function harness(o: { mail?: "admin" | "env" | "none"; failSmsStage?: boolean } = {}) {
  const state = new Map<string, unknown>();
  const db = {
    getState: vi.fn(async <T = unknown,>(k: string): Promise<T | null> => (state.has(k) ? (state.get(k) as T) : null)),
    setState: vi.fn(async (k: string, v: unknown) => void state.set(k, JSON.parse(JSON.stringify(v)))),
    wrap: (s: string) => `wrapped:${s}`,
    unwrap: (s: string) => s.replace(/^wrapped:/, ""),
  };
  // Stateful fake authentik: created stages are found by the next lookup.
  const stages = new Map<string, Record<string, unknown>>();
  let mapping: { pk: string; name: string; expression: string } | null = null;
  const ak = {
    validateStageByName: vi.fn(async (name: string) => (name === "vibe-mfa-confirm" ? { pk: "confirm-1", name, device_classes: ["totp", "webauthn", "static"] } : { pk: "validate-1", name })),
    patchValidateStage: vi.fn(async (pk: string, body: Record<string, unknown>) => ({ pk, name: "vibe-mfa-validation", ...body })),
    stagesByName: vi.fn(async (name: string) => [{ pk: `pk-${name}`, name }]),
    authenticatorStageByName: vi.fn(async (_kind: string, name: string) => (stages.get(name) as { pk: string; name: string } | undefined) ?? null),
    createAuthenticatorStage: vi.fn(async (kind: string, body: Record<string, unknown>) => {
      if (kind === "sms" && o.failSmsStage) throw new Error("authentik 400");
      const st = { pk: `pk-${String(body.name)}`, name: String(body.name), ...body };
      stages.set(st.name, st);
      return st;
    }),
    patchAuthenticatorStage: vi.fn(async (_kind: string, pk: string, body: Record<string, unknown>) => ({ pk, name: String(body.name), ...body })),
    webhookMappingByName: vi.fn(async () => mapping),
    createWebhookMapping: vi.fn(async (b: { name: string; expression: string }) => (mapping = { pk: "map-1", ...b })),
    updateWebhookMapping: vi.fn(async (pk: string) => ({ pk })),
  };
  const smtp = { host: "smtp.firm.test", port: 587, username: "mailer", password: "pw", useTls: true, useSsl: false, from: "auth@firm.test" };
  const mail = { effective: vi.fn(async () => ((o.mail ?? "admin") === "none" ? null : { source: (o.mail ?? "admin") as "admin" | "env", smtp })) };
  const mfa = new MfaMethods(db as unknown as ConstructorParameters<typeof MfaMethods>[0], ak as unknown as ConstructorParameters<typeof MfaMethods>[1], mail, log);
  const lastPatch = () => ak.patchValidateStage.mock.calls.at(-1)![1];
  return { mfa, ak, state, lastPatch };
}

describe("MfaMethods", () => {
  it("offers only the authenticator app and passkey until an admin opts in", async () => {
    const { mfa, ak, lastPatch } = harness();
    expect(await mfa.apply(true)).toBe(true);
    expect(lastPatch()).toEqual({ not_configured_action: "configure", configuration_stages: ["pk-vibe-totp-setup", "pk-vibe-webauthn-setup"], device_classes: ["totp", "webauthn", "static"] });
    expect(ak.createAuthenticatorStage).not.toHaveBeenCalled();
    // The post-enrolment confirmation must be able to ask for a texted or emailed code.
    expect(ak.patchValidateStage).toHaveBeenCalledWith("confirm-1", { device_classes: ["totp", "webauthn", "static", "sms", "email"] });
    expect(await mfa.status()).toMatchObject({ email: { enabled: false, deliverable: true }, sms: { enabled: false } });
  });

  it("email codes: creates the enrolment stage on the admin's mail server and accepts the device class", async () => {
    const { mfa, ak, lastPatch } = harness();
    await mfa.setEmail(true, "kurt@firm.test", true);
    expect(ak.createAuthenticatorStage).toHaveBeenCalledWith("email", expect.objectContaining({ name: EMAIL_MFA_STAGE, use_global_settings: false, host: "smtp.firm.test", password: "pw", from_address: "auth@firm.test" }));
    expect(lastPatch().configuration_stages).toEqual(["pk-vibe-totp-setup", "pk-vibe-webauthn-setup", `pk-${EMAIL_MFA_STAGE}`]);
    expect(lastPatch().device_classes).toEqual(["totp", "webauthn", "static", "email"]);
    await mfa.setEmail(false, "kurt@firm.test", true);
    expect(lastPatch().device_classes).toEqual(["totp", "webauthn", "static"]);
    expect(lastPatch().configuration_stages).toEqual(["pk-vibe-totp-setup", "pk-vibe-webauthn-setup"]);
  });

  it("email codes use authentik's global mail settings when the mail server comes from the container env", async () => {
    const { mfa, ak } = harness({ mail: "env" });
    await mfa.setEmail(true, "admin", true);
    expect(ak.createAuthenticatorStage).toHaveBeenCalledWith("email", expect.objectContaining({ use_global_settings: true }));
    expect(ak.createAuthenticatorStage.mock.calls[0]![1]).not.toHaveProperty("password");
  });

  it("refuses email codes while no mail server is configured", async () => {
    const { mfa, state } = harness({ mail: "none" });
    await expect(mfa.setEmail(true, "admin", true)).rejects.toBeInstanceOf(MfaConfigError);
    expect(state.has("mfa_methods")).toBe(false);
  });

  it("SMS via Twilio: wraps the token, never reports it, keeps it when an update leaves it blank", async () => {
    const { mfa, ak, state, lastPatch } = harness();
    await mfa.setSms(TWILIO, "admin", true);
    expect((state.get("mfa_methods") as { sms: Record<string, unknown> }).sms).toEqual({ provider: "twilio", accountSid: TWILIO.accountSid, from: "+15551234567", tokenEnc: "wrapped:tw-secret" });
    expect(ak.createAuthenticatorStage).toHaveBeenCalledWith("sms", expect.objectContaining({ name: SMS_MFA_STAGE, provider: "twilio", account_sid: TWILIO.accountSid, auth: "tw-secret", from_number: "+15551234567" }));
    expect(lastPatch().device_classes).toEqual(["totp", "webauthn", "static", "sms"]);
    expect(JSON.stringify(await mfa.status())).not.toContain("tw-secret");

    await mfa.setSms({ ...TWILIO, token: undefined, from: "+15557654321" }, "admin", true);
    expect(ak.patchAuthenticatorStage).toHaveBeenCalledWith("sms", `pk-${SMS_MFA_STAGE}`, expect.objectContaining({ auth: "tw-secret", from_number: "+15557654321" }));
    // A different account must not inherit the old account's token.
    await expect(mfa.setSms({ ...TWILIO, accountSid: "AC" + "1".repeat(32), token: undefined }, "admin", true)).rejects.toThrow(/auth token required/);
  });

  it("SMS via TextLink: generic provider with a bearer key and the payload mapping", async () => {
    const { mfa, ak } = harness();
    await mfa.setSms(smsSettingsInput.parse({ provider: "textlink", token: "tl-key" }), "admin", true);
    expect(ak.createWebhookMapping).toHaveBeenCalledWith(expect.objectContaining({ name: TEXTLINK_MAPPING_NAME }));
    expect(ak.createAuthenticatorStage).toHaveBeenCalledWith("sms", expect.objectContaining({ provider: "generic", account_sid: "https://textlinksms.com/api/send-sms", auth: "tl-key", auth_type: "bearer", mapping: "map-1" }));
  });

  it("turning SMS off drops the provider token and stops accepting SMS devices, leaving email as it was", async () => {
    const { mfa, state, lastPatch } = harness();
    await mfa.setEmail(true, "admin", true);
    await mfa.setSms(TWILIO, "admin", true);
    expect(lastPatch().device_classes).toEqual(["totp", "webauthn", "static", "sms", "email"]);
    await mfa.setSms(null, "admin", true);
    expect(state.get("mfa_methods")).not.toHaveProperty("sms");
    expect(lastPatch().device_classes).toEqual(["totp", "webauthn", "static", "email"]);
  });

  it("a method whose stage cannot be written is left out; enforcement is still applied", async () => {
    const { mfa, lastPatch } = harness({ failSmsStage: true });
    await mfa.setSms(TWILIO, "admin", true);
    expect(lastPatch()).toMatchObject({ not_configured_action: "configure", device_classes: ["totp", "webauthn", "static"] });
  });

  it("enforcement off keeps the enabled methods but stops requiring enrolment", async () => {
    const { mfa, lastPatch } = harness();
    await mfa.setEmail(true, "admin", false);
    expect(lastPatch()).toMatchObject({ not_configured_action: "skip", device_classes: ["totp", "webauthn", "static", "email"] });
  });

  it("validates provider input", () => {
    expect(smsSettingsInput.safeParse({ provider: "twilio", accountSid: "nope", from: "+15551234567" }).success).toBe(false);
    expect(smsSettingsInput.safeParse({ ...TWILIO, from: "5551234567" }).success).toBe(false);
    expect(smsSettingsInput.safeParse({ provider: "generic", url: "not a url", from: "Firm" }).success).toBe(false);
  });
});
