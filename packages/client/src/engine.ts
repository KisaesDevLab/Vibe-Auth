import type {
  AuditSink,
  IdentityStore,
  RevocationList,
  SecretWrap,
  SessionAdapter,
  SessionIdentity,
  SettingsStore,
  StoredAuthSettings,
  TenantResolver,
  UserAdapter,
  VibeUser,
} from "./adapters/types.js";
import { SINGLE_TENANT } from "./adapters/types.js";
import { MemoryIdentityStore } from "./adapters/memory.js";
import { consoleAuditSink, makeAudit, type Audit } from "./audit.js";
import { AUTH_MODES, defaultBreakglassEmail, loadEnvConfig, loopbackPortPredicate, unmappedDefaultGroups, type AuthMode, type EffectiveConfig, type EnvConfig, type RoleVocabulary } from "./config.js";
import { discover, type ResolvedProvider } from "./discovery.js";
import { formBody, header, html, json, parseUrl, redirect, requestOrigin, safeReturnTo, type HttpRequest, type HttpResponse } from "./http.js";
import { linkOrProvision } from "./identity.js";
import { idpUnavailablePage, loggedOutPage, loginErrorPage, loopbackHandoffPage, testResultPage } from "./pages.js";
import { MemoryExchangeStore, MemoryPendingLoginStore, codeChallengeS256, newPendingLogin, type PendingLogin, type PendingLoginStore } from "./pkce.js";
import { amrSatisfiesMfa, resolveRole } from "./roles.js";
import { MemorySettingsStore, plaintextSecretWrap, resolveEffectiveConfig } from "./settings.js";
import { exchangeCode, fetchUserInfo, validateIdToken, validateLogoutToken, type IdTokenClaims } from "./tokens.js";

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface VibeAuthOptions {
  product: { slug: string; name: string; roles: RoleVocabulary };
  users: UserAdapter;
  session: SessionAdapter;
  identities?: IdentityStore;
  settings?: SettingsStore;
  secretWrap?: SecretWrap;
  audit?: AuditSink;
  revocations?: RevocationList;
  pending?: PendingLoginStore;
  tenants?: TenantResolver;
  env?: NodeJS.ProcessEnv;
  /** Path prefix the product mounts the SPA/API under (e.g. "/tb"); auth routes live at `${basePath}/auth/...`. */
  basePath?: string;
  /** Where the product's login page lives (relative to basePath). */
  loginPath?: string;
  /** Hidden break-glass local login page (relative to basePath). */
  breakglassLoginPath?: string;
  /**
   * The break-glass account's email, for products that sign people in by email. Pass the same
   * constant the UserAdapter uses. Default: VIBE_BREAKGLASS_EMAIL, else `<username>@vibe-auth.local`.
   * `localLoginAllowed` and `afterLocalLogin` accept it exactly as they accept the username, so an
   * email-login product no longer has to map the address back to keep the break-glass audit event.
   */
  breakglassEmail?: string;
  /** Public URL override; otherwise derived from VIBE_OIDC_PUBLIC_URL or the request. */
  publicUrl?: string;
  trustProxy?: boolean;
  /** Returns the current admin's user id or null. Defaults to session.currentUserId + role check. */
  authorizeAdmin?: (req: HttpRequest) => Promise<{ userId: string } | null>;
  /** Re-evaluate role from claims on every login (default true). */
  syncRoles?: boolean;
  /** Post-login redirect when none was requested. */
  defaultReturnTo?: string;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Minutes a successful test login stays valid for the oidc_only guard (default 60). */
  testLoginValidityMinutes?: number;
  /**
   * Step-up re-authentication (1.0.8): how old the ID token's `auth_time` may be, in seconds,
   * for `/auth/oidc/start?reauth=1` to count as a fresh re-authentication (default 120).
   */
  reauthMaxAgeSeconds?: number;
}

export interface AuthStatus {
  mode: AuthMode;
  product: string;
  oidc: { enabled: boolean; idpName: string; reachable: boolean; lastError?: string; issuer?: string; startPath: string };
  localLoginVisible: boolean;
  breakglassPath: string;
}

interface LoopbackSession {
  user: VibeUser;
  identity: SessionIdentity;
}

const DEFAULT_LOGGER: Logger = {
  info: (m, meta) => console.log(JSON.stringify({ level: "info", msg: m, ...meta })),
  warn: (m, meta) => console.warn(JSON.stringify({ level: "warn", msg: m, ...meta })),
  error: (m, meta) => console.error(JSON.stringify({ level: "error", msg: m, ...meta })),
};

export class VibeAuth {
  readonly product: VibeAuthOptions["product"];
  readonly users: UserAdapter;
  readonly session: SessionAdapter;
  readonly identities: IdentityStore;
  readonly settingsStore: SettingsStore;
  readonly secretWrap: SecretWrap;
  readonly revocations?: RevocationList;
  readonly tenants: TenantResolver;
  readonly audit: Audit;
  readonly log: Logger;
  readonly basePath: string;
  readonly loginPath: string;
  readonly breakglassLoginPath: string;

