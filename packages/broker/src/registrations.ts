import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AppAccess } from "./access.js";
import type { Authentik, AkOAuth2Provider } from "./authentik.js";
import { AuthentikError } from "./authentik.js";
import type { BootstrapResult } from "./bootstrap.js";
import type { BrokerConfig } from "./config.js";
import type { Db, Row } from "./db.js";

/** Registration API (§2.3 / Phase 5): one OAuth2 provider + application per SSO-capable product. */

export const registrationInput = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  displayName: z.string().min(1).max(80),
  /** Product public base URL including any path prefix, no trailing slash. */
  baseUrl: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  redirectPaths: z.array(z.string().startsWith("/")).min(1).default(["/auth/oidc/callback"]),
  logoutPaths: z.array(z.string().startsWith("/")).default(["/auth/oidc/backchannel"]),
  publicPaths: z.array(z.string()).default([]),
  edgeGate: z.boolean().default(false),
  /** Extra absolute redirect URIs (e.g. a dev origin). */
  extraRedirectUris: z.array(z.string().url()).default([]),
  /**
   * Container-internal base of the product (e.g. http://vibe-tb-server:3001), used for the
   * back-channel logout POST so authentik never has to reach the public edge / internal CA.
   * Omit to fall back to baseUrl.
   */
  internalUrl: z.string().url().transform((u) => u.replace(/\/+$/, "")).optional(),
});
export type RegistrationInput = z.infer<typeof registrationInput>;

export interface Registration {
  slug: string;
  displayName: string;
  baseUrl: string;
  internalUrl: string | null;
  clientId: string;
  redirectPaths: string[];
  logoutPaths: string[];
  publicPaths: string[];
  edgeGate: boolean;
  providerPk: number | null;
  applicationSlug: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
}

export interface EnvBlock {
  VIBE_OIDC_ISSUER: string;
  VIBE_OIDC_INTERNAL_BASE: string;
  VIBE_OIDC_CLIENT_ID: string;
  VIBE_OIDC_CLIENT_SECRET?: string;
  VIBE_OIDC_PUBLIC_URL: string;
  VIBE_OIDC_IDP_NAME: string;
}

function rowToReg(r: Row): Registration {
  return {
    slug: String(r.slug),
    displayName: String(r.display_name),
    baseUrl: String(r.base_url),
    internalUrl: r.internal_url == null ? null : String(r.internal_url),
    clientId: String(r.client_id),
    redirectPaths: r.redirect_paths as string[],
    logoutPaths: r.logout_paths as string[],
    publicPaths: r.public_paths as string[],
    edgeGate: Boolean(r.edge_gate),
    providerPk: r.provider_pk == null ? null : Number(r.provider_pk),
    applicationSlug: r.application_slug == null ? null : String(r.application_slug),
    status: String(r.status),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    rotatedAt: r.rotated_at ? new Date(r.rotated_at as string).toISOString() : null,
  };
}

export class Registrations {
  constructor(
    private cfg: () => BrokerConfig,
    private ak: Authentik,
    private db: Db,
    private boot: () => BootstrapResult,
    /** Per-product sign-in restrictions; re-applied on every upsert because a re-created application has no bindings. */
    private access?: Pick<AppAccess, "sync" | "problems">,
  ) {}

  issuerFor(slug: string): string {
    return `${this.cfg().authentikPublicBase}/application/o/${slug}/`;
  }

  envBlock(reg: Registration, secret?: string): EnvBlock {
    const c = this.cfg();
    return {
      VIBE_OIDC_ISSUER: this.issuerFor(reg.slug),
      // Origin only: the client rewrites scheme+host of the public issuer (whose path already
      // carries /auth/...), so the internal base must not repeat the subpath.
      VIBE_OIDC_INTERNAL_BASE: c.VIBE_AUTH_AUTHENTIK_INTERNAL.replace(/\/+$/, ""),
      VIBE_OIDC_CLIENT_ID: reg.clientId,
      ...(secret ? { VIBE_OIDC_CLIENT_SECRET: secret } : {}),
      VIBE_OIDC_PUBLIC_URL: reg.baseUrl,
      VIBE_OIDC_IDP_NAME: c.VIBE_AUTH_BRAND_NAME,
    };
  }

