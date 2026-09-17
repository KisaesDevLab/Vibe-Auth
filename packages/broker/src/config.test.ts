import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  VIBE_AUTH_DATABASE_URL: "postgresql://u:p@postgres:5432/vibe_auth",
  VIBE_AUTH_AUTHENTIK_SECRET_KEY: "x".repeat(32),
  VIBE_AUTH_AUTHENTIK_TOKEN: "y".repeat(32),
  VIBE_AUTH_CONSOLE_TOKEN: "z".repeat(32),
  VIBE_AUTH_SECRET_KEY: "ab".repeat(32),
  VIBE_AUTH_AUTHENTIK_INTERNAL: "http://vibe-auth-authentik-server:9000",
  VIBE_AUTH_AUTHENTIK_PATH: "/auth/",
  VIBE_AUTH_BASE_PATH: "/vibe-auth/",
} as NodeJS.ProcessEnv;

// The Appliance renders VIBE_AUTH_APPLIANCE_ORIGIN per mode: http://<ip> in
// LAN (plain :80, no internal CA), https://<tunnel>.<domain> in single-host,
// https://auth.<domain> in subdomain-per-app. The scheme must follow it —
// forcing https sent LAN operators to ERR_SSL_PROTOCOL_ERROR.
describe("applyApplianceHints: scheme follows the appliance origin", () => {
  it("LAN mode (http origin) stays http, subpath routing", () => {
    const c = loadConfig({ ...base, VIBE_AUTH_APPLIANCE_ORIGIN: "http://192.168.68.50", VIBE_AUTH_APPLIANCE_MODE: "lan:single-host" });
    expect(c.VIBE_AUTH_SCHEME).toBe("http");
    expect(c.VIBE_AUTH_HOST).toBe("192.168.68.50");
    expect(c.VIBE_AUTH_ROUTING).toBe("subpath");
    expect(c.brokerPublicBase).toBe("http://192.168.68.50/vibe-auth");
    expect(c.authentikPublicBase).toBe("http://192.168.68.50/auth");
  });

  it("single-host domain (https origin) stays https, subpath routing", () => {
    const c = loadConfig({ ...base, VIBE_AUTH_APPLIANCE_ORIGIN: "https://vibe.firm.com", VIBE_AUTH_APPLIANCE_MODE: "domain:single-host" });
    expect(c.VIBE_AUTH_SCHEME).toBe("https");
    expect(c.brokerPublicBase).toBe("https://vibe.firm.com/vibe-auth");
  });

  it("subdomain-per-app strips auth. from the host and routes by subdomain", () => {
    const c = loadConfig({ ...base, VIBE_AUTH_BASE_PATH: "/", VIBE_AUTH_APPLIANCE_ORIGIN: "https://auth.firm.com", VIBE_AUTH_APPLIANCE_MODE: "domain:subdomain-per-app" });
    expect(c.VIBE_AUTH_HOST).toBe("firm.com");
    expect(c.VIBE_AUTH_ROUTING).toBe("subdomain");
    expect(c.brokerPublicBase).toBe("https://auth.firm.com");
    expect(c.authentikPublicBase).toBe("https://auth.firm.com/auth");
  });
});
