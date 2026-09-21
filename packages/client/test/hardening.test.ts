import { afterEach, describe, expect, it } from "vitest";
import { breakglassStatus, breakglassVerify } from "../src/breakglass.js";
import { defaultBreakglassEmail, defaultRoleMapFor, unmappedDefaultGroups } from "../src/config.js";
import { linkOrProvision } from "../src/identity.js";
import { MemoryIdentityStore } from "../src/adapters/memory.js";
import { scriptJson, testResultPage } from "../src/pages.js";
import { FakeIdp } from "./fake-idp.js";
import { loginViaBrowser, MemorySessions, MemoryUsers, ROLES, startHarness, type Harness } from "./harness.js";

/** v1.0.6: fixes that came out of the first Fastify consumer (Vibe 1040) and the cross-product review. */

describe("defaultRoleMapFor no longer guesses", () => {
  it("matches case-insensitively and returns the product's own spelling", () => {
    expect(defaultRoleMapFor(["ADMIN", "MANAGER", "REVIEWER", "PREPARER", "READ_ONLY"], "ADMIN")).toEqual({
      "vibe-admin": "ADMIN",
      "vibe-it": "ADMIN",
      "vibe-partner": "ADMIN",
      "vibe-manager": "MANAGER",
      "vibe-staff": "PREPARER",
    });
  });

  it("leaves a group unmapped instead of falling back to the least privileged role", () => {
    const m = defaultRoleMapFor(["owner", "accountant", "bookkeeper", "readonly"], "owner");
    expect(m).toEqual({ "vibe-admin": "owner", "vibe-it": "owner", "vibe-partner": "owner" });
    expect(unmappedDefaultGroups(["owner", "accountant", "bookkeeper", "readonly"], "owner")).toEqual(["vibe-manager", "vibe-staff"]);
  });

  it("never promotes vibe-partner to the admin role by default (Payroll & Time: partner became super_admin)", () => {
    const m = defaultRoleMapFor(["super_admin", "company_admin", "supervisor", "employee"], "super_admin");
    expect(m["vibe-partner"]).toBeUndefined();
    expect(m["vibe-manager"]).toBeUndefined();
    expect(unmappedDefaultGroups(["super_admin", "company_admin", "supervisor", "employee"], "super_admin")).toEqual(["vibe-partner", "vibe-manager", "vibe-staff"]);
  });

  it("keeps the mapping that already worked", () => {
    expect(defaultRoleMapFor(ROLES.roles, ROLES.adminRole)).toEqual({ "vibe-admin": "admin", "vibe-it": "admin", "vibe-partner": "admin", "vibe-manager": "reviewer", "vibe-staff": "preparer" });
    expect(unmappedDefaultGroups(ROLES.roles, ROLES.adminRole)).toEqual([]);
  });
});

