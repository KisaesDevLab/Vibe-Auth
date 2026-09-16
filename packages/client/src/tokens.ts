import { createHash } from "node:crypto";
import { jwtVerify, type JWTPayload } from "jose";
import type { ResolvedProvider } from "./discovery.js";
import { base64url } from "./pkce.js";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface IdTokenClaims extends JWTPayload {
  nonce?: string;
  at_hash?: string;
  sid?: string;
  amr?: string[];
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [k: string]: unknown;
}

export interface ExchangeOptions {
  provider: ResolvedProvider;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function exchangeCode(o: ExchangeOptions): Promise<TokenResponse> {
  const f = o.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirectUri,
    client_id: o.clientId,
    code_verifier: o.codeVerifier,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    ...o.provider.internalHeaders,
  };
  if (o.clientSecret) {
    headers.authorization = "Basic " + Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString("base64");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
  try {
    const res = await f(o.provider.tokenEndpoint, { method: "POST", headers, body, signal: ctrl.signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`token endpoint ${res.status}: ${String(json.error ?? "")} ${String(json.error_description ?? "")}`.trim());
    }
    if (typeof json.access_token !== "string") throw new Error("token response missing access_token");
    return json as unknown as TokenResponse;
  } finally {
    clearTimeout(t);
  }
}

export interface ValidateIdTokenOptions {
  provider: ResolvedProvider;
  clientId: string;
  idToken: string;
  nonce: string;
  accessToken?: string;
  clockTolerance?: number;
}

/** Validates iss/aud/exp/nonce/at_hash (Phase 2). Returns verified claims. */
export async function validateIdToken(o: ValidateIdTokenOptions): Promise<IdTokenClaims> {
  const { payload, protectedHeader } = await jwtVerify(o.idToken, o.provider.jwks, {
    issuer: [o.provider.issuer, o.provider.issuer.replace(/\/$/, "")],
    audience: o.clientId,
    clockTolerance: o.clockTolerance ?? 60,
    // Only asymmetric algorithms; never accept HS* or none.
    algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"],
  });
  const claims = payload as IdTokenClaims;
  if (claims.nonce !== o.nonce) throw new Error("id_token nonce mismatch");
  if (!claims.sub) throw new Error("id_token missing sub");
  if (!claims.iat) throw new Error("id_token missing iat");
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== o.clientId) {
    throw new Error("id_token has multiple audiences but azp is not this client");
  }
  if (o.accessToken && claims.at_hash) {
    const expected = atHash(o.accessToken, protectedHeader.alg);
    if (expected !== claims.at_hash) throw new Error("id_token at_hash mismatch");
  }
  return claims;
}

export function atHash(accessToken: string, alg: string): string {
  const bits = /(\d{3})$/.exec(alg)?.[1] ?? "256";
  const hash = createHash(`sha${bits}`).update(accessToken).digest();
  return base64url(hash.subarray(0, hash.length / 2));
}

export interface UserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [k: string]: unknown;
}

export async function fetchUserInfo(provider: ResolvedProvider, accessToken: string, f: typeof fetch = fetch): Promise<UserInfo | null> {
  if (!provider.userinfoEndpoint) return null;
  const res = await f(provider.userinfoEndpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...provider.internalHeaders } });
  if (!res.ok) return null;
  return (await res.json()) as UserInfo;
}

/**
 * Back-channel logout token validation (OpenID Connect Back-Channel Logout 1.0 §2.6).
 * Returns { sub?, sid? }. Rejects tokens with a nonce or without the events claim.
 */
export async function validateLogoutToken(provider: ResolvedProvider, clientId: string, token: string, clockTolerance = 60) {
  const { payload } = await jwtVerify(token, provider.jwks, {
    issuer: [provider.issuer, provider.issuer.replace(/\/$/, "")],
    audience: clientId,
    clockTolerance,
    algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"],
  });
  const p = payload as JWTPayload & { events?: Record<string, unknown>; sid?: string; nonce?: unknown };
  if (p.nonce !== undefined) throw new Error("logout token must not contain nonce");
  if (!p.events || !("http://schemas.openid.net/event/backchannel-logout" in p.events)) {
    throw new Error("logout token missing backchannel-logout event");
  }
  if (!p.sub && !p.sid) throw new Error("logout token must contain sub or sid");
  if (!p.iat) throw new Error("logout token missing iat");
  return { sub: p.sub, sid: p.sid, jti: p.jti };
}