  private redirectUris(reg: Pick<Registration, "baseUrl" | "redirectPaths" | "logoutPaths">, extra: string[] = []) {
    const auth = [...reg.redirectPaths.map((p) => reg.baseUrl + p), ...extra].map((url) => ({ matching_mode: "strict" as const, url, redirect_uri_type: "authorization" as const }));
    const logout = [{ matching_mode: "strict" as const, url: reg.baseUrl + "/auth/oidc/logged-out", redirect_uri_type: "logout" as const }];
    return [...auth, ...logout];
  }

  private providerBody(reg: Registration, secret?: string): Record<string, unknown> {
    const b = this.boot();
    const body: Record<string, unknown> = {
      name: `vibe:${reg.slug}`,
      client_type: "confidential",
      client_id: reg.clientId,
      authorization_flow: b.authorizationFlow,
      invalidation_flow: b.invalidationFlow,
      ...(b.authenticationFlow ? { authentication_flow: b.authenticationFlow } : {}),
      redirect_uris: this.redirectUris(reg),
      property_mappings: b.scopeMappings,
      sub_mode: "user_uuid",
      issuer_mode: "per_provider",
      // authentik ≥2026 gates grants per provider; an empty list refuses every grant.
      grant_types: ["authorization_code", "refresh_token"],
      access_token_validity: "hours=1",
      refresh_token_validity: "days=30",
      include_claims_in_id_token: true,
      logout_uri: reg.logoutPaths[0] ? (reg.internalUrl ?? reg.baseUrl) + reg.logoutPaths[0] : "",
      logout_method: "backchannel",
      ...(b.signingKey ? { signing_key: b.signingKey } : {}),
    };
    if (secret) body.client_secret = secret;
    return body;
  }

  async list(): Promise<Registration[]> {
    return (await this.db.query("SELECT * FROM vibe_broker_registrations ORDER BY slug")).map(rowToReg);
  }

  async get(slug: string): Promise<Registration | null> {
    const r = await this.db.query("SELECT * FROM vibe_broker_registrations WHERE slug = $1", [slug]);
    return r[0] ? rowToReg(r[0]) : null;
  }

  async secret(slug: string): Promise<string | null> {
    const r = await this.db.query("SELECT client_secret_enc FROM vibe_broker_registrations WHERE slug = $1", [slug]);
    return r[0] ? this.db.unwrap(String(r[0].client_secret_enc)) : null;
  }