describe("break-glass identifier, status and verify", () => {
  let h: Harness | undefined;
  let idp: FakeIdp | undefined;
  afterEach(async () => {
    await h?.stop();
    await idp?.stop();
    h = undefined;
    idp = undefined;
  });

  it("defaults to a dotted address, because @localhost fails most login validators", () => {
    expect(defaultBreakglassEmail("vibe-breakglass")).toBe("vibe-breakglass@vibe-auth.local");
  });

  it("accepts the username or the break-glass email in oidc_only, and audits use by email alone", async () => {
    idp = await new FakeIdp({ clientId: "ref-client", user: { sub: "x", email: "x@y.z", email_verified: true, groups: [], amr: ["pwd"] } }).start();
    const users = new MemoryUsers();
    const bg = await users.createLocalUser({ username: "vibe-breakglass", email: "vibe-breakglass@vibe-1099.local", name: "BG", role: "admin", password: "pw" });
    h = await startHarness({ VIBE_AUTH_MODE: "oidc_only", VIBE_OIDC_ISSUER: idp.issuer, VIBE_OIDC_CLIENT_ID: "ref-client" }, { users, breakglassEmail: "Vibe-Breakglass@vibe-1099.local" });
    expect(h.auth.localLoginAllowed("vibe-breakglass").allowed).toBe(true);
    expect(h.auth.localLoginAllowed("  VIBE-BREAKGLASS@vibe-1099.local ").allowed).toBe(true);
    expect(h.auth.localLoginAllowed("vibe-breakglass@localhost").allowed).toBe(false);
    expect(h.auth.localLoginAllowed("alice@firm.test")).toEqual({ allowed: false, reason: "oidc_only" });
    // An email-login product that passes only the email used to lose this event.
    await h.auth.afterLocalLogin({ userId: bg.id, email: "vibe-breakglass@vibe-1099.local", ip: "10.0.0.1" });
    expect(h.events.filter((e) => e.type === "vibe.auth.breakglass.used")).toHaveLength(1);
    await h.auth.afterLocalLogin({ userId: "u2", email: "alice@firm.test" });
    await h.auth.afterLocalLogin({ userId: "u2" });
    expect(h.events.filter((e) => e.type === "vibe.auth.breakglass.used")).toHaveLength(1);
  });

  it("status says why the account is not ready", async () => {
    const users = new MemoryUsers();
    expect(await breakglassStatus({ users, username: "vibe-breakglass", adminRole: "admin" })).toEqual({ exists: false, active: false, admin: false, ready: false, problems: ["account does not exist"] });
    const bg = await users.createLocalUser({ username: "vibe-breakglass", email: "bg@vibe-auth.local", name: "BG", role: "admin", password: "pw" });
    expect(await breakglassStatus({ users, username: "vibe-breakglass", adminRole: "admin" })).toMatchObject({ exists: true, active: true, admin: true, ready: true, problems: [] });
    await users.setRole(bg.id, "preparer");
    expect((await breakglassStatus({ users, username: "vibe-breakglass", adminRole: "admin" })).problems).toEqual(['role is "preparer", not the admin role "admin"']);
    await users.setRole(bg.id, "admin");
    const st = await breakglassStatus({ users, username: "vibe-breakglass", adminRole: "admin", check: () => ({ secondFactorEnrolled: false, locked: true, mustChangePassword: true }) });
    expect(st.ready).toBe(false);
    expect(st.secondFactorEnrolled).toBe(false);
    expect(st.problems).toHaveLength(3);
    expect(JSON.stringify(st)).not.toContain("pw");
  });

  it("verify reports a stored password that no longer matches, and says when it cannot check", async () => {
    const users = new MemoryUsers();
    expect(await breakglassVerify({ users, username: "vibe-breakglass", password: "pw" })).toEqual({ exists: false, checked: false });
    await users.createLocalUser({ username: "vibe-breakglass", email: "bg@vibe-auth.local", name: "BG", role: "admin", password: "pw" });
    expect(await breakglassVerify({ users, username: "vibe-breakglass", password: "pw" })).toEqual({ exists: true, checked: false });
    (users as MemoryUsers & { verifyLocalPassword?: (id: string, pw: string) => Promise<boolean> }).verifyLocalPassword = async (_id, pw) => pw === "pw";
    expect(await breakglassVerify({ users, username: "vibe-breakglass", password: "pw" })).toEqual({ exists: true, checked: true, matches: true });
    expect(await breakglassVerify({ users, username: "vibe-breakglass", password: "restored-db-has-another" })).toEqual({ exists: true, checked: true, matches: false });
  });
});

