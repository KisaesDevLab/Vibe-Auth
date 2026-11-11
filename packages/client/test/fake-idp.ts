/**
 * In-process fake OpenID Provider for tests. Implements discovery, JWKS,
 * authorization (auto-consents a configured user), token (PKCE + client auth),
 * userinfo, end-session, and can mint back-channel logout tokens.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";

export interface FakeUser {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  groups?: string[];
  roles?: string[];
  amr?: string[];
}

export interface FakeIdpOptions {
  /** Public issuer to advertise (may differ from the listening address to test internal-base rewrite). */
  issuer?: string;
  clientId: string;
  clientSecret?: string;
  user: FakeUser;
  /** Behave as if auth failed. */
  denyWith?: string;
}

interface PendingCode {
  redirectUri: string;
  nonce: string;
  codeChallenge?: string;
  state: string;
  /** prompt=login was requested: the ID token carries a fresh auth_time. */
  freshAuth: boolean;
  /** The OP session the ID token names. */
  sid?: string;
  /** Old OP session to log out after the token response ("after-callback"). */
  logoutAfter?: string;
}

export class FakeIdp {
  server!: Server;
  port = 0;
  private priv!: KeyLike;
  private pub!: KeyLike;
  private kid = "test-key";
  private codes = new Map<string, PendingCode>();
  private accessTokens = new Map<string, string>(); // token → sub
  public user: FakeUser;
  public opts: FakeIdpOptions;
  public tokenRequests: URLSearchParams[] = [];
  public authorizeRequests: URLSearchParams[] = [];
  public issuerOverride?: string;
  /** auth_time (seconds) reported when the authorize request did NOT force a fresh login. Default: 1 hour ago. */
  public sessionAuthTime = Math.floor(Date.now() / 1000) - 3600;
  /** Set to ignore prompt=login and keep reporting `sessionAuthTime` (a misbehaving OP). */
  public ignorePromptLogin = false;
  /**
   * Like authentik 2026.8 (1.0.21): prompt=login signs the user in again, which REPLACES the OP
   * session and sends back-channel logout for the old sid to `backchannelUri`, either before the
   * browser is sent back to the product (what authentik does) or just after the token exchange.
   */
  public replaceSessionOnPromptLogin: false | "before-callback" | "after-callback" = false;
  public backchannelUri?: string;
  /** The OP's current session id (default "sid-" + sub). */
  public currentSid?: string;
  /** Back-channel logouts sent by a replaced session, to await in tests. */
  public sentLogouts: Promise<number>[] = [];
  /** Whose each OP session is (a logout token names the old session's user). */
  private sidOwner = new Map<string, string>();