  /** Create or update (idempotent on slug). Returns the env block INCLUDING the secret. */
  async upsert(input: RegistrationInput): Promise<{ registration: Registration; env: EnvBlock; created: boolean }> {
    const existing = await this.get(input.slug);
    const clientId = existing?.clientId ?? `vibe-${input.slug}-${randomBytes(6).toString("hex")}`;
    const secret = existing ? (await this.secret(input.slug))! : randomBytes(32).toString("base64url");
    const reg: Registration = {
      slug: input.slug,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      internalUrl: input.internalUrl ?? existing?.internalUrl ?? null,
      clientId,
      redirectPaths: input.redirectPaths,
      logoutPaths: input.logoutPaths,
      publicPaths: input.publicPaths,
      edgeGate: input.edgeGate,
      providerPk: existing?.providerPk ?? null,
      applicationSlug: existing?.applicationSlug ?? null,
      status: "active",
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rotatedAt: existing?.rotatedAt ?? null,
    };

    // Authentik provider
    let provider: AkOAuth2Provider | null = reg.providerPk ? await this.ak.provider(reg.providerPk).catch(() => null) : null;
    if (!provider) provider = await this.ak.providerByName(`vibe:${reg.slug}`);
    const body = this.providerBody(reg, secret);
    if (input.extraRedirectUris.length) body.redirect_uris = this.redirectUris(reg, input.extraRedirectUris);
    if (provider) provider = await this.ak.patchProvider(provider.pk, body);
    else provider = await this.ak.createProvider(body);
    reg.providerPk = provider.pk;

    // Authentik application
    const app = await this.ak.applicationBySlug(reg.slug);
    const appBody = { name: reg.displayName, slug: reg.slug, provider: provider.pk, meta_launch_url: reg.baseUrl + "/", group: "Vibe", open_in_new_tab: false };
    if (app) await this.ak.patchApplication(reg.slug, appBody);
    else await this.ak.createApplication(appBody);
    reg.applicationSlug = reg.slug;

    // Edge gate (D10): a forward_auth proxy provider on the embedded outpost, bound to a
    // sibling application "<slug>-edge". Caddy's forward_auth (rendered by the Appliance
    // only when sso.edgeGate is true) asks the outpost, which matches on external_host.
    await this.syncEdgeGate(reg);
    // Who may sign in (after the edge gate, whose sibling application carries the same bindings).
    await this.access?.sync(reg);

    await this.db.query(
      `INSERT INTO vibe_broker_registrations (slug, display_name, base_url, internal_url, client_id, client_secret_enc, redirect_paths, logout_paths, public_paths, edge_gate, provider_pk, application_slug, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,'active',now())
       ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, base_url = EXCLUDED.base_url, internal_url = EXCLUDED.internal_url, redirect_paths = EXCLUDED.redirect_paths,
         logout_paths = EXCLUDED.logout_paths, public_paths = EXCLUDED.public_paths, edge_gate = EXCLUDED.edge_gate, provider_pk = EXCLUDED.provider_pk,
         application_slug = EXCLUDED.application_slug, status = 'active', updated_at = now()`,
      [reg.slug, reg.displayName, reg.baseUrl, reg.internalUrl, reg.clientId, this.db.wrap(secret), JSON.stringify(reg.redirectPaths), JSON.stringify(reg.logoutPaths), JSON.stringify(reg.publicPaths), reg.edgeGate, reg.providerPk, reg.applicationSlug],
    );
    return { registration: (await this.get(reg.slug))!, env: this.envBlock(reg, secret), created: !existing };
  }

