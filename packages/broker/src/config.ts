import { z } from "zod";

/**
 * Broker configuration (env prefix VIBE_AUTH_*, §2.1).
 *
 * Routing (COMPAT.md amendment 4 / QUESTIONS Q7):
 *   subpath   → https://{host}/auth/          (Authentik served with AUTHENTIK_WEB__PATH=/auth/) — default
 *   subdomain → https://auth.{host}/          (domain mode, subdomain-per-app)
 *   port      → https://{host}:8443/          (original D9 for LAN mode)
 */
const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(v)));

export const schema = z.object({
  VIBE_AUTH_PORT: z.coerce.number().int().default(8080),
  /** Path the broker is mounted at behind Caddy ("" when root-served, e.g. subdomain-per-app). */
  VIBE_AUTH_BASE_PATH: z
    .string()
    .default("/vibe-auth")
    .transform((s) => {
      const t = s.replace(/^\/+|\/+$/g, "");
      return t ? "/" + t : "";
    }),
  VIBE_AUTH_ROUTING: z.enum(["subpath", "subdomain", "port"]).default("subpath"),
  /** Firm host: domain, Tailscale FQDN, or LAN IP (D9). */
  VIBE_AUTH_HOST: z.string().min(1),
  VIBE_AUTH_SCHEME: z.enum(["http", "https"]).default("https"),
  /**
   * Appliance integration: the app's ALLOWED_ORIGIN and "<mode>:<domain-routing-mode>"
   * as rendered by lib/enable-app.sh. When set, host/scheme/routing are derived
   * from them (https always; subdomain routing in subdomain-per-app, else subpath).
   */
  VIBE_AUTH_APPLIANCE_ORIGIN: z.string().url().optional(),
  VIBE_AUTH_APPLIANCE_MODE: z.string().optional(),
  VIBE_AUTH_AUTHENTIK_PATH: z.string().default("/auth/").transform((s) => "/" + s.replace(/^\/+|\/+$/g, "") + "/"),
  VIBE_AUTH_PORT_EXTERNAL: z.coerce.number().int().default(8443),
  /** Explicit override of the browser-facing Authentik base (wins over routing). */
  VIBE_AUTH_PUBLIC_URL: z.string().url().optional(),
  VIBE_AUTH_AUTHENTIK_INTERNAL: z.string().url().default("http://vibe-auth-authentik-server:9000"),
  VIBE_AUTH_AUTHENTIK_TOKEN: z.string().min(8),
  VIBE_AUTH_CONSOLE_TOKEN: z.string().min(16),
  /** hex-encoded 32 bytes; wraps client secrets at rest. */
  VIBE_AUTH_SECRET_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  VIBE_AUTH_PG_MODE: z.enum(["shared", "bundled"]).default("shared"),
  VIBE_AUTH_DATABASE_URL: z.string().min(1),
  /** Optional superuser URL used once to create the vibe_auth database/role when absent (D7). */
  VIBE_AUTH_PG_ADMIN_URL: z.string().optional(),
  VIBE_AUTH_SETUP_TOKEN: z.string().optional(),
  VIBE_AUTH_BRAND_NAME: z.string().default("Vibe Auth"),
  VIBE_AUTH_MFA_REQUIRED: bool.default(true),
  VIBE_AUTH_AUDIT_FILE: z.string().default("/data/audit.jsonl"),
  VIBE_AUTH_SENTINEL_URL: z.string().url().optional(),
  VIBE_AUTH_SENTINEL_TOKEN: z.string().optional(),
  VIBE_AUTH_EVENT_POLL_SECONDS: z.coerce.number().int().min(0).default(30),
  VIBE_AUTH_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  VIBE_AUTH_VERSION: z.string().default(process.env.npm_package_version ?? "0.1.0"),
});

export type BrokerConfig = z.infer<typeof schema> & {
  /** Browser-facing Authentik base, no trailing slash, e.g. https://firm.example/auth */
  authentikPublicBase: string;
  /** Server-to-server Authentik base incl. subpath when in subpath mode. */
  authentikInternalBase: string;
  /** Browser-facing broker base, e.g. https://firm.example/vibe-auth */
  brokerPublicBase: string;
};

/**
 * authentik always runs with AUTHENTIK_WEB__PATH (default /auth/) so ONE
 * container config serves every routing mode; only the host part differs:
 *   subpath   https://{host}/auth
 *   subdomain https://auth.{host}/auth
 *   port      https://{host}:8443/auth
 */
