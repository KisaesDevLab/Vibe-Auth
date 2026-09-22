import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeIdp } from "./fake-idp.js";
import { loginViaBrowser, startHarness, type Harness } from "./harness.js";

let idp: FakeIdp;
let h: Harness;

const baseUser = { sub: "u-100", email: "kurt@kisaes.com", email_verified: true, name: "Kurt", groups: ["vibe-partner"], amr: ["pwd", "otp"] };

async function boot(envExtra: Record<string, string> = {}, idpOpts: Partial<ConstructorParameters<typeof FakeIdp>[0]> = {}) {
  idp = await new FakeIdp({ clientId: "ref-client", clientSecret: "s3cret", user: { ...baseUser }, ...idpOpts }).start();
  h = await startHarness({
    VIBE_AUTH_MODE: "both",
    VIBE_OIDC_ISSUER: idp.issuer,
    VIBE_OIDC_CLIENT_ID: "ref-client",
    VIBE_OIDC_CLIENT_SECRET: "s3cret",
    ...envExtra,
  });
}

afterEach(async () => {
  await h?.stop();
  await idp?.stop();
});

describe("OIDC login flow (Phase 2/3)", () => {
  beforeEach(() => boot());

  it("exposes status", async () => {
    const s = (await (await fetch(h.base + "/auth/status")).json()) as { mode: string; oidc: { enabled: boolean; reachable: boolean } };
    expect(s.mode).toBe("both");
    expect(s.oidc.enabled).toBe(true);
  });

  it("logs in with PKCE, JIT-provisions, maps role, sets a session", async () => {
    const r = await loginViaBrowser(h.base, "/auth/oidc/start?return_to=/dash");
    expect(r.location).toBe("/dash");
    expect(r.cookies.some((c) => c.startsWith("sid="))).toBe(true);
    expect(idp.tokenRequests[0]?.get("code_verifier")).toBeTruthy();
    const u = await h.users.findByEmail("kurt@kisaes.com");
    expect(u?.role).toBe("admin"); // vibe-partner → admin for this vocabulary
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(["vibe.auth.user.provisioned", "vibe.auth.login.success"]));
    const me = (await (await fetch(h.base + "/auth/me", { headers: { cookie: r.cookies.join("; ") } })).json()) as { user: { email: string }; identities: unknown[] };
    expect(me.user.email).toBe("kurt@kisaes.com");
    expect(me.identities).toHaveLength(1);
  });

  it("links by verified email to an existing local user and syncs role", async () => {
    const local = await h.users.createLocalUser({ username: "kurt", email: "kurt@kisaes.com", name: "K", role: "preparer", password: "x" });
    await loginViaBrowser(h.base);
    const u = await h.users.findById(local.id);
    expect(u?.role).toBe("admin");
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(["vibe.auth.user.linked", "vibe.auth.role.changed"]));
    expect(h.users.rows.size).toBe(1);
  });

  it("denies unverified email", async () => {
    idp.user.email_verified = false;
    const r = await loginViaBrowser(h.base);
    expect(r.status).toBe(401);
    expect(r.body).toContain("did not confirm your email");
    expect(h.events.find((e) => e.type === "vibe.auth.login.failure")?.reason).toBe("unverified_email");
  });

  it("denies when no role resolves", async () => {
    idp.user.groups = ["nobody"];
    const r = await loginViaBrowser(h.base);
    expect(r.status).toBe(401);
    expect(h.events.find((e) => e.type === "vibe.auth.login.failure")?.reason).toBe("no_role");
  });

  it("rejects a replayed/unknown state", async () => {
    const res = await fetch(h.base + "/auth/oidc/callback?code=x&state=nope", { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("propagates IdP errors as login failures", async () => {
    idp.opts.denyWith = "access_denied";
    const r = await loginViaBrowser(h.base);
    expect(r.status).toBe(401);
    expect(h.events.find((e) => e.type === "vibe.auth.login.failure")?.reason).toBe("access_denied");
  });

  it("enforces MFA via amr when required", async () => {
    await h.stop();
    await idp.stop();
    await boot({ VIBE_OIDC_REQUIRE_MFA_AMR: "true" });
    idp.user.amr = ["pwd"];
    const r = await loginViaBrowser(h.base);
    expect(r.status).toBe(401);
    expect(h.events.find((e) => e.type === "vibe.auth.login.failure")?.reason).toBe("mfa_required");
    idp.user.amr = ["pwd", "otp"];
    const ok = await loginViaBrowser(h.base);
    expect(ok.location).toBe("/");
  });

  it("RP-initiated logout redirects to end_session with id_token_hint", async () => {
    const r = await loginViaBrowser(h.base);
    const res = await fetch(h.base + "/auth/oidc/logout", { redirect: "manual", headers: { cookie: r.cookies.join("; ") } });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname.endsWith("/end-session/")).toBe(true);
    expect(loc.searchParams.get("id_token_hint")).toBeTruthy();
    expect(loc.searchParams.get("post_logout_redirect_uri")).toContain("/auth/oidc/logged-out");
    expect(h.sessions.store.size).toBe(0);
  });

  it("back-channel logout ends sessions by sid and sub and revokes", async () => {
    const r = await loginViaBrowser(h.base);
    expect(h.sessions.store.size).toBe(1);
    const token = await idp.logoutToken({ sub: "u-100", sid: "sid-u-100" });
    const res = await fetch(h.base + "/auth/oidc/backchannel", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: token }) });
    expect(res.status).toBe(200);
    expect(h.sessions.store.size).toBe(0);
    const uid = (await h.users.findByEmail("kurt@kisaes.com"))!.id;
    expect(await h.auth.isRevoked({ userId: uid }, Date.now() - 1000)).toBe(true);
    // replay rejected
    const again = await fetch(h.base + "/auth/oidc/backchannel", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: token }) });
    expect(again.status).toBe(400);
    void r;
  });

  it("rejects logout tokens with a nonce or wrong audience", async () => {
    const bad1 = await idp.logoutToken({ sub: "u-100", withNonce: true });
    const bad2 = await idp.logoutToken({ sub: "u-100", aud: "other" });
    for (const t of [bad1, bad2]) {
      const res = await fetch(h.base + "/auth/oidc/backchannel", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: t }) });
      expect(res.status).toBe(400);
    }
  });

  it("Tauri loopback: hands off a one-time code and exchanges it for a token", async () => {
    const r = await loginViaBrowser(h.base, "/auth/oidc/start?loopback_port=50123");
    expect(r.status).toBe(200);
    const m = /http:\/\/127\.0\.0\.1:50123\/callback\?code=([^"&]+)/.exec(r.body);
    expect(m).toBeTruthy();
    const ex = await fetch(h.base + "/auth/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: decodeURIComponent(m![1]!) }) });
    expect(ex.status).toBe(200);
    const j = (await ex.json()) as { token: string; user: { email: string } };
    expect(j.token).toMatch(/^t/);
    expect(j.user.email).toBe("kurt@kisaes.com");
    const again = await fetch(h.base + "/auth/oidc/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: m![1] }) });
    expect(again.status).toBe(400);
    const bad = await fetch(h.base + "/auth/oidc/start?loopback_port=80", { redirect: "manual" });
    expect(bad.status).toBe(400);
  });
});

describe("modes and guards (Phase 3)", () => {
  it("local mode: start is 409 and local login works", async () => {
    await boot({ VIBE_AUTH_MODE: "local" });
    const res = await fetch(h.base + "/auth/oidc/start", { redirect: "manual" });
    expect(res.status).toBe(409);
    await h.users.createLocalUser({ username: "bob", email: "b@x", name: "B", role: "preparer", password: "pw" });
    const login = await fetch(h.base + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bob", password: "pw" }) });
    expect(login.status).toBe(200);
  });

  it("oidc_only: refuses to start without break-glass; with it, only break-glass may log in locally", async () => {
    idp = await new FakeIdp({ clientId: "ref-client", user: { ...baseUser } }).start();
    const env = { VIBE_AUTH_MODE: "oidc_only", VIBE_OIDC_ISSUER: idp.issuer, VIBE_OIDC_CLIENT_ID: "ref-client" };
    await expect(startHarness(env)).rejects.toThrow(/break-glass/);
    // now with the user present
    const { MemoryUsers } = await import("./harness.js");
    const users = new MemoryUsers();
    await users.createLocalUser({ username: "vibe-breakglass", email: "bg@localhost", name: "BG", role: "admin", password: "pw" });
    await users.createLocalUser({ username: "bob", email: "b@x", name: "B", role: "preparer", password: "pw" });
    h = await startHarness(env, { users });
    const bob = await fetch(h.base + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bob", password: "pw" }) });
    expect(bob.status).toBe(403);
    const bg = await fetch(h.base + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "vibe-breakglass", password: "pw" }) });
    expect(bg.status).toBe(200);
    expect(h.events.some((e) => e.type === "vibe.auth.breakglass.used")).toBe(true);
    const s = (await (await fetch(h.base + "/auth/status")).json()) as { localLoginVisible: boolean };
    expect(s.localLoginVisible).toBe(false);
  });

  it("boot tolerance: unreachable IdP leaves local login working and serves the unavailable page", async () => {
    idp = await new FakeIdp({ clientId: "ref-client", user: { ...baseUser } }).start();
    const issuer = idp.issuer;
    await idp.stop();
    h = await startHarness({ VIBE_AUTH_MODE: "both", VIBE_OIDC_ISSUER: issuer, VIBE_OIDC_CLIENT_ID: "ref-client" });
    await h.users.createLocalUser({ username: "bob", email: "b@x", name: "B", role: "preparer", password: "pw" });
    const login = await fetch(h.base + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bob", password: "pw" }) });
    expect(login.status).toBe(200);
    const start = await fetch(h.base + "/auth/oidc/start", { redirect: "manual" });
    expect(start.status).toBe(503);
    expect(await start.text()).toContain("is unavailable");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.events.some((e) => e.type === "vibe.auth.idp.unreachable")).toBe(true);
    const s = (await (await fetch(h.base + "/auth/status")).json()) as { oidc: { reachable: boolean } };
    expect(s.oidc.reachable).toBe(false);
  });
});

describe("settings API (Phase 4)", () => {
  beforeEach(() => boot({ VIBE_AUTH_MODE: "local" }));

  async function adminCookie() {
    await h.users.createLocalUser({ username: "root", email: "r@x", name: "R", role: "admin", password: "pw" });
    const res = await fetch(h.base + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "root", password: "pw" }) });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }

  it("requires admin", async () => {
    expect((await fetch(h.base + "/auth/settings")).status).toBe(403);
  });

  it("validates, stores, wraps the secret and guards oidc_only", async () => {
    const cookie = await adminCookie();
    const put = (body: unknown) => fetch(h.base + "/auth/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    let res = await put({ mode: "oidc_only" });
    expect(res.status).toBe(400);
    const errs = ((await res.json()) as { errors: string[] }).errors.join(" ");
    expect(errs).toMatch(/break-glass/);
    expect(errs).toMatch(/Test connection/);

    res = await put({ roleMap: { "vibe-admin": "superuser" } });
    expect(res.status).toBe(400);

    res = await put({ issuer: idp.issuer, clientId: "ref-client", clientSecret: "s3cret", roleMap: { "vibe-partner": "reviewer" }, mode: "both" });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { mode: string; effective: { hasSecret: boolean; roleMap: Record<string, string> }; stored: { hasSecret: boolean } };
    expect(d.mode).toBe("both");
    expect(d.effective.hasSecret).toBe(true);
    expect(d.effective.roleMap["vibe-partner"]).toBe("reviewer");
    expect(h.events.some((e) => e.type === "vibe.auth.mode.changed" && e.from === "local" && e.to === "both")).toBe(true);

    // Test connection (popup) records lastTestOk for this actor and reports the resolved role.
    const t = await fetch(h.base + "/auth/settings/test", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    const { url } = (await t.json()) as { url: string };
    const popup = await loginViaBrowser(h.base, url, [cookie]);
    expect(popup.status).toBe(200);
    expect(popup.body).toContain("vibe-auth:test-result");
    expect(popup.body).toContain("Resolved role: reviewer");
    expect(h.sessions.store.size).toBe(1); // no new session created by a test login

    // Still refused: no break-glass
    res = await put({ mode: "oidc_only" });
    expect(res.status).toBe(400);
    await h.users.createLocalUser({ username: "vibe-breakglass", email: "bg@localhost", name: "BG", role: "admin", password: "pw" });
    res = await put({ mode: "oidc_only" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mode: string }).mode).toBe("oidc_only");

    // MFA enforcement off requires ack
    res = await put({ requireMfaAmr: true });
    expect(res.status).toBe(200);
    res = await put({ requireMfaAmr: false });
    expect(res.status).toBe(400);
    res = await put({ requireMfaAmr: false, mfaAck: true });
    expect(res.status).toBe(200);
    expect(h.events.some((e) => e.type === "vibe.auth.mfa.enforcement.disabled")).toBe(true);
  });
});