  private async syncEdgeGate(reg: Registration): Promise<void> {
    const b = this.boot();
    const name = `vibe-edge:${reg.slug}`;
    const appSlug = `${reg.slug}-edge`;
    const existing = await this.ak.proxyProviderByName(name);
    if (!reg.edgeGate) {
      if (existing) {
        await this.ak.deleteApplication(appSlug).catch(swallow404);
        await this.ak.deleteProxyProvider(existing.pk).catch(swallow404);
        const outpost = await this.ak.embeddedOutpost();
        if (outpost && outpost.providers.includes(existing.pk)) await this.ak.patchOutpost(outpost.pk, { providers: outpost.providers.filter((p) => p !== existing.pk) });
      }
      return;
    }
    const body = {
      name,
      authorization_flow: b.authorizationFlow,
      invalidation_flow: b.invalidationFlow,
      mode: "forward_single",
      external_host: reg.baseUrl,
      skip_path_regex: reg.publicPaths.map((p) => "^" + p.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : "\\" + c))).join("\n"),
      access_token_validity: "hours=8",
      intercept_header_auth: false,
    };
    const provider = existing ? await this.ak.patchProxyProvider(existing.pk, body) : await this.ak.createProxyProvider(body);
    const app = await this.ak.applicationBySlug(appSlug);
    const appBody = { name: `${reg.displayName} (edge gate)`, slug: appSlug, provider: provider.pk, meta_launch_url: reg.baseUrl + "/", group: "Vibe", open_in_new_tab: false };
    if (app) await this.ak.patchApplication(appSlug, appBody);
    else await this.ak.createApplication(appBody);
    const outpost = await this.ak.embeddedOutpost();
    if (outpost && !outpost.providers.includes(provider.pk)) await this.ak.patchOutpost(outpost.pk, { providers: [...outpost.providers, provider.pk] });
  }

  async rotate(slug: string): Promise<{ registration: Registration; env: EnvBlock }> {
    const reg = await this.get(slug);
    if (!reg || !reg.providerPk) throw new NotFound(slug);
    const secret = randomBytes(32).toString("base64url");
    await this.ak.patchProvider(reg.providerPk, { client_secret: secret });
    await this.db.query("UPDATE vibe_broker_registrations SET client_secret_enc = $2, rotated_at = now(), updated_at = now() WHERE slug = $1", [slug, this.db.wrap(secret)]);
    return { registration: (await this.get(slug))!, env: this.envBlock(reg, secret) };
  }

  async remove(slug: string): Promise<boolean> {
    const reg = await this.get(slug);
    if (!reg) return false;
    await this.syncEdgeGate({ ...reg, edgeGate: false }).catch(() => undefined);
    if (reg.applicationSlug) await this.ak.deleteApplication(reg.applicationSlug).catch(swallow404);
    if (reg.providerPk) await this.ak.deleteProvider(reg.providerPk).catch(swallow404);
    await this.db.query("DELETE FROM vibe_broker_registrations WHERE slug = $1", [slug]);
    return true;
  }

  /** Re-derive redirect URIs / launch URLs after a host, routing or base-URL change (D9, §2.3 item 7). */
  async rebase(products: Record<string, string> = {}): Promise<Array<{ slug: string; env: EnvBlock }>> {
    const out: Array<{ slug: string; env: EnvBlock }> = [];
    for (const reg of await this.list()) {
      const baseUrl = products[reg.slug] ? products[reg.slug]!.replace(/\/+$/, "") : reg.baseUrl;
      const next = { ...reg, baseUrl };
      if (reg.providerPk) await this.ak.patchProvider(reg.providerPk, this.providerBody(next));
      if (reg.applicationSlug) await this.ak.patchApplication(reg.applicationSlug, { meta_launch_url: baseUrl + "/" });
      await this.db.query("UPDATE vibe_broker_registrations SET base_url = $2, updated_at = now() WHERE slug = $1", [reg.slug, baseUrl]);
      out.push({ slug: reg.slug, env: this.envBlock(next) });
    }
    return out;
  }

  /** §2.5: after restore or at any time, confirm each registration is consistent in authentik and discoverable. */
  async verify(fetchImpl: typeof fetch = fetch): Promise<Array<{ slug: string; ok: boolean; problems: string[]; issuer: string }>> {
    const c = this.cfg();
    const results: Array<{ slug: string; ok: boolean; problems: string[]; issuer: string }> = [];
    for (const reg of await this.list()) {
      const problems: string[] = [];
      const issuer = this.issuerFor(reg.slug);
      const provider = reg.providerPk ? await this.ak.provider(reg.providerPk).catch(() => null) : null;
      if (!provider) problems.push("provider missing in authentik");
      else {
        if (provider.client_id !== reg.clientId) problems.push("client_id drift");
        const want = new Set(this.redirectUris(reg).map((u) => u.url));
        const have = new Set(provider.redirect_uris.map((u) => u.url));
        for (const u of want) if (!have.has(u)) problems.push(`redirect uri missing: ${u}`);
        if (provider.logout_method !== "backchannel") problems.push("logout method not backchannel");
      }
      const app = await this.ak.applicationBySlug(reg.slug);
      if (!app) problems.push("application missing in authentik");
      else if (app.provider !== provider?.pk) problems.push("application not bound to provider");
      try {
        const internal = issuer.replace(c.authentikPublicBase, c.authentikInternalBase) + ".well-known/openid-configuration";
        const pub = new URL(issuer);
        const res = await fetchImpl(internal, { headers: { accept: "application/json", "x-forwarded-host": pub.host, "x-forwarded-proto": pub.protocol.replace(":", "") } });
        if (!res.ok) problems.push(`discovery HTTP ${res.status}`);
        else {
          const doc = (await res.json()) as { issuer?: string };
          if ((doc.issuer ?? "").replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) problems.push(`issuer mismatch: authentik advertises ${doc.issuer}`);
        }
      } catch (err) {
        problems.push(`discovery failed: ${(err as Error).message}`);
      }
      if (this.access) problems.push(...(await this.access.problems(reg).catch((e: Error) => [`access check failed: ${e.message}`])));
      results.push({ slug: reg.slug, ok: problems.length === 0, problems, issuer });
    }
    return results;
  }
}

export class NotFound extends Error {
  constructor(public slug: string) {
    super(`registration not found: ${slug}`);
  }
}

function swallow404(e: unknown) {
  if (e instanceof AuthentikError && e.status === 404) return;
  throw e;
}