describe("role sync cannot lock a firm out", () => {
  const input = { issuer: "https://idp", subject: "s1", email: "boss@firm.test", emailVerified: true, claims: { groups: ["vibe-staff"] }, roleClaim: "roles", groupsClaim: "groups", roleMap: defaultRoleMapFor(ROLES.roles, ROLES.adminRole), allowJit: true, vocabulary: ROLES, syncRoles: true };
  const recorder = () => {
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    return { events, audit: async (type: string, payload: Record<string, unknown> = {}) => void events.push({ type, ...payload }) };
  };

  it("keeps the last active admin's role on the first email link, and audits the refusal", async () => {
    const users = new MemoryUsers() as MemoryUsers & { countOtherActiveAdmins?: (id: string) => Promise<number> };
    const boss = await users.create({ email: "boss@firm.test", name: "Boss", role: "admin" });
    users.countOtherActiveAdmins = async () => 0;
    const { events, audit } = recorder();
    const r = await linkOrProvision(users, new MemoryIdentityStore(), audit as never, input);
    expect(r).toMatchObject({ ok: true, how: "email", role: "admin" });
    expect((await users.findById(boss.id))?.role).toBe("admin");
    expect(events.find((e) => e.type === "vibe.auth.role.changed")).toMatchObject({ refused: true, reason: "last_admin", from: "admin", to: "preparer" });
  });

  it("still syncs when another active admin exists", async () => {
    const users = new MemoryUsers() as MemoryUsers & { countOtherActiveAdmins?: (id: string) => Promise<number> };
    const boss = await users.create({ email: "boss@firm.test", name: "Boss", role: "admin" });
    users.countOtherActiveAdmins = async () => 1;
    const { events, audit } = recorder();
    const r = await linkOrProvision(users, new MemoryIdentityStore(), audit as never, input);
    expect(r).toMatchObject({ ok: true, role: "preparer" });
    expect((await users.findById(boss.id))?.role).toBe("preparer");
    expect(events.find((e) => e.type === "vibe.auth.role.changed")).not.toHaveProperty("refused");
  });

  it("honours an adapter that refuses by returning false", async () => {
    const users = new MemoryUsers();
    const boss = await users.create({ email: "boss@firm.test", name: "Boss", role: "admin" });
    users.setRole = async () => false as never;
    const { events, audit } = recorder();
    const r = await linkOrProvision(users, new MemoryIdentityStore(), audit as never, input);
    expect(r).toMatchObject({ ok: true, role: "admin" });
    expect((await users.findById(boss.id))?.role).toBe("admin");
    expect(events.find((e) => e.type === "vibe.auth.role.changed")).toMatchObject({ refused: true, reason: "adapter_refused" });
  });
});

describe("a sign-in is a success only once the session exists", () => {
  let h: Harness | undefined;
  let idp: FakeIdp | undefined;
  afterEach(async () => {
    await h?.stop();
    await idp?.stop();
  });

  it("turns a throwing SessionAdapter into a failed login with the error page, not a success row and a 500", async () => {
    idp = await new FakeIdp({ clientId: "ref-client", clientSecret: "s3cret", user: { sub: "u-1", email: "kurt@kisaes.com", email_verified: true, name: "Kurt", groups: ["vibe-partner"], amr: ["pwd", "otp"] } }).start();
    class RefusingSessions extends MemorySessions {
      override async create(): Promise<void> {
        throw new Error("amr does not satisfy this product's MFA policy");
      }
    }
    h = await startHarness({ VIBE_AUTH_MODE: "both", VIBE_OIDC_ISSUER: idp.issuer, VIBE_OIDC_CLIENT_ID: "ref-client", VIBE_OIDC_CLIENT_SECRET: "s3cret" }, { session: new RefusingSessions() });
    const r = await loginViaBrowser(h.base, "/auth/oidc/start?return_to=/dash");
    expect(r.status).toBe(401);
    expect(r.body).toContain("could not start your session");
    expect(r.body).not.toContain("internal_error");
    expect(h.events.some((e) => e.type === "vibe.auth.login.success")).toBe(false);
    expect(h.events.find((e) => e.type === "vibe.auth.login.failure")).toMatchObject({ reason: "session_failed" });
  });

  it("ready() waits for discovery, which start() deliberately does not", async () => {
    idp = await new FakeIdp({ clientId: "ref-client", user: { sub: "u", email: "a@b.c", email_verified: true, groups: [], amr: [] } }).start();
    h = await startHarness({ VIBE_AUTH_MODE: "both", VIBE_OIDC_ISSUER: idp.issuer, VIBE_OIDC_CLIENT_ID: "ref-client" });
    expect(await h.auth.ready()).toBe(true);
    expect(h.auth.status().oidc.reachable).toBe(true);
  });
});

describe("inline script payloads", () => {
  it("cannot break out of the script block", () => {
    const evil = 'x</script><script>alert(1)</script><!-- &  ';
    const out = scriptJson({ message: evil });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain(" ");
    expect(JSON.parse(out)).toEqual({ message: evil });
    const page = testResultPage({ ok: false, reason: "access_denied", message: evil });
    // exactly one script block: the package's own
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page.match(/<\/script>/g)).toHaveLength(1);
  });
});
