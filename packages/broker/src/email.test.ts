import { describe, expect, it, vi } from "vitest";
import type { BrokerConfig } from "./config.js";
import { EmailConfig, RECOVERY_EMAIL_STAGE } from "./email.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function harness(o: { env?: Partial<BrokerConfig>; stage?: { pk: string; name: string; use_global_settings?: boolean } | null } = {}) {
  const state = new Map<string, unknown>();
  const db = {
    getState: vi.fn(async <T = unknown,>(k: string): Promise<T | null> => (state.has(k) ? (state.get(k) as T) : null)),
    setState: vi.fn(async (k: string, v: unknown) => void state.set(k, JSON.parse(JSON.stringify(v)))),
    deleteState: vi.fn(async (k: string) => void state.delete(k)),
    wrap: (s: string) => `wrapped:${s}`,
    unwrap: (s: string) => s.replace(/^wrapped:/, ""),
  };
  // Stateful fake stage: a PATCH changes what the next GET returns, as authentik does.
  let stage = o.stage === undefined ? { pk: "stage-1", name: RECOVERY_EMAIL_STAGE, use_global_settings: true } : o.stage;
  const ak = {
    emailStageByName: vi.fn(async (name: string) => (name === RECOVERY_EMAIL_STAGE ? stage : null)),
    patchEmailStage: vi.fn(async (pk: string, body: Record<string, unknown>) => {
      stage = { pk, name: RECOVERY_EMAIL_STAGE, ...stage, ...body };
      return stage;
    }),
  };
  const cfg = () => ({ authentikPublicBase: "https://firm.test/auth", VIBE_AUTH_SMTP_PORT: 587, VIBE_AUTH_SMTP_TLS: true, VIBE_AUTH_SMTP_FROM: "vibe-auth@localhost", VIBE_AUTH_BRAND_NAME: "Firm", ...o.env }) as BrokerConfig;
  const send = vi.fn(async () => {});
  const email = new EmailConfig(cfg, db as unknown as ConstructorParameters<typeof EmailConfig>[1], ak, log, send);
  return { email, db, ak, send, state };
}

describe("EmailConfig", () => {
  it("reports 'none' with the recovery URL when nothing is configured", async () => {
    const { email } = harness();
    expect(await email.status()).toEqual({ configured: false, source: "none", recoveryUrl: "https://firm.test/auth/if/flow/vibe-recovery/" });
    await expect(email.sendTest("a@b.test", "Firm")).rejects.toThrow(/no outbound email/);
  });

  it("falls back to container env and can test through it", async () => {
    const { email, send } = harness({ env: { VIBE_AUTH_SMTP_HOST: "relay.internal", VIBE_AUTH_SMTP_TLS: false, VIBE_AUTH_SMTP_FROM: "noreply@firm.test" } });
    expect(await email.status()).toMatchObject({ configured: true, source: "env", host: "relay.internal", port: 587, security: "none", from: "noreply@firm.test" });
    expect(await email.sendTest("kurt@firm.test", "Firm")).toEqual({ source: "env", to: "kurt@firm.test" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ host: "relay.internal", useTls: false, useSsl: false, from: "noreply@firm.test" }), expect.objectContaining({ to: "kurt@firm.test", subject: "Firm: email test from Vibe Auth" }));
  });

  it("saves settings with the password wrapped and patches the recovery stage", async () => {
    const { email, ak, state } = harness();
    expect(await email.save({ host: "smtp.office365.com", port: 587, security: "starttls", username: "mailer@firm.test", password: "pw", from: "vibe-auth@firm.test" }, "kurt@firm.test")).toBe(true);
    const stored = state.get("email") as Record<string, unknown>;
    expect(stored.passwordEnc).toBe("wrapped:pw");
    expect(stored).not.toHaveProperty("password");
    expect(ak.patchEmailStage).toHaveBeenCalledWith("stage-1", { use_global_settings: false, host: "smtp.office365.com", port: 587, username: "mailer@firm.test", password: "pw", use_tls: true, use_ssl: false, timeout: 15, from_address: "vibe-auth@firm.test" });
    const st = await email.status();
    expect(st).toMatchObject({ configured: true, source: "admin", host: "smtp.office365.com", username: "mailer@firm.test", updatedBy: "kurt@firm.test" });
    expect(JSON.stringify(st)).not.toContain("pw");
  });

  it("keeps the stored password when the update leaves it blank, drops it when the username changes", async () => {
    const { email, ak, state } = harness();
    await email.save({ host: "h", port: 465, security: "ssl", username: "u", password: "secret", from: "a@b.test" }, "admin");
    await email.save({ host: "h2", port: 465, security: "ssl", username: "u", password: "", from: "a@b.test" }, "admin");
    expect((state.get("email") as Record<string, unknown>).passwordEnc).toBe("wrapped:secret");
    expect(ak.patchEmailStage).toHaveBeenLastCalledWith("stage-1", expect.objectContaining({ host: "h2", password: "secret", use_ssl: true, use_tls: false }));
    await email.save({ host: "h2", port: 465, security: "ssl", username: "other", password: "", from: "a@b.test" }, "admin");
    expect((state.get("email") as Record<string, unknown>).passwordEnc).toBeUndefined();
    expect(ak.patchEmailStage).toHaveBeenLastCalledWith("stage-1", expect.objectContaining({ username: "other", password: "" }));
  });

  it("admin settings win over env; clearing returns the stage to global settings", async () => {
    const { email, ak } = harness({ env: { VIBE_AUTH_SMTP_HOST: "relay.internal" } });
    await email.save({ host: "smtp.gmail.com", port: 587, security: "starttls", from: "a@b.test" }, "admin");
    expect((await email.status()).source).toBe("admin");
    ak.patchEmailStage.mockClear();
    expect(await email.clear()).toBe(true);
    expect(ak.patchEmailStage).toHaveBeenCalledWith("stage-1", { use_global_settings: true });
    expect((await email.status()).source).toBe("env");
  });

  it("apply is a no-op when the stage already uses global settings and nothing is stored", async () => {
    const { email, ak } = harness();
    expect(await email.apply()).toBe(true);
    expect(ak.patchEmailStage).not.toHaveBeenCalled();
  });

  it("keeps settings and returns false when the stage is missing (blueprint not applied yet)", async () => {
    const { email, state } = harness({ stage: null });
    expect(await email.save({ host: "h", port: 25, security: "none", from: "a@b.test" }, "admin")).toBe(false);
    expect(state.has("email")).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });
});