export function computePublicBase(c: z.infer<typeof schema>): string {
  if (c.VIBE_AUTH_PUBLIC_URL) return c.VIBE_AUTH_PUBLIC_URL.replace(/\/+$/, "");
  const path = c.VIBE_AUTH_AUTHENTIK_PATH.replace(/\/$/, "");
  switch (c.VIBE_AUTH_ROUTING) {
    case "subdomain":
      return `${c.VIBE_AUTH_SCHEME}://auth.${c.VIBE_AUTH_HOST}${path}`;
    case "port":
      return `${c.VIBE_AUTH_SCHEME}://${c.VIBE_AUTH_HOST}:${c.VIBE_AUTH_PORT_EXTERNAL}${path}`;
    case "subpath":
    default:
      return `${c.VIBE_AUTH_SCHEME}://${c.VIBE_AUTH_HOST}${path}`;
  }
}

/** Derive host/scheme/routing from the Appliance-rendered origin + mode (see env template). */
function applyApplianceHints(c: z.infer<typeof schema>): z.infer<typeof schema> {
  if (!c.VIBE_AUTH_APPLIANCE_ORIGIN) return c;
  const u = new URL(c.VIBE_AUTH_APPLIANCE_ORIGIN);
  const perApp = /subdomain-per-app$/.test(c.VIBE_AUTH_APPLIANCE_MODE ?? "");
  const host = perApp ? u.host.replace(/^auth\./, "") : u.host;
  return { ...c, VIBE_AUTH_HOST: host, VIBE_AUTH_SCHEME: "https", VIBE_AUTH_ROUTING: perApp ? "subdomain" : "subpath" };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const picked: Record<string, string | undefined> = {};
  for (const k of Object.keys(schema.shape)) picked[k] = env[k] === "" ? undefined : env[k];
  if (!picked.VIBE_AUTH_HOST && picked.VIBE_AUTH_APPLIANCE_ORIGIN) picked.VIBE_AUTH_HOST = "appliance";
  const parsed = schema.safeParse(picked);
  if (!parsed.success) {
    throw new Error("vibe-auth broker: invalid configuration: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const c = applyApplianceHints(parsed.data);
  const authentikPublicBase = computePublicBase(c);
  const internal = c.VIBE_AUTH_AUTHENTIK_INTERNAL.replace(/\/+$/, "");
  const authentikInternalBase = c.VIBE_AUTH_PUBLIC_URL ? internal : internal + c.VIBE_AUTH_AUTHENTIK_PATH.replace(/\/$/, "");
  const brokerHost =
    c.VIBE_AUTH_ROUTING === "subdomain"
      ? `${c.VIBE_AUTH_SCHEME}://auth.${c.VIBE_AUTH_HOST}`
      : c.VIBE_AUTH_ROUTING === "port"
        ? `${c.VIBE_AUTH_SCHEME}://${c.VIBE_AUTH_HOST}:${c.VIBE_AUTH_PORT_EXTERNAL}`
        : `${c.VIBE_AUTH_SCHEME}://${c.VIBE_AUTH_HOST}`;
  return { ...c, authentikPublicBase, authentikInternalBase, brokerPublicBase: brokerHost + c.VIBE_AUTH_BASE_PATH };
}

/** Recompute public bases for /rebase without restarting (host/routing change, D9). */
export function rebaseConfig(c: BrokerConfig, patch: { host?: string; routing?: BrokerConfig["VIBE_AUTH_ROUTING"]; scheme?: BrokerConfig["VIBE_AUTH_SCHEME"]; publicUrl?: string | null }): BrokerConfig {
  const next = {
    ...c,
    VIBE_AUTH_HOST: patch.host ?? c.VIBE_AUTH_HOST,
    VIBE_AUTH_ROUTING: patch.routing ?? c.VIBE_AUTH_ROUTING,
    VIBE_AUTH_SCHEME: patch.scheme ?? c.VIBE_AUTH_SCHEME,
    VIBE_AUTH_PUBLIC_URL: patch.publicUrl === null ? undefined : (patch.publicUrl ?? c.VIBE_AUTH_PUBLIC_URL),
  };
  return loadConfig(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === undefined ? undefined : String(v)])) as NodeJS.ProcessEnv);
}
