import { describe, expect, it, vi } from "vitest";
import type { AkUser } from "./authentik.js";
import { InviteError, Invites } from "./invite.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function harness(o: { user?: Partial<AkUser>; configured?: boolean; stagePk?: string | null; sendFails?: string; linkFails?: boolean } = {}) {
  const calls: string[] = [];
  const user = { pk: 7, uuid: "u", username: "pat@firm.test", name: "Pat", email: "pat@firm.test", is_active: true, is_superuser: false, last_login: null, groups: [], ...o.user } as AkUser;
  const ak = {
    user: vi.fn(async () => user),
    createRecoveryLink: vi.fn(async (pk: number, d?: string) => {
      calls.push(`link ${pk} ${d}`);
      if (o.linkFails) throw new Error("No recovery flow set.");
      return "https://firm.test/auth/if/flow/vibe-recovery/?flow_token=tok";
    }),
    sendRecoveryEmail: vi.fn(async (pk: number, stage: string, d?: string) => {
      calls.push(`email ${pk} ${stage} ${d}`);
      if (o.sendFails) throw new Error(o.sendFails);
    }),
  };
  const email = {
    status: vi.fn(async () => ({ configured: o.configured ?? true, source: "admin" as const, recoveryUrl: "" })),
    welcomeStagePk: vi.fn(async () => (o.stagePk === undefined ? "welcome-1" : o.stagePk)),
  };
  return { invites: new Invites(ak, email, log), ak, calls };
}

describe("Invites", () => {
  it("emails the welcome stage and hands over the same link, both valid 3 days; link first, email last", async () => {
    const { invites, calls } = harness();
    const r = await invites.send(7);
    expect(r).toEqual({ to: "pat@firm.test", emailed: true, link: "https://firm.test/auth/if/flow/vibe-recovery/?flow_token=tok", validFor: "3 days" });
    // authentik keeps one token per user and each call resets its expiry: the email must come last
    // so the emailed link keeps the invitation's lifetime (it used to drop to 30 minutes).
    expect(calls).toEqual(["link 7 days=3", "email 7 welcome-1 days=3"]);
  });

  it("without outbound email: no send attempt, the admin still gets the link and the reason", async () => {
    const { invites, ak } = harness({ configured: false });
    const r = await invites.send(7);
    expect(r.emailed).toBe(false);
    expect(r.emailError).toMatch(/no outbound email/);
    expect(r.link).toContain("flow_token=");
    expect(ak.sendRecoveryEmail).not.toHaveBeenCalled();
  });

  it("reports why an email was not sent: no address, no stage, authentik refused", async () => {
    expect((await harness({ user: { email: "" } }).invites.send(7)).emailError).toMatch(/no email address/);
    expect((await harness({ stagePk: null }).invites.send(7)).emailError).toMatch(/welcome email stage/);
    const refused = await harness({ sendFails: "Email stage not found." }).invites.send(7);
    expect(refused).toMatchObject({ emailed: false, emailError: "Email stage not found." });
  });

  it("a link authentik refuses is null, never a crash", async () => {
    const r = await harness({ linkFails: true }).invites.send(7);
    expect(r.link).toBeNull();
    expect(r.emailed).toBe(true);
  });

  it("resend: allowed for an active person who has never signed in", async () => {
    const { invites, calls } = harness();
    expect((await invites.send(7, { resend: true })).emailed).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("resend: refused once they have signed in, or while deactivated — nothing is created", async () => {
    const signedIn = harness({ user: { last_login: "2026-10-01T09:00:00Z" } });
    await expect(signedIn.invites.send(7, { resend: true })).rejects.toThrow(/already signed in.*Send reset email/);
    await expect(signedIn.invites.send(7, { resend: true })).rejects.toBeInstanceOf(InviteError);
    expect(signedIn.calls).toEqual([]);
    const off = harness({ user: { is_active: false } });
    await expect(off.invites.send(7, { resend: true })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/deactivated/) });
    expect(off.calls).toEqual([]);
  });
});
