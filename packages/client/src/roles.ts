import type { RoleVocabulary } from "./config.js";

/**
 * Role resolution (D22): the `roles` claim (Entra App Roles, or the Vibe Auth
 * `roles` scope mapping) is preferred; otherwise groups are mapped through the
 * role map. The most privileged product role wins when several match.
 */

export interface RoleResolutionInput {
  claims: Record<string, unknown>;
  roleClaim: string;
  groupsClaim: string;
  roleMap: Record<string, string>;
  defaultRole?: string;
  vocabulary: RoleVocabulary;
}

export interface RoleResolution {
  role: string | null;
  source: "roles" | "groups" | "default" | "none";
  matched: string[];
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

export function mostPrivileged(candidates: string[], vocabulary: RoleVocabulary): string | null {
  const order = vocabulary.roles;
  let best: string | null = null;
  let bestIdx = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const idx = order.indexOf(c);
    if (idx >= 0 && idx < bestIdx) {
      best = c;
      bestIdx = idx;
    }
  }
  return best;
}

export function resolveRole(i: RoleResolutionInput): RoleResolution {
  const map = i.roleMap;
  const vocab = i.vocabulary;

  const roleValues = asStringArray(i.claims[i.roleClaim]);
  if (roleValues.length) {
    // Direct product roles OR mapped values are both accepted from the roles claim.
    const mapped = roleValues.map((r) => (vocab.roles.includes(r) ? r : map[r])).filter((r): r is string => !!r);
    const role = mostPrivileged(mapped, vocab);
    if (role) return { role, source: "roles", matched: roleValues };
  }

  const groupValues = asStringArray(i.claims[i.groupsClaim]);
  if (groupValues.length) {
    const mapped = groupValues.map((g) => map[g]).filter((r): r is string => !!r);
    const role = mostPrivileged(mapped, vocab);
    if (role) return { role, source: "groups", matched: groupValues };
  }

  if (i.defaultRole && vocab.roles.includes(i.defaultRole)) {
    return { role: i.defaultRole, source: "default", matched: [] };
  }
  return { role: null, source: "none", matched: [...roleValues, ...groupValues] };
}

/** MFA check on the amr claim (VIBE_OIDC_REQUIRE_MFA_AMR). */
export const MFA_AMR_VALUES = new Set(["mfa", "otp", "hwk", "swk", "sms", "tel", "fido", "webauthn", "totp", "pop", "user", "pin", "face", "fpt", "iris", "vbm"]);

export function amrSatisfiesMfa(amr: unknown): boolean {
  const values = asStringArray(amr).map((s) => s.toLowerCase());
  if (values.includes("mfa")) return true;
  // pwd + any second factor counts as MFA.
  const second = values.filter((v) => v !== "pwd" && MFA_AMR_VALUES.has(v));
  return second.length > 0 && (values.includes("pwd") || values.length >= 2);
}
