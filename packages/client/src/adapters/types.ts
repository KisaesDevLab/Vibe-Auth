import type { Request, Response } from "express";
import type { AuthMode } from "../config.js";

/**
 * Adapters are the ONLY product-specific surface (D4). A product implements
 * UserAdapter and SessionAdapter against its own user table and session
 * mechanism; the other adapters have package-provided defaults.
 */

/** Minimal user shape the package needs. Products map from their own row. */
export interface VibeUser {
  id: string;
  email: string;
  name?: string;
  role: string;
  active: boolean;
  /** True when this is a local (password) account, e.g. the break-glass user. */
  local?: boolean;
  username?: string;
}

export interface CreateUserInput {
  email: string;
  name?: string;
  role: string;
  emailVerified: boolean;
  /** Source of provisioning, for audit. */
  issuer: string;
  subject: string;
}

export interface CreateLocalUserInput {
  username: string;
  email: string;
  name: string;
  role: string;
  /** Plaintext; the product hashes with its own algorithm/cost. */
  password: string;
}

export interface UserAdapter {
  findById(id: string): Promise<VibeUser | null>;
  findByEmail(email: string): Promise<VibeUser | null>;
  /** Used by the break-glass CLI. Products without usernames may match on email. */
  findByUsername(username: string): Promise<VibeUser | null>;
  /** JIT provisioning (Phase 3). Return the created user. */
  create(input: CreateUserInput): Promise<VibeUser>;
  setRole(userId: string, role: string): Promise<void>;
  /** Break-glass provisioning (D12). Must create an ACTIVE local admin. */
  createLocalUser(input: CreateLocalUserInput): Promise<VibeUser>;
  setLocalPassword(userId: string, password: string): Promise<void>;
  /** Optional: reactivate a disabled break-glass account on "ensure". */
  setActive?(userId: string, active: boolean): Promise<void>;
}

export interface SessionIdentity {
  issuer: string;
  subject: string;
  /** OIDC session id (sid claim) when the IdP provides one. */
  sid?: string;
  /** Raw ID token, kept for RP-initiated logout (id_token_hint). */
  idToken?: string;
  amr?: string[];
}

export interface SessionAdapter {
  /** Establish the product's session for the user after a successful OIDC login. */
  create(req: Request, res: Response, user: VibeUser, identity: SessionIdentity): Promise<void>;
  /** Destroy the current product session (local logout). */
  destroy(req: Request, res: Response): Promise<void>;
  /** Current user id, if any (for /auth/me, settings API authz). */
  currentUserId(req: Request): Promise<string | null>;
  /** Return the identity stored at create() so logout can pass id_token_hint. */
  currentIdentity?(req: Request): Promise<SessionIdentity | null>;
  /**
   * Back-channel logout: destroy every session for this identity (D16).
   * Server-side-store products delete rows; stateless-JWT products should
   * instead rely on RevocationList (the package calls both when present).
   * Returns the number of sessions ended (best effort).
   */
  destroyByIdentity?(identity: { issuer: string; subject?: string; sid?: string; userId?: string }): Promise<number>;
  /**
   * For Tauri loopback logins: mint a bearer/session token the desktop app can
   * store and send on subsequent requests. Optional; only Tauri products need it.
   */
  issueToken?(user: VibeUser, identity: SessionIdentity): Promise<{ token: string; expiresAt?: string }>;
}

/** Revocation list adapter for stateless-JWT products (D16, Phase 3). */
export interface RevocationList {
  /**
   * Record that every token for this user (or sid) issued at or before `revokedAt`
   * is invalid. The record itself expires at `until` (the product's max token lifetime);
   * tokens issued AFTER `revokedAt` (a fresh login) stay valid.
   */
  revoke(key: { userId?: string; sid?: string }, revokedAt: Date, until: Date): Promise<void>;
  /** True if a token for this user/sid issued at iat (ms) should be rejected. */
  isRevoked(key: { userId?: string; sid?: string }, issuedAtMs: number): Promise<boolean>;
}

export interface IdentityRecord {
  userId: string;
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  lastLoginAt?: Date;
}

/** The auth_identities table (Phase 3). Package ships a SQL fragment and a query-function-backed store. */
export interface IdentityStore {
  findByIssuerSubject(issuer: string, subject: string): Promise<IdentityRecord | null>;
  listForUser(userId: string): Promise<IdentityRecord[]>;
  link(rec: IdentityRecord): Promise<void>;
  touch(issuer: string, subject: string, at: Date): Promise<void>;
  unlink(issuer: string, subject: string): Promise<void>;
}

/** Persisted Settings → Authentication values (override env). */
export interface StoredAuthSettings {
  mode?: AuthMode;
  issuer?: string;
  internalBase?: string;
  clientId?: string;
  /** Wrapped with SecretWrap (D24). */
  clientSecretWrapped?: string;
  roleMap?: Record<string, string>;
  defaultRole?: string;
  requireMfaAmr?: boolean;
  allowJit?: boolean;
  idpName?: string;
  /** Logged acknowledgement when a firm disables MFA enforcement (D23). */
  mfaAckBy?: string;
  mfaAckAt?: string;
  /** Last successful test login: actor + time; feeds the oidc_only guard. */
  lastTestOkBy?: string;
  lastTestOkAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface SettingsStore {
  get(): Promise<StoredAuthSettings | null>;
  set(next: StoredAuthSettings): Promise<void>;
}

/** Encrypts client secrets at rest using the product's existing key-wrap (D24). */
export interface SecretWrap {
  wrap(plaintext: string): Promise<string>;
  unwrap(wrapped: string): Promise<string>;
}

export type AuditEventType =
  | "vibe.auth.login.success"
  | "vibe.auth.login.failure"
  | "vibe.auth.user.provisioned"
  | "vibe.auth.user.linked"
  | "vibe.auth.role.changed"
  | "vibe.auth.logout"
  | "vibe.auth.mode.changed"
  | "vibe.auth.breakglass.used"
  | "vibe.auth.breakglass.rotated"
  | "vibe.auth.idp.unreachable"
  | "vibe.auth.settings.changed"
  | "vibe.auth.mfa.enforcement.disabled";

export interface AuditEvent {
  type: AuditEventType;
  at: string;
  [k: string]: unknown;
}

export interface AuditSink {
  emit(event: AuditEvent): Promise<void> | void;
}

/** D18: single-tenant default only. Present so multi-firm can be added without an API break. */
export interface TenantResolver {
  resolve(req: Request): Promise<{ tenantId: string }>;
}

export const SINGLE_TENANT: TenantResolver = { resolve: async () => ({ tenantId: "default" }) };