  private env: EnvConfig;
  private cfg: EffectiveConfig;
  private provider: ResolvedProvider | null = null;
  private lastError: string | undefined;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discovering: Promise<ResolvedProvider | null> | null = null;
  private backoffMs = 5000;
  private started = false;
  private pending: PendingLoginStore;
  private loopback = new MemoryExchangeStore<LoopbackSession>();
  private seenJti = new Map<string, number>();
  private loopbackPortOk: (p: number) => boolean;
  private fetchImpl: typeof fetch;
  private opts: VibeAuthOptions;

  constructor(opts: VibeAuthOptions) {
    this.opts = opts;
    this.product = opts.product;
    this.users = opts.users;
    this.session = opts.session;
    this.identities = opts.identities ?? new MemoryIdentityStore();
    this.settingsStore = opts.settings ?? new MemorySettingsStore();
    this.log = opts.logger ?? DEFAULT_LOGGER;
    this.secretWrap = opts.secretWrap ?? plaintextSecretWrap((m) => this.log.warn(m));
    this.revocations = opts.revocations;
    this.tenants = opts.tenants ?? SINGLE_TENANT;
    this.audit = makeAudit(opts.audit ?? consoleAuditSink);
    this.basePath = (opts.basePath ?? "").replace(/\/+$/, "");
    this.loginPath = this.basePath + (opts.loginPath ?? "/login");
    this.breakglassLoginPath = this.basePath + (opts.breakglassLoginPath ?? "/login/local");
    this.pending = opts.pending ?? new MemoryPendingLoginStore();
    this.env = loadEnvConfig(opts.env ?? process.env);
    this.loopbackPortOk = loopbackPortPredicate(this.env.VIBE_OIDC_LOOPBACK_PORTS);
    this.fetchImpl = opts.fetch ?? fetch;
    this.cfg = {
      mode: this.env.VIBE_AUTH_MODE,
      oidc: null,
      breakglassUsername: this.env.VIBE_BREAKGLASS_USERNAME,
      breakglassEmail: (opts.breakglassEmail ?? this.env.VIBE_BREAKGLASS_EMAIL ?? defaultBreakglassEmail(this.env.VIBE_BREAKGLASS_USERNAME)).toLowerCase(),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Resolve config and begin discovery. Never throws for IdP problems (§2.8);
   * throws only for the startup refusal: oidc_only without a break-glass user.
   */
  async start(): Promise<void> {
    await this.reloadConfig();
    if (this.cfg.mode === "oidc_only") {
      const bg = await this.users.findByUsername(this.cfg.breakglassUsername);
      if (!bg || !bg.active) {
        throw new Error(
          `vibe-auth: VIBE_AUTH_MODE=oidc_only but break-glass user "${this.cfg.breakglassUsername}" does not exist or is inactive. ` +
            `Run "npx vibe-auth breakglass ensure" or set VIBE_AUTH_MODE=both.`,
        );
      }
    }
    // A product that relies on the package's default role map gets no role for a group its
    // vocabulary cannot express (the map no longer guesses). Say so once, at boot.
    const roles = this.product.roles;
    if (!roles.defaultRoleMap && !this.env.VIBE_OIDC_ROLE_MAP) {
      const unmapped = unmappedDefaultGroups(roles.roles, roles.adminRole);
      if (unmapped.length) this.log.warn("vibe-auth: no product role for these Vibe groups; members get no role from them. Pass product.roles.defaultRoleMap or set VIBE_OIDC_ROLE_MAP.", { unmapped, roles: [...roles.roles] });
    }
    this.started = true;
    if (this.cfg.oidc) this.discovery = this.ensureProvider().then(() => undefined, () => undefined);
  }

  private discovery: Promise<void> | null = null;

  /**
   * Resolves once the first discovery attempt has finished (successfully or not); `start()`
   * deliberately does not wait for it. Returns whether the identity provider is reachable. Use it
   * before logging "identity provider reachable/unreachable" at boot, and in tests.
   */
  async ready(): Promise<boolean> {
    if (this.discovery) await this.discovery;
    return !!this.provider;
  }

  stop(): void {
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
    this.started = false;
  }

  async reloadConfig(): Promise<EffectiveConfig> {
    const stored = await this.settingsStore.get();
    const publicBase = this.publicBase();
    this.cfg = await resolveEffectiveConfig({
      env: this.env,
      stored,
      vocabulary: this.product.roles,
      secretWrap: this.secretWrap,
      publicBase,
      breakglassEmail: this.opts.breakglassEmail,
    });
    // Config changed → drop the cached provider so discovery re-runs against the new issuer.
    if (this.provider && this.cfg.oidc && this.provider.issuer !== this.cfg.oidc.issuer) this.provider = null;
    if (!this.cfg.oidc) this.provider = null;
    return this.cfg;
  }

  get config(): EffectiveConfig {
    return this.cfg;
  }

  get mode(): AuthMode {
    return this.cfg.mode;
  }

  get idpReachable(): boolean {
    return this.provider !== null;
  }

  /**
   * The product's public base INCLUDING its path prefix (what the broker registers as
   * baseUrl and builds redirect URIs from), e.g. https://firm.example/tb. Not combined
   * with basePath — VIBE_OIDC_PUBLIC_URL already carries it.
   */
  private publicBase(): string | undefined {
    const base = this.opts.publicUrl ?? this.env.VIBE_OIDC_PUBLIC_URL;
    return base ? base.replace(/\/+$/, "") : undefined;
  }

  /** Discovery with retry/backoff; resolves null when the IdP is unreachable. */
  private ensureProvider(): Promise<ResolvedProvider | null> {
    if (this.provider) return Promise.resolve(this.provider);
    if (!this.cfg.oidc) return Promise.resolve(null);
    if (this.discovering) return this.discovering;
    const oidc = this.cfg.oidc;
    this.discovering = (async () => {
      try {
        const p = await discover({ issuer: oidc.issuer, internalBase: oidc.internalBase, fetch: this.fetchImpl });
        this.provider = p;
        this.lastError = undefined;
        this.backoffMs = 5000;
        this.log.info("vibe-auth: identity provider discovered", { issuer: p.issuer });
        // Refresh discovery periodically (keys/endpoints may rotate).
        this.scheduleRediscovery(6 * 60 * 60_000);
        return p;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = message;
        this.log.warn("vibe-auth: identity provider unreachable", { issuer: oidc.issuer, error: message, retryInMs: this.backoffMs });
        await this.audit("vibe.auth.idp.unreachable", { issuer: oidc.issuer, error: message });
        this.scheduleRediscovery(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
        return null;
      } finally {
        this.discovering = null;
      }
    })();
    return this.discovering;
  }

  private scheduleRediscovery(ms: number) {
    if (!this.started) return;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => {
      this.provider = null;
      void this.ensureProvider();
    }, ms);
    this.discoveryTimer.unref?.();
  }

  // ---------------------------------------------------------------- product helpers

  /** Is this login identifier the break-glass account? Matches the username or its email, case-insensitively. */
  isBreakglassIdentifier(identifier: string | undefined | null): boolean {
    const id = (identifier ?? "").trim().toLowerCase();
    return !!id && (id === this.cfg.breakglassUsername.toLowerCase() || id === this.cfg.breakglassEmail);
  }

  /** Products call this from their local login route. */
  localLoginAllowed(identifier: string): { allowed: boolean; reason?: string } {
    if (this.cfg.mode !== "oidc_only") return { allowed: true };
    if (this.isBreakglassIdentifier(identifier)) return { allowed: true };
    return { allowed: false, reason: "oidc_only" };
  }

  /**
   * Products call this after a successful local login so break-glass use is audited. Either field
   * may identify the account: an email-login product that passes only `email` used to lose the
   * event, because only the username was compared.
   */
  async afterLocalLogin(i: { userId: string; username?: string; email?: string; ip?: string }): Promise<void> {
    if (this.isBreakglassIdentifier(i.username) || this.isBreakglassIdentifier(i.email)) {
      await this.audit("vibe.auth.breakglass.used", { user_id: i.userId, ip: i.ip });
    }
  }

  /** For stateless-JWT products: call from the token-verify middleware (D16). */
  async isRevoked(key: { userId?: string; sid?: string }, issuedAtMs: number): Promise<boolean> {
    if (!this.revocations) return false;
    return this.revocations.isRevoked(key, issuedAtMs);
  }

  status(): AuthStatus {
    return {
      mode: this.cfg.mode,
      product: this.product.slug,
      oidc: {
        enabled: !!this.cfg.oidc && this.cfg.mode !== "local",
        idpName: this.cfg.oidc?.idpName ?? this.env.VIBE_OIDC_IDP_NAME,
        reachable: this.provider !== null,
        lastError: this.lastError,
        issuer: this.cfg.oidc?.issuer,
        startPath: `${this.basePath}/auth/oidc/start`,
      },
      localLoginVisible: this.cfg.mode !== "oidc_only",
      breakglassPath: this.breakglassLoginPath,
    };
  }

  // ---------------------------------------------------------------- routing

  /** Returns null when the request is not an auth route (adapters call next()). */
  async handle(req: HttpRequest): Promise<HttpResponse | null> {
    const { path, query } = parseUrl(req);
    const prefix = this.basePath + "/auth";
    if (path !== prefix && !path.startsWith(prefix + "/")) return null;
    const sub = path.slice(prefix.length) || "/";
    const m = req.method.toUpperCase();
    try {
      if (sub === "/status" && m === "GET") return json(200, this.status() as unknown as Record<string, unknown>);
      if (sub === "/me" && m === "GET") return this.handleMe(req);
      if (sub === "/oidc/start" && m === "GET") return this.handleStart(req, query);
      if (sub === "/oidc/callback" && m === "GET") return this.handleCallback(req, query);
      if (sub === "/oidc/backchannel" && m === "POST") return this.handleBackchannel(req);
      if (sub === "/oidc/logout" && (m === "GET" || m === "POST")) return this.handleLogout(req, query);
      if (sub === "/oidc/logged-out" && m === "GET") return html(200, loggedOutPage({ loginPath: this.loginPath, idpName: this.status().oidc.idpName }));
      if (sub === "/oidc/exchange" && m === "POST") return this.handleExchange(req);
      if (sub === "/settings" && m === "GET") return this.handleGetSettings(req);
      if (sub === "/settings" && m === "PUT") return this.handlePutSettings(req);
      if (sub === "/settings/test" && m === "POST") return this.handleTestStart(req);
      return json(404, { error: "not_found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error("vibe-auth: unhandled error", { path, error: message });
      return json(500, { error: "internal_error" });
    }
  }

  private redirectUriFor(req: HttpRequest): string {
    if (this.cfg.oidc && this.publicBase()) return this.cfg.oidc.redirectUri;
    return requestOrigin(req, this.opts.trustProxy ?? true) + this.basePath + "/auth/oidc/callback";
  }

  private postLogoutUriFor(req: HttpRequest): string {
    if (this.cfg.oidc && this.publicBase()) return this.cfg.oidc.postLogoutRedirectUri;
    return requestOrigin(req, this.opts.trustProxy ?? true) + this.basePath + "/auth/oidc/logged-out";
  }

  private async handleMe(req: HttpRequest): Promise<HttpResponse> {
    const userId = await this.session.currentUserId(req.raw.req as never);
    if (!userId) return json(401, { error: "unauthenticated" });
    const user = await this.users.findById(userId);
    if (!user) return json(401, { error: "unauthenticated" });
    const identities = await this.identities.listForUser(userId);
    return json(200, {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      identities: identities.map((i) => ({ issuer: i.issuer, subject: i.subject, lastLoginAt: i.lastLoginAt })),
    });
  }

  // ---------------------------------------------------------------- OIDC start

  private async handleStart(req: HttpRequest, query: URLSearchParams): Promise<HttpResponse> {
    if (!this.cfg.oidc || this.cfg.mode === "local") return json(409, { error: "oidc_disabled", mode: this.cfg.mode });

    const test = query.get("test") === "1";
    let actorId: string | undefined;
    if (test) {
      const admin = await this.authorizeAdmin(req);
      if (!admin) return json(403, { error: "forbidden" });
      actorId = admin.userId;
    }

    // Step-up re-authentication: the browser must already hold a product session, and the
    // product must know how to refresh its step-up marker. The callback never creates a
    // session on this path; it only proves that THIS user re-authenticated just now.
    const reauth = query.get("reauth") === "1";
    let reauthUserId: string | undefined;
    if (reauth) {
      if (!this.session.markStepUp) return json(409, { error: "reauth_unsupported" });
      const userId = await this.session.currentUserId(req.raw.req as never);
      if (!userId) return json(401, { error: "unauthenticated" });
      reauthUserId = userId;
    }

    let loopbackPort: number | undefined;
    const lp = query.get("loopback_port");
    if (lp) {
      const port = Number(lp);
      if (!this.loopbackPortOk(port)) return json(400, { error: "invalid_loopback_port" });
      loopbackPort = port;
    }

    const provider = await this.ensureProvider();
    if (!provider) {
      if (test) return html(503, testResultPage({ ok: false, message: `Identity provider unreachable: ${this.lastError ?? "unknown error"}` }));
      return html(
        503,
        idpUnavailablePage({
          idpName: this.cfg.oidc.idpName,
          mode: this.cfg.mode,
          breakglassPath: this.breakglassLoginPath,
          loginPath: this.loginPath,
          error: this.lastError,
        }),
      );
    }

    const pending = newPendingLogin({
      returnTo: safeReturnTo(query.get("return_to"), this.opts.defaultReturnTo ?? this.basePath + "/"),
      test,
      loopbackPort,
      actorId,
      reauth: reauth || undefined,
      userId: reauthUserId,
    });
    await this.pending.put(pending);

    const url = new URL(provider.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.cfg.oidc.clientId);
    url.searchParams.set("redirect_uri", this.redirectUriFor(req));
    url.searchParams.set("scope", this.cfg.oidc.scopes);
    url.searchParams.set("state", pending.state);
    url.searchParams.set("nonce", pending.nonce);
    url.searchParams.set("code_challenge", codeChallengeS256(pending.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (test) url.searchParams.set("prompt", "login");
    if (reauth) {
      // Force a fresh authentication; max_age=0 makes a compliant OP re-prompt AND return auth_time.
      url.searchParams.set("prompt", "login");
      url.searchParams.set("max_age", "0");
    }
    return redirect(url.toString());
  }

  // ---------------------------------------------------------------- OIDC callback

  private async handleCallback(req: HttpRequest, query: URLSearchParams): Promise<HttpResponse> {
    const oidc = this.cfg.oidc;
    if (!oidc) return json(409, { error: "oidc_disabled" });
    const state = query.get("state") ?? "";
    const pending = state ? await this.pending.take(state) : null;
    if (!pending) {
      return html(400, loginErrorPage({ title: "Sign-in expired", message: "This sign-in attempt has expired or was already used. Please try again.", loginPath: this.loginPath }));
    }
    const fail = async (reason: string, message: string, extra: Record<string, unknown> = {}) => {
      await this.audit("vibe.auth.login.failure", { method: "oidc", reason, issuer: oidc.issuer, ip: req.ip, ...extra });
      if (pending.test) return html(200, testResultPage({ ok: false, reason, message }));
      return html(401, loginErrorPage({ title: "Sign-in failed", message, loginPath: this.loginPath }));
    };

    const errParam = query.get("error");
    if (errParam) return fail(errParam, query.get("error_description") ?? `The identity provider returned "${errParam}".`);
    const code = query.get("code");
    if (!code) return fail("missing_code", "The identity provider did not return an authorization code.");

    const provider = await this.ensureProvider();
    if (!provider) return fail("idp_unreachable", "The identity provider could not be reached to complete sign-in.");

    let claims: IdTokenClaims;
    let idToken: string;
    try {
      const tokens = await exchangeCode({
        provider,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
        redirectUri: this.redirectUriFor(req),
        code,
        codeVerifier: pending.codeVerifier,
        fetch: this.fetchImpl,
      });
      if (!tokens.id_token) return fail("missing_id_token", "The identity provider did not return an ID token.");
      idToken = tokens.id_token;
      claims = await validateIdToken({
        provider,
        clientId: oidc.clientId,
        idToken: tokens.id_token,
        nonce: pending.nonce,
        accessToken: tokens.access_token,
        clockTolerance: oidc.clockTolerance,
      });
      // Userinfo fallback when the ID token lacks email, email_verified, or role/group claims.
      const needsUserinfo = !claims.email || claims.email_verified === undefined || (!claims[oidc.roleClaim] && !claims[oidc.groupsClaim]);
      if (needsUserinfo) {
        const info = await fetchUserInfo(provider, tokens.access_token, this.fetchImpl).catch(() => null);
        if (info && info.sub === claims.sub) claims = { ...info, ...claims, email: claims.email ?? info.email, email_verified: claims.email_verified ?? info.email_verified, name: claims.name ?? info.name };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn("vibe-auth: token exchange/validation failed", { error: message });
      return fail("token_invalid", "The identity provider's response could not be validated.", { detail: message });
    }

    if (oidc.requireMfaAmr && !amrSatisfiesMfa(claims.amr)) {
      return fail("mfa_required", "Multi-factor authentication is required for this product.", { sub: claims.sub, amr: claims.amr });
    }

    const emailVerified = claims.email_verified === true;
    const identity: SessionIdentity = { issuer: provider.issuer, subject: String(claims.sub), sid: claims.sid, idToken, amr: claims.amr };

    if (pending.reauth) return this.completeReauth(req, pending, claims, identity, fail);

    if (pending.test) {
      const resolution = resolveRole({
        claims: claims as Record<string, unknown>,
        roleClaim: oidc.roleClaim,
        groupsClaim: oidc.groupsClaim,
        roleMap: oidc.roleMap,
        defaultRole: oidc.defaultRole,
        vocabulary: this.product.roles,
      });
      const stored = (await this.settingsStore.get()) ?? {};
      await this.settingsStore.set({ ...stored, lastTestOkBy: pending.actorId, lastTestOkAt: new Date().toISOString() });
      return html(
        200,
        testResultPage({
          ok: true,
          message: `Signed in as ${claims.email ?? claims.sub}. Resolved role: ${resolution.role ?? "(none — user would be denied)"}.`,
          email: claims.email,
          emailVerified,
          role: resolution.role,
          roleSource: resolution.source,
          matched: resolution.matched,
          amr: claims.amr ?? [],
        }),
      );
    }

    const linked = await linkOrProvision(this.users, this.identities, this.audit, {
      issuer: provider.issuer,
      subject: String(claims.sub),
      email: claims.email,
      emailVerified,
      name: claims.name ?? claims.preferred_username,
      claims: claims as Record<string, unknown>,
      roleClaim: oidc.roleClaim,
      groupsClaim: oidc.groupsClaim,
      roleMap: oidc.roleMap,
      defaultRole: oidc.defaultRole,
      allowJit: oidc.allowJit,
      vocabulary: this.product.roles,
      syncRoles: this.opts.syncRoles ?? true,
      ip: req.ip,
    });
    if (!linked.ok) {
      const messages: Record<string, string> = {
        no_role: "Your account is not assigned to any role in this product. Ask your administrator to add you to a group.",
        unverified_email: "Your identity provider did not confirm your email address, so your account cannot be linked.",
        no_email: "Your identity provider did not supply an email address.",
        jit_disabled: "Automatic account creation is disabled. Ask your administrator to create your account.",
        inactive: "Your account is disabled.",
      };
      return fail(linked.reason, messages[linked.reason] ?? "Sign-in was refused.", { sub: claims.sub, email: claims.email });
    }

    const success = () =>
      this.audit("vibe.auth.login.success", {
        user_id: linked.user.id,
        method: "oidc",
        issuer: provider.issuer,
        sub: claims.sub,
        amr: claims.amr ?? [],
        ip: req.ip,
        ua: header(req, "user-agent"),
        how: linked.how,
      });

    if (pending.loopbackPort) {
      await success();
      const code = this.loopback.issue({ user: linked.user, identity });
      const url = `http://127.0.0.1:${pending.loopbackPort}/callback?code=${encodeURIComponent(code)}`;
      return html(200, loopbackHandoffPage({ url }));
    }

    // The session is the sign-in. A SessionAdapter may legitimately refuse (a product re-checking
    // amr, a unique-constraint race, a store outage): that is a FAILED login with the normal error
    // page, not a success row followed by a bare 500 on a top-level navigation.
    try {
      await this.session.create(req.raw.req as never, req.raw.res as never, linked.user, identity);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.error("vibe-auth: session.create failed", { user_id: linked.user.id, error: reason });
      return fail("session_failed", "You were identified, but this product could not start your session. Try again, or contact your administrator.", { user_id: linked.user.id, sub: claims.sub, detail: reason.slice(0, 200) });
    }
    await success();
    return redirect(pending.returnTo);
  }

  // ---------------------------------------------------------------- step-up re-authentication

  /**
   * Second half of `/auth/oidc/start?reauth=1`. The ID token must carry a recent `auth_time`
   * and its subject must be the identity already linked to the session's user; then the
   * product refreshes its step-up marker. Any mismatch is a failed login (no session change).
   */
  private async completeReauth(
    req: HttpRequest,
    pending: PendingLogin,
    claims: IdTokenClaims,
    identity: SessionIdentity,
    fail: (reason: string, message: string, extra?: Record<string, unknown>) => Promise<HttpResponse>,
  ): Promise<HttpResponse> {
    const maxAge = this.opts.reauthMaxAgeSeconds ?? 120;
    const authTime = typeof claims.auth_time === "number" ? claims.auth_time : undefined;
    const nowSec = Math.floor(Date.now() / 1000);
    if (authTime === undefined || nowSec - authTime > maxAge + (this.cfg.oidc?.clockTolerance ?? 60)) {
      return fail("reauth_stale", "The identity provider did not perform a fresh sign-in. Please try again.", { sub: claims.sub, auth_time: authTime });
    }
    // The session's user must still be the one who started the re-auth, and the IdP subject
    // must be that user's linked identity. A different account at the IdP does not count.
    const currentUserId = await this.session.currentUserId(req.raw.req as never);
    if (!currentUserId || currentUserId !== pending.userId) {
      return fail("reauth_session_changed", "Your session changed during re-authentication. Please sign in again.", { sub: claims.sub });
    }
    const rec = await this.identities.findByIssuerSubject(identity.issuer, identity.subject);
    if (!rec || rec.userId !== pending.userId) {
      return fail("reauth_subject_mismatch", "You re-authenticated as a different account. Please sign in again with your own account.", { sub: claims.sub, user_id: pending.userId });
    }
    const user = await this.users.findById(pending.userId);
    if (!user || !user.active) return fail("inactive", "Your account is disabled.", { user_id: pending.userId });
    if (!this.session.markStepUp) return json(409, { error: "reauth_unsupported" });
    try {
      await this.session.markStepUp(req.raw.req as never, req.raw.res as never, user, identity);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.error("vibe-auth: session.markStepUp failed", { user_id: user.id, error: reason });
      return fail("stepup_failed", "You re-authenticated, but this product could not record it. Try again, or contact your administrator.", { user_id: user.id, detail: reason.slice(0, 200) });
    }
    await this.identities.touch(identity.issuer, identity.subject, new Date());
    await this.audit("vibe.auth.stepup.success", { user_id: user.id, method: "oidc", issuer: identity.issuer, sub: claims.sub, amr: claims.amr ?? [], auth_time: authTime, ip: req.ip });
    return redirect(pending.returnTo);
  }

  // ---------------------------------------------------------------- Tauri loopback exchange

  private async handleExchange(req: HttpRequest): Promise<HttpResponse> {
    const body = formBody(req);
    const code = body.code;
    if (!code) return json(400, { error: "missing_code" });
    const s = this.loopback.redeem(code);
    if (!s) return json(400, { error: "invalid_or_expired_code" });
    if (this.session.issueToken) {
      const t = await this.session.issueToken(s.user, s.identity);
      return json(200, { token: t.token, expiresAt: t.expiresAt, user: { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role } });
    }
    await this.session.create(req.raw.req as never, req.raw.res as never, s.user, s.identity);
    return json(200, { ok: true, user: { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role } });
  }

  // ---------------------------------------------------------------- logout

  private async handleLogout(req: HttpRequest, query: URLSearchParams): Promise<HttpResponse> {
    const userId = await this.session.currentUserId(req.raw.req as never);
    const identity = (await this.session.currentIdentity?.(req.raw.req as never)) ?? null;
    await this.session.destroy(req.raw.req as never, req.raw.res as never);
    if (userId) await this.audit("vibe.auth.logout", { user_id: userId, method: identity ? "oidc" : "local", initiated_by: "user" });

    const provider = this.provider;
    const oidc = this.cfg.oidc;
    if (identity?.issuer && provider?.endSessionEndpoint && oidc && query.get("local") !== "1") {
      const url = new URL(provider.endSessionEndpoint);
      if (identity.idToken) url.searchParams.set("id_token_hint", identity.idToken);
      url.searchParams.set("client_id", oidc.clientId);
      url.searchParams.set("post_logout_redirect_uri", this.postLogoutUriFor(req));
      return redirect(url.toString());
    }
    return redirect(this.loginPath);
  }

  private async handleBackchannel(req: HttpRequest): Promise<HttpResponse> {
    const oidc = this.cfg.oidc;
    const provider = await this.ensureProvider();
    if (!oidc || !provider) return json(503, { error: "oidc_unavailable" });
    const token = formBody(req).logout_token;
    if (!token) return json(400, { error: "invalid_request", error_description: "logout_token required" });
    let parsed: { sub?: string; sid?: string; jti?: string };
    try {
      parsed = await validateLogoutToken(provider, oidc.clientId, token, oidc.clockTolerance);
    } catch (err) {
      return json(400, { error: "invalid_request", error_description: err instanceof Error ? err.message : "invalid logout token" });
    }
    if (parsed.jti) {
      this.sweepJti();
      if (this.seenJti.has(parsed.jti)) return json(400, { error: "invalid_request", error_description: "replayed logout token" });
      this.seenJti.set(parsed.jti, Date.now());
    }

    let userId: string | undefined;
    if (parsed.sub) {
      const rec = await this.identities.findByIssuerSubject(provider.issuer, parsed.sub);
      userId = rec?.userId;
    }
    let ended = 0;
    if (this.session.destroyByIdentity) {
      ended = await this.session.destroyByIdentity({ issuer: provider.issuer, subject: parsed.sub, sid: parsed.sid, userId });
    }
    if (this.revocations && (userId || parsed.sid)) {
      // Reject tokens issued up to now (a later login stays valid); the record lives 24 h, longer than any product token.
      await this.revocations.revoke({ userId, sid: parsed.sid }, new Date(), new Date(Date.now() + 24 * 60 * 60_000));
    }
    await this.audit("vibe.auth.logout", { user_id: userId, method: "oidc", initiated_by: "idp", sid: parsed.sid, sessions_ended: ended });
    return { status: 200, headers: { "cache-control": "no-store" }, body: "" };
  }

  private sweepJti() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, t] of this.seenJti) if (t < cutoff) this.seenJti.delete(k);
  }

  // ---------------------------------------------------------------- settings API

  private async authorizeAdmin(req: HttpRequest): Promise<{ userId: string } | null> {
    if (this.opts.authorizeAdmin) return this.opts.authorizeAdmin(req);
    const userId = await this.session.currentUserId(req.raw.req as never);
    if (!userId) return null;
    const user = await this.users.findById(userId);
    if (!user || !user.active || user.role !== this.product.roles.adminRole) return null;
    return { userId };
  }

  private async handleGetSettings(req: HttpRequest): Promise<HttpResponse> {
    const admin = await this.authorizeAdmin(req);
    if (!admin) return json(403, { error: "forbidden" });
    const stored = (await this.settingsStore.get()) ?? {};
    const bg = await this.users.findByUsername(this.cfg.breakglassUsername);
    const testOk = this.testLoginFresh(stored, admin.userId);
    return json(200, {
      mode: this.cfg.mode,
      modes: AUTH_MODES,
      env: {
        issuer: this.env.VIBE_OIDC_ISSUER,
        clientId: this.env.VIBE_OIDC_CLIENT_ID,
        hasSecret: !!this.env.VIBE_OIDC_CLIENT_SECRET,
        internalBase: this.env.VIBE_OIDC_INTERNAL_BASE,
        mode: this.env.VIBE_AUTH_MODE,
      },
      stored: {
        mode: stored.mode,
        issuer: stored.issuer,
        internalBase: stored.internalBase,
        clientId: stored.clientId,
        hasSecret: !!stored.clientSecretWrapped,
        roleMap: stored.roleMap,
        defaultRole: stored.defaultRole,
        requireMfaAmr: stored.requireMfaAmr,
        allowJit: stored.allowJit,
        idpName: stored.idpName,
        updatedBy: stored.updatedBy,
        updatedAt: stored.updatedAt,
      },
      effective: this.cfg.oidc
        ? {
            issuer: this.cfg.oidc.issuer,
            internalBase: this.cfg.oidc.internalBase,
            clientId: this.cfg.oidc.clientId,
            hasSecret: !!this.cfg.oidc.clientSecret,
            redirectUri: this.cfg.oidc.redirectUri,
            scopes: this.cfg.oidc.scopes,
            roleMap: this.cfg.oidc.roleMap,
            defaultRole: this.cfg.oidc.defaultRole,
            requireMfaAmr: this.cfg.oidc.requireMfaAmr,
            allowJit: this.cfg.oidc.allowJit,
            idpName: this.cfg.oidc.idpName,
            roleClaim: this.cfg.oidc.roleClaim,
            groupsClaim: this.cfg.oidc.groupsClaim,
          }
        : null,
      idp: { reachable: this.provider !== null, lastError: this.lastError, discoveredAt: this.provider?.discoveredAt },
      roles: this.product.roles.roles,
      adminRole: this.product.roles.adminRole,
      breakglass: { username: this.cfg.breakglassUsername, exists: !!bg, active: !!bg?.active },
      testLogin: { ok: testOk, at: stored.lastTestOkAt, by: stored.lastTestOkBy },
      guards: { canEnableOidcOnly: !!bg?.active && testOk },
    });
  }

  private testLoginFresh(stored: StoredAuthSettings, actorId: string): boolean {
    if (!stored.lastTestOkAt || stored.lastTestOkBy !== actorId) return false;
    const ageMin = (Date.now() - new Date(stored.lastTestOkAt).getTime()) / 60_000;
    return ageMin <= (this.opts.testLoginValidityMinutes ?? 60);
  }

  private async handlePutSettings(req: HttpRequest): Promise<HttpResponse> {
    const admin = await this.authorizeAdmin(req);
    if (!admin) return json(403, { error: "forbidden" });
    const body = (typeof req.body === "object" && req.body ? req.body : {}) as Record<string, unknown>;
    const prev = (await this.settingsStore.get()) ?? {};
    const next: StoredAuthSettings = { ...prev };
    const errors: string[] = [];

    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : undefined);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

    if (has("issuer")) {
      const v = str("issuer");
      if (!v) delete next.issuer;
      else if (!/^https?:\/\//.test(v)) errors.push("issuer must be an http(s) URL");
      else next.issuer = v.replace(/\/+$/, "") + "/";
    }
    if (has("internalBase")) {
      const v = str("internalBase");
      if (!v) delete next.internalBase;
      else if (!/^https?:\/\//.test(v)) errors.push("internalBase must be an http(s) URL");
      else next.internalBase = v.replace(/\/+$/, "");
    }
    if (has("clientId")) {
      const v = str("clientId");
      if (v) next.clientId = v;
      else delete next.clientId;
    }
    if (has("clientSecret")) {
      const v = typeof body.clientSecret === "string" ? body.clientSecret : "";
      if (v) next.clientSecretWrapped = await this.secretWrap.wrap(v);
      else if (body.clientSecret === null) delete next.clientSecretWrapped;
    }
    if (has("roleMap")) {
      const rm = body.roleMap;
      if (rm && typeof rm === "object" && !Array.isArray(rm)) {
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(rm as Record<string, unknown>)) {
          if (typeof v !== "string") continue;
          if (!this.product.roles.roles.includes(v)) errors.push(`roleMap: "${v}" is not a ${this.product.name} role`);
          else if (k.trim()) clean[k.trim()] = v;
        }
        next.roleMap = clean;
      } else if (rm === null) delete next.roleMap;
      else errors.push("roleMap must be an object");
    }
    if (has("defaultRole")) {
      const v = str("defaultRole");
      if (!v) delete next.defaultRole;
      else if (!this.product.roles.roles.includes(v)) errors.push(`defaultRole "${v}" is not a ${this.product.name} role`);
      else next.defaultRole = v;
    }
    if (has("allowJit")) next.allowJit = body.allowJit === true;
    if (has("idpName")) {
      const v = str("idpName");
      if (v) next.idpName = v.slice(0, 60);
      else delete next.idpName;
    }
    if (has("requireMfaAmr")) {
      const want = body.requireMfaAmr === true;
      const wasOn = this.cfg.oidc?.requireMfaAmr ?? this.env.VIBE_OIDC_REQUIRE_MFA_AMR;
      if (!want && wasOn) {
        if (body.mfaAck !== true) errors.push("disabling MFA enforcement requires mfaAck: true");
        else {
          next.mfaAckBy = admin.userId;
          next.mfaAckAt = new Date().toISOString();
          await this.audit("vibe.auth.mfa.enforcement.disabled", { actor: admin.userId });
        }
      }
      next.requireMfaAmr = want;
    }

    let modeChange: { from: AuthMode; to: AuthMode } | null = null;
    if (has("mode")) {
      const v = str("mode") as AuthMode | undefined;
      if (!v || !AUTH_MODES.includes(v)) errors.push("mode must be one of local, both, oidc_only");
      else if (v !== this.cfg.mode) {
        const issuer = next.issuer ?? this.env.VIBE_OIDC_ISSUER;
        const clientId = next.clientId ?? this.env.VIBE_OIDC_CLIENT_ID;
        if (v !== "local" && (!issuer || !clientId)) errors.push("issuer and clientId are required before enabling single sign-on");
        if (v === "oidc_only") {
          const bg = await this.users.findByUsername(this.cfg.breakglassUsername);
          if (!bg || !bg.active) errors.push(`oidc_only refused: break-glass user "${this.cfg.breakglassUsername}" does not exist (run: npx vibe-auth breakglass ensure)`);
          if (!this.testLoginFresh(prev, admin.userId)) errors.push("oidc_only refused: run a successful Test connection first (in this session)");
        }
        if (!errors.length) {
          modeChange = { from: this.cfg.mode, to: v };
          next.mode = v;
        }
      }
    }

    if (errors.length) return json(400, { error: "validation_failed", errors });

    next.updatedBy = admin.userId;
    next.updatedAt = new Date().toISOString();
    await this.settingsStore.set(next);
    await this.reloadConfig();
    await this.audit("vibe.auth.settings.changed", { actor: admin.userId, keys: Object.keys(body).filter((k) => k !== "clientSecret") });
    if (modeChange) await this.audit("vibe.auth.mode.changed", { from: modeChange.from, to: modeChange.to, actor: admin.userId });
    if (this.cfg.oidc) void this.ensureProvider();
    return this.handleGetSettings(req);
  }

  private async handleTestStart(req: HttpRequest): Promise<HttpResponse> {
    const admin = await this.authorizeAdmin(req);
    if (!admin) return json(403, { error: "forbidden" });
    if (!this.cfg.oidc) return json(409, { error: "oidc_not_configured" });
    // The popup navigates to start?test=1, which re-checks admin authorization on the cookie.
    return json(200, { url: `${this.basePath}/auth/oidc/start?test=1` });
  }
}

export function createVibeAuth(opts: VibeAuthOptions): VibeAuth {
  return new VibeAuth(opts);
}
