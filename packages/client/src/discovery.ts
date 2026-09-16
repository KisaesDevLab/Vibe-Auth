import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/**
 * OIDC discovery with issuer validation and internal-base rewrite (§2.6).
 *
 * Products discover against the public issuer (validating the returned
 * issuer), then rewrite the hosts of server-to-server endpoints to
 * VIBE_OIDC_INTERNAL_BASE so no product needs to trust the internal CA.
 *
 * authorization_endpoint is browser-facing and is never rewritten.
 * end_session_endpoint is ALSO browser-facing (RP-initiated logout is a
 * browser redirect), so it is not rewritten either even though §2.6 lists it;
 * rewriting it would send the firm's browser to a container-internal host.
 * Recorded in COMPAT.md as an amendment to §2.6.
 */

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  backchannel_logout_supported?: boolean;
  backchannel_logout_session_supported?: boolean;
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
  [k: string]: unknown;
}

export interface ResolvedProvider {
  /** Public issuer, exactly as it must appear in iss claims (trailing slash). */
  issuer: string;
  /** Browser-facing (never rewritten). */
  authorizationEndpoint: string;
  endSessionEndpoint?: string;
  /** Server-to-server (rewritten to internal base when configured). */
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint?: string;
  revocationEndpoint?: string;
  raw: DiscoveryDocument;
  jwks: JWTVerifyGetKey;
  discoveredAt: number;
}

export interface DiscoveryOptions {
  issuer: string;
  internalBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function rewriteToInternalBase(url: string, internalBase: string): string {
  const u = new URL(url);
  const base = new URL(internalBase);
  u.protocol = base.protocol;
  u.host = base.host;
  const basePath = base.pathname.replace(/\/+$/, "");
  if (basePath) u.pathname = basePath + u.pathname;
  return u.toString();
}

export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "") + "/";
}

export function issuersMatch(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export async function discover(opts: DiscoveryOptions): Promise<ResolvedProvider> {
  const f = opts.fetch ?? fetch;
  const issuer = normalizeIssuer(opts.issuer);
  const wellKnown = issuer + ".well-known/openid-configuration";

  // Discovery is a server-to-server call: fetch through the internal base when
  // configured, but validate the returned issuer against the PUBLIC value.
  const fetchUrl = opts.internalBase ? rewriteToInternalBase(wellKnown, opts.internalBase) : wellKnown;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  let doc: DiscoveryDocument;
  try {
    const res = await f(fetchUrl, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`discovery HTTP ${res.status} from ${fetchUrl}`);
    doc = (await res.json()) as DiscoveryDocument;
  } finally {
    clearTimeout(t);
  }

  if (!doc || typeof doc.issuer !== "string") throw new Error("discovery document missing issuer");
  if (!issuersMatch(doc.issuer, issuer)) {
    throw new Error(`issuer mismatch: configured ${issuer} but discovery returned ${doc.issuer}`);
  }
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof doc[k] !== "string") throw new Error(`discovery document missing ${k}`);
  }
  if (doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes("S256")) {
    throw new Error("identity provider does not advertise PKCE S256");
  }

  const rw = (u: string | undefined) => (u && opts.internalBase ? rewriteToInternalBase(u, opts.internalBase) : u);
  const tokenEndpoint = rw(doc.token_endpoint)!;
  const jwksUri = rw(doc.jwks_uri)!;

  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    timeoutDuration: 5000,
  });

  return {
    issuer,
    authorizationEndpoint: doc.authorization_endpoint,
    endSessionEndpoint: doc.end_session_endpoint,
    tokenEndpoint,
    jwksUri,
    userinfoEndpoint: rw(doc.userinfo_endpoint),
    revocationEndpoint: rw(doc.revocation_endpoint),
    raw: doc,
    jwks,
    discoveredAt: Date.now(),
  };
}
