import { randomBytes } from "node:crypto";
import type { UserAdapter, VibeUser } from "./adapters/types.js";
import type { Audit } from "./audit.js";

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
  /** Email for the account; defaults to `${username}@localhost`. */
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
    email: o.email ?? `${o.username}@localhost`,
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

export async function breakglassStatus(o: Pick<BreakglassOptions, "users" | "username">): Promise<{ exists: boolean; active: boolean; userId?: string; role?: string }> {
  const existing = await o.users.findByUsername(o.username);
  if (!existing) return { exists: false, active: false };
  return { exists: true, active: existing.active, userId: existing.id, role: existing.role };
}
