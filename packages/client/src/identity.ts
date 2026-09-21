import type { IdentityStore, UserAdapter, VibeUser } from "./adapters/types.js";
import type { Audit } from "./audit.js";
import type { RoleVocabulary } from "./config.js";
import { resolveRole } from "./roles.js";

/**
 * Identity linking (Phase 3):
 *   1. (issuer, sub) is the primary link.
 *   2. Otherwise a VERIFIED email may link to an existing user.
 *   3. Otherwise JIT-provision when allowed.
 *   4. Unverified emails are never used to link or provision.
 */

export interface LinkInput {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  claims: Record<string, unknown>;
  roleClaim: string;
  groupsClaim: string;
  roleMap: Record<string, string>;
  defaultRole?: string;
  allowJit: boolean;
  vocabulary: RoleVocabulary;
  /** When true, role is re-evaluated on every login and written back if changed. */
  syncRoles: boolean;
  ip?: string;
}

export type LinkResult =
  | { ok: true; user: VibeUser; how: "linked" | "email" | "jit"; role: string }
  | { ok: false; reason: "no_role" | "unverified_email" | "no_email" | "jit_disabled" | "inactive" };

/**
 * Write a synced role, unless that would demote the last active admin. Role sync runs on the FIRST
 * SSO sign-in of an existing local account too; the seeded admin whose IdP groups map lower is the
 * natural state right after enabling SSO, and demoting it leaves nobody who can open the product's
 * user admin or its Authentication page. Returns the role the user ends up with.
 */
async function syncRole(users: UserAdapter, audit: Audit, user: VibeUser, to: string, source: string, vocabulary: RoleVocabulary): Promise<string> {
  const demotesAdmin = user.role === vocabulary.adminRole && to !== vocabulary.adminRole;
  if (demotesAdmin && users.countOtherActiveAdmins && (await users.countOtherActiveAdmins(user.id)) === 0) {
    await audit("vibe.auth.role.changed", { user_id: user.id, from: user.role, to, source, refused: true, reason: "last_admin" });
    return user.role;
  }
  const applied = await users.setRole(user.id, to);
  if (applied === false) {
    await audit("vibe.auth.role.changed", { user_id: user.id, from: user.role, to, source, refused: true, reason: "adapter_refused" });
    return user.role;
  }
  await audit("vibe.auth.role.changed", { user_id: user.id, from: user.role, to, source });
  return to;
}

export async function linkOrProvision(users: UserAdapter, identities: IdentityStore, audit: Audit, i: LinkInput): Promise<LinkResult> {
  const now = new Date();
  const email = i.email?.trim().toLowerCase();
  const resolution = resolveRole({
    claims: i.claims,
    roleClaim: i.roleClaim,
    groupsClaim: i.groupsClaim,
    roleMap: i.roleMap,
    defaultRole: i.defaultRole,
    vocabulary: i.vocabulary,
  });

  // 1. Existing link.
  const existing = await identities.findByIssuerSubject(i.issuer, i.subject);
  if (existing) {
    const user = await users.findById(existing.userId);
    if (user) {
      if (!user.active) return { ok: false, reason: "inactive" };
      await identities.touch(i.issuer, i.subject, now);
      let role = user.role;
      if (i.syncRoles && resolution.role && resolution.role !== user.role) role = await syncRole(users, audit, user, resolution.role, resolution.source, i.vocabulary);
      return { ok: true, user: { ...user, role }, how: "linked", role };
    }
    // Dangling link (user deleted): drop it and fall through.
    await identities.unlink(i.issuer, i.subject);
  }

  if (!email) return { ok: false, reason: "no_email" };
  if (!i.emailVerified) return { ok: false, reason: "unverified_email" };

  // 2. Verified-email link to an existing local user.
  const byEmail = await users.findByEmail(email);
  if (byEmail) {
    if (!byEmail.active) return { ok: false, reason: "inactive" };
    await identities.link({ userId: byEmail.id, issuer: i.issuer, subject: i.subject, email, emailVerified: true, lastLoginAt: now });
    await audit("vibe.auth.user.linked", { user_id: byEmail.id, issuer: i.issuer, sub: i.subject });
    let role = byEmail.role;
    if (i.syncRoles && resolution.role && resolution.role !== byEmail.role) role = await syncRole(users, audit, byEmail, resolution.role, resolution.source, i.vocabulary);
    return { ok: true, user: { ...byEmail, role }, how: "email", role };
  }

  // 3. JIT.
  if (!i.allowJit) return { ok: false, reason: "jit_disabled" };
  if (!resolution.role) return { ok: false, reason: "no_role" };
  const created = await users.create({
    email,
    name: i.name,
    role: resolution.role,
    emailVerified: true,
    issuer: i.issuer,
    subject: i.subject,
  });
  await identities.link({ userId: created.id, issuer: i.issuer, subject: i.subject, email, emailVerified: true, lastLoginAt: now });
  await audit("vibe.auth.user.provisioned", { user_id: created.id, issuer: i.issuer, sub: i.subject, email, role: resolution.role });
  return { ok: true, user: created, how: "jit", role: resolution.role };
}
