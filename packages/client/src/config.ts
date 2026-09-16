import { z } from "zod";

/**
 * Environment-level configuration (§2.6 + VIBE_AUTH_MODE).
 *
 * The console writes the VIBE_OIDC_* block returned by the broker's
 * registration API into the product's env. A firm may also configure OIDC
 * from the product's own Settings → Authentication page; stored settings
 * override env (see settings.ts → resolveEffectiveConfig).
 */

export const AUTH_MODES = ["local", "both", "oidc_only"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(v.trim())));

const issuerUrl = z
  .string()
  .trim()
  .url()
  .transform((u) => u.replace(/\/+$/, "") + "/");

const baseUrl = z
  .string()
  .trim()
  .url()
  .transform((u) => u.replace(/\/+$/, ""));

export const envSchema = z.object({
  VIBE_AUTH_MODE: z.enum(AUTH_MODES).default("local"),
  VIBE_OIDC_ISSUER: issuerUrl.optional(),
  VIBE_OIDC_INTERNAL_BASE: baseUrl.optional(),
  VIBE_OIDC_CLIENT_ID: z.string().trim().min(1).optional(),
  VIBE_OIDC_CLIENT_SECRET: z.string().trim().min(1).optional(),
  /** Public base URL of this product INCLUDING its path prefix (e.g. https://firm.example/tb); redirect/logout URIs are built from it. */
  VIBE_OIDC_PUBLIC_URL: baseUrl.optional(),
  VIBE_OIDC_SCOPES: z.string().trim().default("openid profile email"),
  VIBE_OIDC_REQUIRE_MFA_AMR: bool.default(false),
  VIBE_OIDC_ROLE_CLAIM: z.string().trim().default("roles"),
  VIBE_OIDC_GROUPS_CLAIM: z.string().trim().default("groups"),
  /** JSON object: { "<claim value>": "<product role>" } */
  VIBE_OIDC_ROLE_MAP: z
    .string()
    .trim()
    .optional()
    .transform((s) => (s ? (JSON.parse(s) as Record<string, string>) : undefined)),
  VIBE_OIDC_DEFAULT_ROLE: z.string().trim().optional(),
  VIBE_OIDC_ALLOW_JIT: bool.default(true),
  VIBE_OIDC_IDP_NAME: z.string().trim().default("Vibe Auth"),
  /** Clock skew tolerance in seconds for token validation. */
  VIBE_OIDC_CLOCK_TOLERANCE: z.coerce.number().int().min(0).max(300).default(60),
  VIBE_BREAKGLASS_USERNAME: z.string().trim().default("vibe-breakglass"),
  VIBE_BREAKGLASS_PASSWORD: z.string().optional(),
  /** Tauri loopback ports allowed for desktop login: comma list and/or ranges ("49152-65535"). */
  VIBE_OIDC_LOOPBACK_PORTS: z.string().trim().default("49152-65535"),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const picked: Record<string, string | undefined> = {};
  // Empty values count as unset: the Appliance clears keys by writing KEY= (never deleting lines).
  for (const key of Object.keys(envSchema.shape)) picked[key] = env[key] === "" ? undefined : env[key];
  const parsed = envSchema.safeParse(picked);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`vibe-auth: invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

/** Effective OIDC configuration after merging env + stored settings. */
export interface OidcConfig {
  issuer: string;
  internalBase?: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string;
  requireMfaAmr: boolean;
  roleClaim: string;
  groupsClaim: string;
  roleMap: Record<string, string>;
  defaultRole?: string;
  allowJit: boolean;
  idpName: string;
  clockTolerance: number;
}

export interface EffectiveConfig {
  mode: AuthMode;
  oidc: OidcConfig | null;
  breakglassUsername: string;
}

/** Product role vocabulary and defaults supplied by the integrating product. */
export interface RoleVocabulary {
  /** Product roles in order of privilege (most privileged first). */
  roles: readonly string[];
  /** The role granted to the break-glass user and required for the settings API. */
  adminRole: string;
  /** Default mapping from Vibe Auth groups / Entra app roles to product roles. */
  defaultRoleMap?: Record<string, string>;
}

export const DEFAULT_VIBE_GROUPS = ["vibe-admin", "vibe-partner", "vibe-manager", "vibe-staff", "vibe-it"] as const;

/** Builds a sensible default role map for a product with the given role vocabulary. */
export function defaultRoleMapFor(roles: readonly string[], adminRole: string): Record<string, string> {
  const has = (r: string) => roles.includes(r);
  const least = roles[roles.length - 1] ?? adminRole;
  const pick = (...candidates: string[]) => candidates.find(has) ?? least;
  return {
    "vibe-admin": adminRole,
    "vibe-it": adminRole,
    "vibe-partner": pick("partner", "owner", "admin", adminRole),
    "vibe-manager": pick("manager", "reviewer", "editor", "user"),
    "vibe-staff": pick("staff", "preparer", "member", "user", "viewer"),
  };
}

/** Parses "a,b,c-d" into a predicate over ports. */
export function loopbackPortPredicate(spec: string): (port: number) => boolean {
  const ranges: Array<[number, number]> = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    ranges.push([Math.min(a, b), Math.max(a, b)]);
  }
  return (port) => Number.isInteger(port) && ranges.some(([a, b]) => port >= a && port <= b);
}
