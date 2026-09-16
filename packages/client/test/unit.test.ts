import { describe, expect, it } from "vitest";
import { defaultRoleMapFor, loadEnvConfig, loopbackPortPredicate } from "../src/config.js";
import { rewriteToInternalBase, issuersMatch } from "../src/discovery.js";
import { amrSatisfiesMfa, resolveRole } from "../src/roles.js";
import { codeChallengeS256, MemoryPendingLoginStore, newPendingLogin } from "../src/pkce.js";
import { safeReturnTo, requestOrigin } from "../src/http.js";
import { MemoryRevocationList } from "../src/adapters/memory.js";
import { ROLES } from "./harness.js";

describe("config", () => {
  it("parses env with defaults and normalises the issuer", () => {
    const c = loadEnvConfig({ VIBE_OIDC_ISSUER: "https://auth.x/application/o/tb", VIBE_OIDC_REQUIRE_MFA_AMR: "yes" });
    expect(c.VIBE_AUTH_MODE).toBe("local");
    expect(c.VIBE_OIDC_ISSUER).toBe("https://auth.x/application/o/tb/");
    expect(c.VIBE_OIDC_REQUIRE_MFA_AMR).toBe(true);
    expect(c.VIBE_BREAKGLASS_USERNAME).toBe("vibe-breakglass");
  });
  it("rejects a bad mode", () => {
    expect(() => loadEnvConfig({ VIBE_AUTH_MODE: "sso" })).toThrow(/VIBE_AUTH_MODE/);
  });
  it("builds a default role map from a product vocabulary", () => {
    const m = defaultRoleMapFor(["admin", "reviewer", "preparer"], "admin");
    expect(m["vibe-admin"]).toBe("admin");
    expect(m["vibe-staff"]).toBe("preparer");
    expect(m["vibe-manager"]).toBe("reviewer");
  });
  it("parses loopback port specs", () => {
    const ok = loopbackPortPredicate("49152-65535,8123");
    expect(ok(50000)).toBe(true);
    expect(ok(8123)).toBe(true);
    expect(ok(80)).toBe(false);
  });
});

describe("discovery rewrite (§2.6)", () => {
  it("rewrites host/scheme and keeps the path", () => {
    expect(rewriteToInternalBase("https://auth.firm.example/application/o/tb/token/", "http://vibe-auth-authentik-server:9000")).toBe(
      "http://vibe-auth-authentik-server:9000/application/o/tb/token/",
    );
  });
  it("prefixes a base path when the internal base has one", () => {
    expect(rewriteToInternalBase("https://auth.x/application/o/tb/jwks/", "http://svc:9000/pfx")).toBe("http://svc:9000/pfx/application/o/tb/jwks/");
  });
  it("matches issuers regardless of trailing slash", () => {
    expect(issuersMatch("https://a/b/", "https://a/b")).toBe(true);
    expect(issuersMatch("https://a/b/", "https://a/c")).toBe(false);
  });
});

describe("roles (D22)", () => {
  const base = { roleClaim: "roles", groupsClaim: "groups", roleMap: defaultRoleMapFor(ROLES.roles, ROLES.adminRole), vocabulary: ROLES };
  it("prefers the roles claim and picks the most privileged", () => {
    const r = resolveRole({ ...base, claims: { roles: ["preparer", "admin"], groups: ["vibe-staff"] } });
    expect(r).toMatchObject({ role: "admin", source: "roles" });
  });
  it("maps groups when no roles claim", () => {
    const r = resolveRole({ ...base, claims: { groups: ["vibe-staff", "vibe-manager"] } });
    expect(r).toMatchObject({ role: "reviewer", source: "groups" });
  });
  it("uses the default role or denies", () => {
    expect(resolveRole({ ...base, claims: { groups: ["other"] }, defaultRole: "preparer" }).role).toBe("preparer");
    expect(resolveRole({ ...base, claims: { groups: ["other"] } }).role).toBeNull();
  });
  it("accepts mapped values inside the roles claim", () => {
    expect(resolveRole({ ...base, claims: { roles: ["vibe-partner"] } }).role).toBe("admin");
  });
  it("evaluates amr for MFA", () => {
    expect(amrSatisfiesMfa(["pwd"])).toBe(false);
    expect(amrSatisfiesMfa(["pwd", "otp"])).toBe(true);
    expect(amrSatisfiesMfa(["mfa"])).toBe(true);
    expect(amrSatisfiesMfa(undefined)).toBe(false);
  });
});

describe("pkce store", () => {
  it("is single-use and expires", async () => {
    const s = new MemoryPendingLoginStore(50);
    const p = newPendingLogin({ returnTo: "/" });
    await s.put(p);
    expect(await s.take(p.state)).toEqual(p);
    expect(await s.take(p.state)).toBeNull();
    const q = newPendingLogin({ returnTo: "/" });
    await s.put(q);
    await new Promise((r) => setTimeout(r, 70));
    expect(await s.take(q.state)).toBeNull();
  });
  it("computes S256 challenge", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("http helpers", () => {
  it("only allows same-origin relative return paths", () => {
    expect(safeReturnTo("/x?y=1")).toBe("/x?y=1");
    expect(safeReturnTo("//evil.example")).toBe("/");
    expect(safeReturnTo("https://evil.example")).toBe("/");
    expect(safeReturnTo(null, "/home")).toBe("/home");
  });
  it("derives origin from forwarded headers when trusted", () => {
    const req = { method: "GET", url: "/", headers: { host: "svc:3001", "x-forwarded-proto": "https", "x-forwarded-host": "tb.firm.example" }, raw: { req: {}, res: {} } };
    expect(requestOrigin(req, true)).toBe("https://tb.firm.example");
    expect(requestOrigin(req, false)).toBe("https://svc:3001");
  });
});

describe("revocation list (D16)", () => {
  it("rejects tokens issued before revocation until expiry", async () => {
    const r = new MemoryRevocationList();
    const now = Date.now();
    await r.revoke({ userId: "u1" }, new Date(now + 1000));
    expect(await r.isRevoked({ userId: "u1" }, now - 10)).toBe(true);
    expect(await r.isRevoked({ userId: "u2" }, now - 10)).toBe(false);
    expect(await r.isRevoked({ userId: "u1" }, now + 5000)).toBe(false);
  });
});
