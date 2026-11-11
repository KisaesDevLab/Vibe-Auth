import type { SecretWrap, SettingsStore, StoredAuthSettings } from "./adapters/types.js";
import { defaultBreakglassEmail, defaultRoleMapFor, type EffectiveConfig, type EnvConfig, type OidcConfig, type RoleVocabulary } from "./config.js";

/**
 * Effective config = env defaults overridden by values stored from the
 * product's Settings → Authentication page. Stored client secrets are wrapped
 * with the product's SecretWrap (D24).
 *
 * D35: when the environment sets VIBE_OIDC_CLIENT_ID (the Appliance registered
 * the product, or an operator set it by hand), the environment owns the
 * connection: issuer, internal base, client ID and client secret come from env
 * only, and stored copies are ignored (a stale internal base or secret from an
 * old registration breaks sign-in as surely as a stale client ID). A re-registration then
 * takes effect at the next restart instead of losing to an old copy saved on
 * the settings page.
 */

/** The connection fields the environment owns once it sets VIBE_OIDC_CLIENT_ID (D35). */
export const ENV_OWNED_FIELDS = ["issuer", "internalBase", "clientId", "clientSecret"] as const;

/** True when the environment owns the connection (D35). */
export function envManaged(env: EnvConfig): boolean {
  return !!env.VIBE_OIDC_CLIENT_ID;
}

/** Stored connection values the environment overrides and that differ from it (for a boot warning). */
export function ignoredStoredConnection(env: EnvConfig, stored: StoredAuthSettings | null): string[] {
  if (!envManaged(env) || !stored) return [];
  const norm = (v?: string) => (v ?? "").replace(/\/+$/, "");
  const out: string[] = [];
  if (stored.clientId && stored.clientId !== env.VIBE_OIDC_CLIENT_ID) out.push("clientId");
  if (stored.issuer && norm(stored.issuer) !== norm(env.VIBE_OIDC_ISSUER)) out.push("issuer");
  if (stored.internalBase && norm(stored.internalBase) !== norm(env.VIBE_OIDC_INTERNAL_BASE)) out.push("internalBase");
  if (stored.clientSecretWrapped) out.push("clientSecret");
  return out;
}

export interface ResolveInput {
  env: EnvConfig;
  stored: StoredAuthSettings | null;
  vocabulary: RoleVocabulary;
  secretWrap: SecretWrap;
  /** Base for redirect URIs: publicUrl + basePath. May be undefined → derived per request. */
  publicBase?: string;
  /** The product's break-glass address when it is not the env/default one (VibeAuthOptions.breakglassEmail). */
  breakglassEmail?: string;
}

export async function resolveEffectiveConfig(i: ResolveInput): Promise<EffectiveConfig> {
  const s = i.stored ?? {};
  const mode = s.mode ?? i.env.VIBE_AUTH_MODE;
  const managed = envManaged(i.env);
  const issuer = managed ? i.env.VIBE_OIDC_ISSUER : (s.issuer ?? i.env.VIBE_OIDC_ISSUER);
  const clientId = managed ? i.env.VIBE_OIDC_CLIENT_ID : (s.clientId ?? i.env.VIBE_OIDC_CLIENT_ID);
  const internalBase = managed ? i.env.VIBE_OIDC_INTERNAL_BASE : (s.internalBase ?? i.env.VIBE_OIDC_INTERNAL_BASE);

  let oidc: OidcConfig | null = null;
  if (issuer && clientId) {
    let clientSecret = i.env.VIBE_OIDC_CLIENT_SECRET;
    if (s.clientSecretWrapped && !managed) {
      try {
        clientSecret = await i.secretWrap.unwrap(s.clientSecretWrapped);
      } catch {
        // Fall back to env secret; the settings page will show "secret unreadable".
      }
    }
    const base = i.publicBase ?? "";
    oidc = {
      issuer: issuer.replace(/\/+$/, "") + "/",
      internalBase,
      clientId,
      clientSecret,
      redirectUri: `${base}/auth/oidc/callback`,
      postLogoutRedirectUri: `${base}/auth/oidc/logged-out`,
      scopes: i.env.VIBE_OIDC_SCOPES,
      requireMfaAmr: s.requireMfaAmr ?? i.env.VIBE_OIDC_REQUIRE_MFA_AMR,
      roleClaim: i.env.VIBE_OIDC_ROLE_CLAIM,
      groupsClaim: i.env.VIBE_OIDC_GROUPS_CLAIM,
      roleMap: s.roleMap ?? i.env.VIBE_OIDC_ROLE_MAP ?? i.vocabulary.defaultRoleMap ?? defaultRoleMapFor(i.vocabulary.roles, i.vocabulary.adminRole),
      defaultRole: s.defaultRole ?? i.env.VIBE_OIDC_DEFAULT_ROLE,
      allowJit: s.allowJit ?? i.env.VIBE_OIDC_ALLOW_JIT,
      idpName: s.idpName ?? i.env.VIBE_OIDC_IDP_NAME,
      clockTolerance: i.env.VIBE_OIDC_CLOCK_TOLERANCE,
    };
  }

  return { mode, oidc, breakglassUsername: i.env.VIBE_BREAKGLASS_USERNAME, breakglassEmail: (i.breakglassEmail ?? i.env.VIBE_BREAKGLASS_EMAIL ?? defaultBreakglassEmail(i.env.VIBE_BREAKGLASS_USERNAME)).toLowerCase() };
}

/** In-memory settings store (tests, ref-app). Products use createPgStores(). */
export class MemorySettingsStore implements SettingsStore {
  private value: StoredAuthSettings | null = null;
  async get() {
    return this.value;
  }
  async set(next: StoredAuthSettings) {
    this.value = { ...next };
  }
}

/** Plaintext "wrap" for products that have no key-wrap yet. Logs a warning once. */
export function plaintextSecretWrap(warn: (msg: string) => void = console.warn): SecretWrap {
  let warned = false;
  return {
    async wrap(p) {
      if (!warned) {
        warned = true;
        warn("vibe-auth: no SecretWrap configured; client secrets stored in plaintext (D24 requires the product key-wrap)");
      }
      return "plain:" + p;
    },
    async unwrap(w) {
      return w.startsWith("plain:") ? w.slice(6) : w;
    },
  };
}
