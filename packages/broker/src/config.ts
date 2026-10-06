import { z } from "zod";

/**
 * Broker configuration (env prefix VIBE_AUTH_*, §2.1).
 *
 * Routing (COMPAT.md amendment 4 / QUESTIONS Q7):
 *   subpath   → https://{host}/auth/          (Authentik served with AUTHENTIK_WEB__PATH=/auth/) — default
 *   subdomain → https://auth.{host}/          (standalone only; the Appliance always uses subpath on the host it renders)
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
   * from the origin (its host and scheme verbatim, subpath routing).
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
  /** Container-level outbound mail (same values the compose file hands authentik as AUTHENTIK_EMAIL__*). Admin-entered settings override them. */
  VIBE_AUTH_SMTP_HOST: z.string().trim().optional().transform((s) => s || undefined),
  VIBE_AUTH_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  VIBE_AUTH_SMTP_USER: z.string().optional(),
  VIBE_AUTH_SMTP_PASS: z.string().optional(),
  VIBE_AUTH_SMTP_TLS: bool.default(true),
  VIBE_AUTH_SMTP_FROM: z.string().default("vibe-auth@localhost"),
  VIBE_AUTH_EVENT_POLL_SECONDS: z.coerce.number().int().min(0).default(30),
  VIBE_AUTH_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  VIBE_AUTH_VERSION: z.string().default(process.env.npm_package_version ?? "1.0.18"),
});

export type BrokerConfig = z.infer<typeof schema> & {
  /** Browser-facing Authentik base, no trailing slash, e.g. https://firm.example/auth */
  authentikPublicBase: string;
  /** Server-to-server Authentik base incl. subpath when in subpath mode. */
  authentikInternalBase: string;
  /** Browser-facing broker base, e.g. https://firm.example/vibe-auth */
  brokerPublicBase: string;
  /** Path the admin console's own sign-in routes live under: `${brokerAuthPath}/auth/oidc/*`. */
  brokerAuthPath: string;
};

/**
 * The admin console signs in through the client package, whose routes are
 * `${basePath}/auth/...`. A root-served broker (base path "", the Appliance's
 * subdomain-per-app mode) would put them at /auth/oidc/*, inside the /auth/*
 * mount the proxy hands to authentik: the browser got authentik's "Not Found"
 * and no admin could sign in. Those routes move under /broker there.
 */
export function computeBrokerAuthPath(c: z.infer<typeof schema>): string {
  const collides = (c.VIBE_AUTH_BASE_PATH + "/auth/").startsWith(c.VIBE_AUTH_AUTHENTIK_PATH);
  return collides ? c.VIBE_AUTH_BASE_PATH + "/broker" : c.VIBE_AUTH_BASE_PATH;
}

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

/**
 * Derive host/scheme/routing from the Appliance-rendered origin + mode (see env template).
 *
 * The scheme follows the origin. In the Appliance's LAN mode the origin is
 * http://<ip>: Caddy binds :443 with `tls internal` there, but its internal CA
 * issues no certificate for a bare IP, so https://<ip> fails the handshake
 * (ERR_SSL_PROTOCOL_ERROR) and every product runs on http. Forcing https here
 * sent every sign-in and setup URL to that dead address. Domain and Tailscale
 * modes render an https origin and keep https.
 *
 * The host is the origin's host verbatim, in every mode (1.0.9). The origin
 * is already the exact host the Appliance serves this app on, so authentik
 * is always {origin}/auth. Subdomain-per-app used to strip a literal "auth."
 * and re-add it through `subdomain` routing, which pinned the label: an
 * operator-named host (auth-office2.firm.com, sso.firm.com — needed when two
 * appliances share one domain) came out as auth.auth-office2.firm.com.
 */
export function applyApplianceHints(c: z.infer<typeof schema>): z.infer<typeof schema> {
  if (!c.VIBE_AUTH_APPLIANCE_ORIGIN) return c;
  const u = new URL(c.VIBE_AUTH_APPLIANCE_ORIGIN);
  const scheme = u.protocol === "http:" ? "http" : "https";
  return { ...c, VIBE_AUTH_HOST: u.host, VIBE_AUTH_SCHEME: scheme, VIBE_AUTH_ROUTING: "subpath" };
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
  return { ...c, authentikPublicBase, authentikInternalBase, brokerPublicBase: brokerHost + c.VIBE_AUTH_BASE_PATH, brokerAuthPath: computeBrokerAuthPath(c) };
}

/** Recompute public bases for /rebase without restarting (host/routing change, D9). */
export function rebaseConfig(c: BrokerConfig, patch: { host?: string; routing?: BrokerConfig["VIBE_AUTH_ROUTING"]; scheme?: BrokerConfig["VIBE_AUTH_SCHEME"]; publicUrl?: string | null }): BrokerConfig {
  const next = {
    ...c,
    VIBE_AUTH_HOST: patch.host ?? c.VIBE_AUTH_HOST,
    VIBE_AUTH_ROUTING: patch.routing ?? c.VIBE_AUTH_ROUTING,
    VIBE_AUTH_SCHEME: patch.scheme ?? c.VIBE_AUTH_SCHEME,
    VIBE_AUTH_PUBLIC_URL: patch.publicUrl === null ? undefined : (patch.publicUrl ?? c.VIBE_AUTH_PUBLIC_URL),
    // A root-served broker has base path "" after parsing; loadConfig reads ""
    // as unset and would fall back to /vibe-auth. "/" round-trips to "".
    VIBE_AUTH_BASE_PATH: c.VIBE_AUTH_BASE_PATH || "/",
  };
  return loadConfig(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === undefined ? undefined : String(v)])) as NodeJS.ProcessEnv);
}
