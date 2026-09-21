import { randomBytes } from "node:crypto";
import type { UserAdapter, VibeUser } from "./adapters/types.js";
import type { Audit } from "./audit.js";
import { defaultBreakglassEmail } from "./config.js";

/**
 * Break-glass local admin (D12). The console runs `vibe-auth breakglass ensure`
 * inside each SSO-capable product on first registration, captures the printed
 * password once and stores it in the Appliance secret store.
 */

export interface BreakglassOptions {
  users: UserAdapter;
  audit: Audit;
  username: string;
  adminRole: string;
  /** Email for the account; defaults to `${username}@vibe-auth.local` (dotted: "@localhost" fails most login validators). */
  email?: string;
  /** Explicit password (e.g. VIBE_BREAKGLASS_PASSWORD). Generated when omitted. */
  password?: string;
  actor?: string;
}

export interface BreakglassResult {
  status: "created" | "exists" | "rotated" | "reactivated";
  username: string;
  userId: string;
  /** Present only when a new password was set. Print once, never log. */
  password?: string;
}

export function generatePassword(bytes = 24): string {
  // URL-safe, no ambiguous characters, ~32 chars.
  return randomBytes(bytes).toString("base64").replace(/[+/=]/g, "").slice(0, 32);
}

export async function breakglassEnsure(o: BreakglassOptions): Promise<BreakglassResult> {
  const existing = await o.users.findByUsername(o.username);
  if (existing) {
    if (!existing.active && o.users.setActive) {
      await o.users.setActive(existing.id, true);
      const password = o.password ?? generatePassword();
      await o.users.setLocalPassword(existing.id, password);
      await o.audit("vibe.auth.breakglass.rotated", { actor: o.actor ?? "cli", reason: "reactivated" });
      return { status: "reactivated", username: o.username, userId: existing.id, password };
    }
    return { status: "exists", username: o.username, userId: existing.id };
  }
  const password = o.password ?? generatePassword();
  const user: VibeUser = await o.users.createLocalUser({
    username: o.username,
    email: o.email ?? defaultBreakglassEmail(o.username),
    name: "Vibe Auth break-glass admin",
    role: o.adminRole,
    password,
  });
  await o.audit("vibe.auth.breakglass.rotated", { actor: o.actor ?? "cli", reason: "created" });
  return { status: "created", username: o.username, userId: user.id, password };
}

export async function breakglassRotate(o: BreakglassOptions): Promise<BreakglassResult> {
  const existing = await o.users.findByUsername(o.username);
  if (!existing) return breakglassEnsure(o);
  const password = o.password ?? generatePassword();
  await o.users.setLocalPassword(existing.id, password);
  if (!existing.active && o.users.setActive) await o.users.setActive(existing.id, true);
  await o.audit("vibe.auth.breakglass.rotated", { actor: o.actor ?? "cli", reason: "rotated" });
  return { status: "rotated", username: o.username, userId: existing.id, password };
}

/** Product-specific readiness facts the package cannot know (see VibeAuthCliAdapter.breakglassCheck). */
export interface BreakglassCheck {
  /** false when the product requires a second factor for this account and none is enrolled. */
  secondFactorEnrolled?: boolean;
  /** true when the account is locked out (failed attempts, admin lock). */
  locked?: boolean;
  /** true when the next sign-in would be forced into a password change. */
  mustChangePassword?: boolean;
  /** Anything else the operator should read. */
  notes?: string[];
}

export interface BreakglassStatus extends BreakglassCheck {
  exists: boolean;
  active: boolean;
  userId?: string;
  role?: string;
  /** Holds the product's admin role. */
  admin: boolean;
  /** exists, active, admin, and none of the product checks reports a blocker. */
  ready: boolean;
  /** Why `ready` is false, in words. */
  problems: string[];
}

export async function breakglassStatus(o: Pick<BreakglassOptions, "users" | "username"> & { adminRole?: string; check?: (user: VibeUser) => Promise<BreakglassCheck> | BreakglassCheck }): Promise<BreakglassStatus> {
  const existing = await o.users.findByUsername(o.username);
  if (!existing) return { exists: false, active: false, admin: false, ready: false, problems: ["account does not exist"] };
  const admin = o.adminRole === undefined ? true : existing.role === o.adminRole;
  const extra = o.check ? await o.check(existing) : {};
  const problems: string[] = [];
  if (!existing.active) problems.push("account is disabled");
  if (!admin) problems.push(`role is "${existing.role}", not the admin role "${o.adminRole}"`);
  if (extra.secondFactorEnrolled === false) problems.push("second factor is required and not enrolled: sign in once and enrol an authenticator");
  if (extra.locked) problems.push("account is locked");
  if (extra.mustChangePassword) problems.push("a password change is forced at next sign-in");
  return { exists: true, active: existing.active, userId: existing.id, role: existing.role, admin, ...extra, ready: problems.length === 0, problems };
}

/**
 * Does `password` still authenticate the break-glass account? The stored password (Appliance)
 * and the hash (product database) drift apart after a database restore; nothing else notices.
 * `checked: false` means the product's adapter does not implement `verifyLocalPassword`.
 */
export async function breakglassVerify(o: Pick<BreakglassOptions, "users" | "username"> & { password: string }): Promise<{ exists: boolean; checked: boolean; matches?: boolean }> {
  const existing = await o.users.findByUsername(o.username);
  if (!existing) return { exists: false, checked: false };
  if (!o.users.verifyLocalPassword) return { exists: true, checked: false };
  return { exists: true, checked: true, matches: await o.users.verifyLocalPassword(existing.id, o.password) };
}
