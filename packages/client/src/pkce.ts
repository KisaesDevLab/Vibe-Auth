import { createHash, randomBytes } from "node:crypto";

/** Server-side state/nonce/PKCE store with a 5-minute TTL (Phase 2). */

export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
  /** Where to send the browser after a successful login (same-origin path only). */
  returnTo: string;
  /** Settings "Test connection" popup: the callback posts a message instead of creating a session. */
  test?: boolean;
  /** Tauri loopback port; the callback issues a one-time exchange code to 127.0.0.1:{port}/callback. */
  loopbackPort?: number;
  /** Actor that initiated a test login (oidc_only guard: test login succeeded in this console session). */
  actorId?: string;
}

export interface PendingLoginStore {
  put(p: PendingLogin): Promise<void>;
  take(state: string): Promise<PendingLogin | null>;
}

export const PENDING_TTL_MS = 5 * 60_000;

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function newPendingLogin(init: Partial<PendingLogin> & { returnTo: string }): PendingLogin {
  return {
    state: randomToken(24),
    nonce: randomToken(24),
    codeVerifier: randomToken(48),
    createdAt: Date.now(),
    ...init,
  };
}

/** In-memory store; sufficient for one product container (the Appliance runs one container per product). */
export class MemoryPendingLoginStore implements PendingLoginStore {
  private map = new Map<string, PendingLogin>();
  constructor(
    private ttlMs = PENDING_TTL_MS,
    private max = 5000,
  ) {}
  async put(p: PendingLogin): Promise<void> {
    this.sweep();
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(p.state, p);
  }
  async take(state: string): Promise<PendingLogin | null> {
    const p = this.map.get(state);
    if (!p) return null;
    this.map.delete(state);
    if (Date.now() - p.createdAt > this.ttlMs) return null;
    return p;
  }
  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.map) if (now - v.createdAt > this.ttlMs) this.map.delete(k);
  }
}

/** One-time codes (Tauri loopback exchange), 60 s TTL. */
export class MemoryExchangeStore<T> {
  private map = new Map<string, { value: T; at: number }>();
  constructor(private ttlMs = 60_000) {}
  issue(value: T): string {
    const code = randomToken(32);
    this.map.set(code, { value, at: Date.now() });
    return code;
  }
  redeem(code: string): T | null {
    const e = this.map.get(code);
    if (!e) return null;
    this.map.delete(code);
    if (Date.now() - e.at > this.ttlMs) return null;
    return e.value;
  }
}