  constructor(opts: FakeIdpOptions) {
    this.opts = opts;
    this.user = opts.user;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get issuer(): string {
    return (this.issuerOverride ?? this.opts.issuer ?? this.base + "/application/o/test/").replace(/\/+$/, "") + "/";
  }

  async start(): Promise<this> {
    const kp = await generateKeyPair("RS256");
    this.priv = kp.privateKey;
    this.pub = kp.publicKey;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  async signIdToken(o: { nonce?: string; accessToken?: string; extra?: Record<string, unknown>; aud?: string; sid?: string }): Promise<string> {
    const u = this.user;
    const claims: Record<string, unknown> = {
      email: u.email,
      email_verified: u.email_verified,
      name: u.name,
      groups: u.groups,
      roles: u.roles,
      amr: u.amr ?? ["pwd"],
      sid: o.sid ?? this.currentSid ?? "sid-" + u.sub,
      ...(o.nonce ? { nonce: o.nonce } : {}),
      ...(o.accessToken ? { at_hash: atHash(o.accessToken) } : {}),
      ...o.extra,
    };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: this.kid })
      .setIssuer(this.issuer)
      .setSubject(u.sub)
      .setAudience(o.aud ?? this.opts.clientId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(this.priv);
  }

  async logoutToken(o: { sub?: string; sid?: string; withNonce?: boolean; aud?: string }): Promise<string> {
    const j = new SignJWT({
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      ...(o.sid ? { sid: o.sid } : {}),
      ...(o.withNonce ? { nonce: "x" } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: this.kid })
      .setIssuer(this.issuer)
      .setAudience(o.aud ?? this.opts.clientId)
      .setIssuedAt()
      .setJti(randomUUID());
    if (o.sub) j.setSubject(o.sub);
    return j.sign(this.priv);
  }

  /** POST a back-channel logout for `sid` to the product, as the OP does. Resolves to the HTTP status. */
  async sendBackchannelLogout(sid: string, sub = this.sidOwner.get(sid) ?? this.user.sub): Promise<number> {
    if (!this.backchannelUri) throw new Error("backchannelUri not set");
    const token = await this.logoutToken({ sub, sid });
    const r = await fetch(this.backchannelUri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: token }) });
    return r.status;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    const path = url.pathname;
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (path.endsWith("/.well-known/openid-configuration")) {
      const iss = this.issuer;
      return send(200, {
        issuer: iss,
        authorization_endpoint: `${iss}authorize/`,
        token_endpoint: `${iss}token/`,
        userinfo_endpoint: `${iss}userinfo/`,
        jwks_uri: `${iss}jwks/`,
        end_session_endpoint: `${iss}end-session/`,
        revocation_endpoint: `${iss}revoke/`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["RS256"],
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
      });
    }
    if (path.endsWith("/jwks/")) {
      const jwk = await exportJWK(this.pub);
      return send(200, { keys: [{ ...jwk, kid: this.kid, use: "sig", alg: "RS256" }] });
    }
    if (path.endsWith("/authorize/")) {
      const q = url.searchParams;
      this.authorizeRequests.push(q);
      const redirectUri = q.get("redirect_uri") ?? "";
      const state = q.get("state") ?? "";
      const target = new URL(redirectUri);
      if (this.opts.denyWith) {
        target.searchParams.set("error", this.opts.denyWith);
        target.searchParams.set("state", state);
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }
      if (q.get("client_id") !== this.opts.clientId) return send(400, { error: "unauthorized_client" });
      if (q.get("code_challenge_method") !== "S256") return send(400, { error: "invalid_request", error_description: "PKCE S256 required" });
      const code = randomUUID();
      if (this.replaceSessionOnPromptLogin && !this.currentSid) {
        // The first sign-in starts the OP session.
        this.currentSid = "sid-" + this.user.sub;
        this.sidOwner.set(this.currentSid, this.user.sub);
      }
      const freshAuth = !this.ignorePromptLogin && (q.get("prompt") === "login" || (q.get("max_age") !== null && Number(q.get("max_age")) < 3600));
      let sid: string | undefined;
      let logoutAfter: string | undefined;
      if (freshAuth && this.replaceSessionOnPromptLogin && this.currentSid) {
        const old = this.currentSid;
        this.currentSid = sid = "sid-" + randomUUID();
        this.sidOwner.set(sid, this.user.sub);
        if (this.replaceSessionOnPromptLogin === "before-callback") {
          const sent = this.sendBackchannelLogout(old);
          this.sentLogouts.push(sent);
          await sent;
        } else logoutAfter = old;
      }
      this.codes.set(code, { redirectUri, nonce: q.get("nonce") ?? "", codeChallenge: q.get("code_challenge") ?? undefined, state, freshAuth, sid, logoutAfter });
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }
    if (path.endsWith("/token/") && req.method === "POST") {
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      this.tokenRequests.push(form);
      // client auth
      const auth = req.headers.authorization;
      if (this.opts.clientSecret) {
        const expected = "Basic " + Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`).toString("base64");
        if (auth !== expected) return send(401, { error: "invalid_client" });
      }
      const code = form.get("code") ?? "";
      const pc = this.codes.get(code);
      this.codes.delete(code);
      if (!pc) return send(400, { error: "invalid_grant" });
      if (pc.redirectUri !== form.get("redirect_uri")) return send(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      if (pc.codeChallenge) {
        const verifier = form.get("code_verifier") ?? "";
        const expect = b64url(createHash("sha256").update(verifier).digest());
        if (expect !== pc.codeChallenge) return send(400, { error: "invalid_grant", error_description: "pkce" });
      }
      const accessToken = "at-" + randomUUID();
      this.accessTokens.set(accessToken, this.user.sub);
      const authTime = pc.freshAuth ? Math.floor(Date.now() / 1000) : this.sessionAuthTime;
      const idToken = await this.signIdToken({ nonce: pc.nonce, accessToken, sid: pc.sid, extra: { auth_time: authTime } });
      send(200, { access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken, scope: "openid profile email" });
      if (pc.logoutAfter) {
        const old = pc.logoutAfter;
        // After the product has finished its callback with these tokens.
        this.sentLogouts.push(new Promise((r) => setTimeout(r, 150)).then(() => this.sendBackchannelLogout(old)));
      }
      return;
    }
    if (path.endsWith("/userinfo/")) {
      const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!this.accessTokens.has(t)) return send(401, { error: "invalid_token" });
      const u = this.user;
      return send(200, { sub: u.sub, email: u.email, email_verified: u.email_verified, name: u.name, groups: u.groups, roles: u.roles });
    }
    if (path.endsWith("/end-session/")) {
      const back = url.searchParams.get("post_logout_redirect_uri");
      res.writeHead(302, { location: back ?? "/" });
      return res.end();
    }
    send(404, { error: "not_found", path });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}
function b64url(b: Buffer) {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function atHash(accessToken: string) {
  const h = createHash("sha256").update(accessToken).digest();
  return b64url(h.subarray(0, 16));
}