describe("internal-base rewrite (§2.6)", () => {
  it("discovers through the internal base while validating the public issuer", async () => {
    idp = await new FakeIdp({ clientId: "ref-client", user: { ...baseUser }, issuer: "https://auth.firm.example/application/o/ref/" }).start();
    h = await startHarness({
      VIBE_AUTH_MODE: "both",
      VIBE_OIDC_ISSUER: "https://auth.firm.example/application/o/ref/",
      VIBE_OIDC_INTERNAL_BASE: idp.base,
      VIBE_OIDC_CLIENT_ID: "ref-client",
    });
    await new Promise((r) => setTimeout(r, 100));
    const start = await fetch(h.base + "/auth/oidc/start", { redirect: "manual" });
    expect(start.status).toBe(302);
    // authorization_endpoint is browser-facing → public host, not rewritten
    expect(start.headers.get("location")).toMatch(/^https:\/\/auth\.firm\.example\/application\/o\/ref\/authorize\//);
    const s = (await (await fetch(h.base + "/auth/status")).json()) as { oidc: { reachable: boolean; issuer: string } };
    expect(s.oidc.reachable).toBe(true);
    expect(s.oidc.issuer).toBe("https://auth.firm.example/application/o/ref/");
  });

  it("refuses an issuer mismatch", async () => {
    idp = await new FakeIdp({ clientId: "ref-client", user: { ...baseUser }, issuer: "https://other.example/application/o/ref/" }).start();
    h = await startHarness({ VIBE_AUTH_MODE: "both", VIBE_OIDC_ISSUER: "https://auth.firm.example/application/o/ref/", VIBE_OIDC_INTERNAL_BASE: idp.base, VIBE_OIDC_CLIENT_ID: "ref-client" });
    await new Promise((r) => setTimeout(r, 100));
    const s = (await (await fetch(h.base + "/auth/status")).json()) as { oidc: { reachable: boolean; lastError?: string } };
    expect(s.oidc.reachable).toBe(false);
    expect(s.oidc.lastError).toMatch(/issuer mismatch/);
  });
});

describe("step-up re-authentication (1.0.8)", () => {
  beforeEach(() => boot());

  async function signedIn() {
    const r = await loginViaBrowser(h.base, "/auth/oidc/start?return_to=/dash");
    expect(r.location).toBe("/dash");
    const sid = r.cookies.find((c) => c.startsWith("sid="))!.slice(4);
    return { cookies: r.cookies, sid };
  }

  it("re-authenticates at the IdP with prompt=login and refreshes the step-up marker", async () => {
    const s = await signedIn();
    expect(h.sessions.stepUps.size).toBe(0);
    const r = await loginViaBrowser(h.base, "/auth/oidc/start?reauth=1&return_to=/adjustments/9", [...s.cookies]);
    expect(r.location).toBe("/adjustments/9");
    const authz = idp.authorizeRequests.at(-1)!;
    expect(authz.get("prompt")).toBe("login");
    expect(authz.get("max_age")).toBe("0");
    expect(h.sessions.stepUps.has(s.sid)).toBe(true);
    // Still exactly one session, no new cookie, no second login event.
    expect(h.sessions.store.size).toBe(1);
    expect(r.cookies.filter((c) => c.startsWith("sid=")).length).toBe(1);
    expect(h.events.filter((e) => e.type === "vibe.auth.login.success")).toHaveLength(1);
    const ev = h.events.find((e) => e.type === "vibe.auth.stepup.success") as { user_id?: string; auth_time?: number } | undefined;
    expect(ev?.user_id).toBe((await h.users.findByEmail("kurt@kisaes.com"))!.id);
    expect(typeof ev?.auth_time).toBe("number");
  });

  it("rejects a re-auth whose auth_time is stale", async () => {
    const s = await signedIn();
    idp.ignorePromptLogin = true; // the OP silently reuses its session
    const r = await loginViaBrowser(h.base, "/auth/oidc/start?reauth=1", [...s.cookies]);
    expect(r.status).toBe(401);
    expect(h.events.find((e) => e.type === "vibe.auth.login.failure")?.reason).toBe("reauth_stale");
    expect(h.sessions.stepUps.size).toBe(0);
    expect(h.sessions.store.size).toBe(1);
  });

  it("rejects a re-auth as a different IdP account", async () => {
    const s = await signedIn();
    idp.user = { ...idp.user, sub: "u-200", email: "someone@else.example" };
    const r = await loginViaBrowser(h.base, "/auth/oidc/start?reauth=1", [...s.cookies]);
    expect(r.status).toBe(401);
    expect(h.events.find((e) => e.type === "vibe.auth.login.failure")?.reason).toBe("reauth_subject_mismatch");
    expect(h.sessions.stepUps.size).toBe(0);
    expect(h.users.rows.size).toBe(1); // no provisioning on the re-auth path
  });

  it("requires an existing session and a product that implements markStepUp", async () => {
    const anon = await fetch(h.base + "/auth/oidc/start?reauth=1", { redirect: "manual" });
    expect(anon.status).toBe(401);
    await h.stop();
    await idp.stop();
    idp = await new FakeIdp({ clientId: "ref-client", clientSecret: "s3cret", user: { ...baseUser } }).start();
    const { MemorySessions } = await import("./harness.js");
    const sessions = new MemorySessions();
    (sessions as { markStepUp?: unknown }).markStepUp = undefined;
    h = await startHarness({ VIBE_AUTH_MODE: "both", VIBE_OIDC_ISSUER: idp.issuer, VIBE_OIDC_CLIENT_ID: "ref-client", VIBE_OIDC_CLIENT_SECRET: "s3cret" }, { session: sessions });
    const s = await signedIn();
    const r = await fetch(h.base + "/auth/oidc/start?reauth=1", { redirect: "manual", headers: { cookie: s.cookies.join("; ") } });
    expect(r.status).toBe(409);
  });
});
