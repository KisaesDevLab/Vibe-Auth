import type { SecretWrap, SettingsStore, StoredAuthSettings } from "./adapters/types.js";
import { defaultRoleMapFor, type EffectiveConfig, type EnvConfig, type OidcConfig, type RoleVocabulary } from "./config.js";

/**
 * Effective config = env defaults overridden by values stored from the
 * product's Settings → Authentication page. Stored client secrets are wrapped
 * with the product's SecretWrap (D24).
 */

export interface ResolveInput {
  env: EnvConfig;
  stored: StoredAuthSettings | null;
  vocabulary: RoleVocabulary;
  secretWrap: SecretWrap;
  /** Base for redirect URIs: publicUrl + basePath. May be undefined → derived per request. */
  publicBase?: string;
}

export async function resolveEffectiveConfig(i: ResolveInput): Promise<EffectiveConfig> {
  const s = i.stored ?? {};
  const mode = s.mode ?? i.env.VIBE_AUTH_MODE;
  const issuer = s.issuer ?? i.env.VIBE_OIDC_ISSUER;
  const clientId = s.clientId ?? i.env.VIBE_OIDC_CLIENT_ID;

  let oidc: OidcConfig | null = null;
  if (issuer && clientId) {
    let clientSecret = i.env.VIBE_OIDC_CLIENT_SECRET;
    if (s.clientSecretWrapped) {
      try {
        clientSecret = await i.secretWrap.unwrap(s.clientSecretWrapped);
      } catch {
        // Fall back to env secret; the settings page will show "secret unreadable".
      }
    }
    const base = i.publicBase ?? "";
    oidc = {
      issuer: issuer.replace(/\/+$/, "") + "/",
      internalBase: s.internalBase ?? i.env.VIBE_OIDC_INTERNAL_BASE,
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

  return { mode, oidc, breakglassUsername: i.env.VIBE_BREAKGLASS_USERNAME };
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
