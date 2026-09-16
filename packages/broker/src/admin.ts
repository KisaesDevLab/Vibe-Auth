import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import express from "express";
import { createVibeAuth, createPgStores, vibeAuthExpress, type SessionAdapter, type SessionIdentity, type UserAdapter, type VibeUser } from "@kisaesdevlab/vibe-auth";
import type { Authentik } from "./authentik.js";
import { AuthentikError } from "./authentik.js";
import type { BootstrapResult } from "./bootstrap.js";
import { ADMIN_APP_SLUG, setMfaRequired, VIBE_GROUPS } from "./bootstrap.js";
import type { BrokerConfig } from "./config.js";
import type { Db, Row } from "./db.js";
import type { BrokerAudit } from "./audit.js";
import type { Registrations } from "./registrations.js";
import type { Setup } from "./setup.js";
import type { Logger } from "./log.js";

/**
 * Firm admin console (Phase 5). The broker dogfoods the client package: admins
 * sign in through Authentik (application "vibe-auth-admin"); only members of
 * vibe-admin / vibe-it resolve to the broker's "admin" role.
 */

export interface AdminDeps {
  cfg: () => BrokerConfig;
  db: Db;
  ak: Authentik;
  boot: () => BootstrapResult;
  regs: Registrations;
  audit: BrokerAudit;
  setup: Setup;
  log: Logger;
}

const COOKIE = "vibe_auth_admin";
const TTL_MS = 8 * 60 * 60_000;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function brokerUsers(db: Db): UserAdapter {
  const row = (r: Row): VibeUser => ({ id: String(r.id), email: String(r.email), name: r.name ? String(r.name) : undefined, role: String(r.role), active: Boolean(r.active) });
  return {
    async findById(id) {
      const r = await db.query("SELECT * FROM vibe_broker_users WHERE id = $1", [id]);
      return r[0] ? row(r[0]) : null;
    },
    async findByEmail(email) {
      const r = await db.query("SELECT * FROM vibe_broker_users WHERE lower(email) = lower($1)", [email]);
      return r[0] ? row(r[0]) : null;
    },
    async findByUsername() {
      return null; // no local accounts in the broker
    },
    async create(i) {
      const id = randomBytes(8).toString("hex");
      const r = await db.query("INSERT INTO vibe_broker_users (id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING *", [id, i.email, i.name ?? null, i.role]);
      return row(r[0]!);
    },
    async setRole(id, role) {
      await db.query("UPDATE vibe_broker_users SET role = $2 WHERE id = $1", [id, role]);
    },
    async createLocalUser() {
      throw new Error("the broker has no local accounts; use the Authentik superuser (akadmin) for break-glass");
    },
    async setLocalPassword() {
      throw new Error("no local accounts");
    },
  };
}

function brokerSessions(db: Db, secure: boolean): SessionAdapter {
  return {
    async create(_req: Request, res: Response, user: VibeUser, identity: SessionIdentity) {
      const sid = randomBytes(24).toString("base64url");
      await db.query("INSERT INTO vibe_broker_sessions (sid, user_id, issuer, subject, oidc_sid, id_token, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [sid, user.id, identity.issuer, identity.subject, identity.sid ?? null, identity.idToken ?? null, new Date(Date.now() + TTL_MS)]);
      res.setHeader("set-cookie", `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${TTL_MS / 1000}`);
    },
    async destroy(req: Request, res: Response) {
      const sid = readCookie(req, COOKIE);
      if (sid) await db.query("DELETE FROM vibe_broker_sessions WHERE sid = $1", [sid]);
      res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    },
    async currentUserId(req: Request) {
      const sid = readCookie(req, COOKIE);
      if (!sid) return null;
      const r = await db.query("SELECT user_id FROM vibe_broker_sessions WHERE sid = $1 AND expires_at > now()", [sid]);
      return r[0] ? String(r[0].user_id) : null;
    },
    async currentIdentity(req: Request) {
      const sid = readCookie(req, COOKIE);
      if (!sid) return null;
      const r = await db.query("SELECT issuer, subject, oidc_sid, id_token FROM vibe_broker_sessions WHERE sid = $1", [sid]);
      const x = r[0];
      return x ? { issuer: String(x.issuer), subject: String(x.subject), sid: x.oidc_sid ? String(x.oidc_sid) : undefined, idToken: x.id_token ? String(x.id_token) : undefined } : null;
    },
    async destroyByIdentity(i) {
      const r = await db.query("DELETE FROM vibe_broker_sessions WHERE oidc_sid = $1 OR (issuer = $2 AND subject = $3) OR user_id = $4 RETURNING sid", [i.sid ?? null, i.issuer, i.subject ?? null, i.userId ?? null]);
      return r.length;
    },
  };
}

export async function buildAdmin(d: AdminDeps): Promise<{ router: Router; ready: () => Promise<void> }> {
  const cfg = d.cfg();
  // Self-registration: the broker is an SSO-capable product like any other.
  const self = await d.regs.upsert({
    slug: ADMIN_APP_SLUG,
    displayName: `${cfg.VIBE_AUTH_BRAND_NAME} Admin`,
    baseUrl: cfg.brokerPublicBase,
    redirectPaths: ["/auth/oidc/callback"],
    logoutPaths: ["/auth/oidc/backchannel"],
    publicPaths: ["/health", "/version", "/registrations", "/rebase", "/setup"],
    edgeGate: false,
    extraRedirectUris: [],
  });

  const stores = createPgStores({ query: (s, p) => d.db.query(s, p), tables: { identities: "vibe_broker_identities", settings: "vibe_broker_settings", revocations: "vibe_broker_revocations" } });
  const auth = createVibeAuth({
    product: { slug: ADMIN_APP_SLUG, name: "Vibe Auth Admin", roles: { roles: ["admin"], adminRole: "admin", defaultRoleMap: { "vibe-admin": "admin", "vibe-it": "admin" } } },
    users: brokerUsers(d.db),
    session: brokerSessions(d.db, cfg.VIBE_AUTH_SCHEME === "https"),
    identities: stores.identities,
    settings: stores.settings,
    audit: d.audit,
    basePath: cfg.VIBE_AUTH_BASE_PATH,
    loginPath: "/admin",
    publicUrl: cfg.brokerPublicBase,
    trustProxy: true,
    env: {
      VIBE_AUTH_MODE: "both",
      VIBE_OIDC_ISSUER: self.env.VIBE_OIDC_ISSUER,
      VIBE_OIDC_INTERNAL_BASE: self.env.VIBE_OIDC_INTERNAL_BASE,
      VIBE_OIDC_CLIENT_ID: self.env.VIBE_OIDC_CLIENT_ID,
      VIBE_OIDC_CLIENT_SECRET: self.env.VIBE_OIDC_CLIENT_SECRET,
      VIBE_OIDC_IDP_NAME: cfg.VIBE_AUTH_BRAND_NAME,
      VIBE_OIDC_REQUIRE_MFA_AMR: "false",
    },
    logger: d.log,
  });

  const router = express.Router();
  router.use(vibeAuthExpress(auth));

  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    const uid = await auth.session.currentUserId(req);
    const u = uid ? await auth.users.findById(uid) : null;
    if (!u || !u.active || u.role !== "admin") return res.status(401).json({ error: "unauthenticated", login: `${cfg.VIBE_AUTH_BASE_PATH}/auth/oidc/start?return_to=${encodeURIComponent(cfg.VIBE_AUTH_BASE_PATH + "/admin")}` });
    (req as Request & { admin?: VibeUser }).admin = u;
    next();
  };
  const actor = (req: Request) => (req as Request & { admin?: VibeUser }).admin?.email ?? "admin";
  const api = express.Router();
  api.use(requireAdmin);

  api.get("/overview", async (_req, res) => {
    const c = d.cfg();
    const [users, regs, setup, version] = await Promise.all([d.ak.users({ is_active: true }), d.regs.list(), d.setup.state(), d.ak.version().catch(() => null)]);
    res.json({
      brand: c.VIBE_AUTH_BRAND_NAME,
      firm: (await d.db.getState<{ name: string }>("firm"))?.name,
      routing: { mode: c.VIBE_AUTH_ROUTING, host: c.VIBE_AUTH_HOST, publicBase: c.authentikPublicBase, internalBase: c.authentikInternalBase },
      authentik: { version: version?.version_current, reachable: !!version, adminUrl: `${c.authentikPublicBase}/if/admin/` },
      counts: { users: users.length, registrations: regs.length },
      setup,
      mfaRequired: d.boot().mfaRequired,
      broker: { version: c.VIBE_AUTH_VERSION },
    });
  });

  api.get("/users", async (_req, res) => {
    const users = await d.ak.users({});
    res.json(
      users
        .filter((u) => u.type !== "service_account" && u.type !== "internal_service_account")
        .map((u) => ({ pk: u.pk, username: u.username, name: u.name, email: u.email, active: u.is_active, superuser: u.is_superuser, lastLogin: u.last_login, groups: (u.groups_obj ?? []).map((g) => g.name) })),
    );
  });
  api.put("/users/:pk/groups", async (req, res) => {
    const pk = Number(req.params.pk);
    const want = new Set(((req.body as { groups?: string[] }).groups ?? []).filter((g) => (VIBE_GROUPS as readonly string[]).includes(g)));
    const user = await d.ak.user(pk);
    const before = new Set((user.groups_obj ?? []).map((g) => g.name));
    for (const g of VIBE_GROUPS) {
      const pkG = d.boot().groups[g]!;
      if (want.has(g) && !before.has(g)) await d.ak.addUserToGroup(pkG, pk);
      if (!want.has(g) && before.has(g)) await d.ak.removeUserFromGroup(pkG, pk);
    }
    d.audit.emit({ type: "vibe.auth.role.changed", at: new Date().toISOString(), user_id: pk, from: [...before].filter((g) => g.startsWith("vibe-")), to: [...want], source: "admin", actor: actor(req) });
    res.json({ ok: true });
  });
  api.post("/users/:pk/mfa-reset", async (req, res) => {
    const pk = Number(req.params.pk);
    const n = await d.ak.deleteAllDevices(pk);
    await d.ak.endUserSessions(pk).catch(() => 0);
    d.audit.emit({ type: "vibe.auth.settings.changed", at: new Date().toISOString(), what: "mfa_reset", user_id: pk, devices_removed: n, actor: actor(req) });
    res.json({ ok: true, devicesRemoved: n });
  });
  api.post("/users/:pk/active", async (req, res) => {
    const pk = Number(req.params.pk);
    const active = (req.body as { active?: boolean }).active === true;
    await d.ak.patchUser(pk, { is_active: active });
    if (!active) await d.ak.endUserSessions(pk).catch(() => 0);
    d.audit.emit({ type: "vibe.auth.settings.changed", at: new Date().toISOString(), what: active ? "user_activated" : "user_deactivated", user_id: pk, actor: actor(req) });
    res.json({ ok: true });
  });
  api.post("/users/:pk/sessions/end", async (req, res) => {
    const n = await d.ak.endUserSessions(Number(req.params.pk));
    res.json({ ok: true, ended: n });
  });
  api.post("/users", async (req, res) => {
    const b = req.body as { email?: string; name?: string; groups?: string[] };
    if (!b.email || !b.name) return res.status(400).json({ error: "email and name required" });
    const groups = (b.groups ?? ["vibe-staff"]).filter((g) => (VIBE_GROUPS as readonly string[]).includes(g)).map((g) => d.boot().groups[g]!);
    try {
      const u = await d.ak.createUser({ username: b.email.toLowerCase(), name: b.name, email: b.email, is_active: true, groups, path: "users" });
      d.audit.emit({ type: "vibe.auth.user.provisioned", at: new Date().toISOString(), user_id: u.pk, issuer: d.cfg().authentikPublicBase, sub: u.uuid, email: b.email, role: b.groups ?? ["vibe-staff"], actor: actor(req) });
      res.json({ ok: true, pk: u.pk, recoveryUrl: `${d.cfg().authentikPublicBase}/if/flow/vibe-recovery/` });
    } catch (e) {
      res.status(e instanceof AuthentikError ? e.status : 500).json({ error: e instanceof AuthentikError ? e.body : (e as Error).message });
    }
  });

  api.get("/registrations", async (_req, res) => res.json(await d.regs.list()));
  api.get("/registrations/verify", async (_req, res) => res.json(await d.regs.verify()));
  api.delete("/registrations/:slug", async (req, res) => {
    if (req.params.slug === ADMIN_APP_SLUG) return res.status(400).json({ error: "cannot remove the admin console registration" });
    const ok = await d.regs.remove(req.params.slug);
    d.audit.emit({ type: "vibe.auth.registration.deleted" as never, at: new Date().toISOString(), slug: req.params.slug, action: "delete", actor: actor(req) });
    res.json({ ok });
  });

  api.get("/sources", async (_req, res) => {
    const sources = await d.ak.sources();
    res.json(sources.map((s) => ({ slug: s.slug, name: s.name, enabled: s.enabled, type: s.provider_type, callbackUrl: `${d.cfg().authentikPublicBase}/source/oauth/callback/${s.slug}/` })));
  });
  api.post("/sources", async (req, res) => {
    const b = req.body as { type?: "entra" | "google"; name?: string; clientId?: string; clientSecret?: string; tenantId?: string };
    if (!b.type || !b.clientId || !b.clientSecret) return res.status(400).json({ error: "type, clientId, clientSecret required" });
    if (b.type === "entra" && !b.tenantId) return res.status(400).json({ error: "tenantId required for Entra ID" });
    const slug = b.type;
    const name = b.name ?? (b.type === "entra" ? "Microsoft Entra ID" : "Google Workspace");
    const authn = await d.ak.flowBySlug("default-source-authentication");
    const enroll = await d.ak.flowBySlug("default-source-enrollment");
    const mapping = await ensureSourceGroupMapping(d.ak);
    const common: Record<string, unknown> = {
      name,
      slug,
      enabled: true,
      consumer_key: b.clientId,
      consumer_secret: b.clientSecret,
      user_matching_mode: "email_link",
      group_matching_mode: "name_link",
      policy_engine_mode: "any",
      authentication_flow: authn?.pk,
      enrollment_flow: enroll?.pk,
      user_property_mappings: [mapping],
      additional_scopes: b.type === "entra" ? "openid profile email" : "openid profile email",
    };
    const body =
      b.type === "entra"
        ? {
            ...common,
            provider_type: "entra",
            oidc_well_known_url: `https://login.microsoftonline.com/${b.tenantId}/v2.0/.well-known/openid-configuration`,
            authorization_url: `https://login.microsoftonline.com/${b.tenantId}/oauth2/v2.0/authorize`,
            access_token_url: `https://login.microsoftonline.com/${b.tenantId}/oauth2/v2.0/token`,
            profile_url: "https://graph.microsoft.com/v1.0/me",
            oidc_jwks_url: `https://login.microsoftonline.com/${b.tenantId}/discovery/v2.0/keys`,
          }
        : { ...common, provider_type: "google" };
    try {
      const existing = await d.ak.sourceBySlug(slug);
      const src = existing ? await d.ak.patchSource(slug, body) : await d.ak.createSource(body);
      // Show the source button on the sign-in page: the identification stage lists the sources it renders.
      await d.ak.addSourceToIdentificationStages(src.pk).catch((e) => d.log.warn("could not add source to identification stage", { error: (e as Error).message }));
      d.audit.emit({ type: "vibe.auth.settings.changed", at: new Date().toISOString(), what: "source_upserted", source: slug, actor: actor(req) });
      res.json({ ok: true, slug: src.slug, callbackUrl: `${d.cfg().authentikPublicBase}/source/oauth/callback/${slug}/` });
    } catch (e) {
      res.status(e instanceof AuthentikError ? e.status : 500).json({ error: e instanceof AuthentikError ? e.body : (e as Error).message });
    }
  });
  api.delete("/sources/:slug", async (req, res) => {
    await d.ak.deleteSource(req.params.slug).catch((e) => {
      if (!(e instanceof AuthentikError && e.status === 404)) throw e;
    });
    d.audit.emit({ type: "vibe.auth.settings.changed", at: new Date().toISOString(), what: "source_deleted", source: req.params.slug, actor: actor(req) });
    res.json({ ok: true });
  });

  api.get("/audit", async (req, res) => res.json(await d.audit.recent(Number(req.query.limit ?? 200), typeof req.query.type === "string" ? req.query.type : undefined)));

  api.put("/mfa", async (req, res) => {
    const b = req.body as { required?: boolean; ack?: boolean };
    const required = b.required !== false;
    if (!required && b.ack !== true) return res.status(400).json({ error: "disabling MFA enforcement requires ack: true" });
    const applied = await setMfaRequired(d.ak, required);
    await d.db.setState("mfa", { required, ackBy: actor(req), at: new Date().toISOString() });
    d.boot().mfaRequired = required;
    d.audit.emit({ type: required ? "vibe.auth.settings.changed" : "vibe.auth.mfa.enforcement.disabled", at: new Date().toISOString(), what: "mfa_required", required, actor: actor(req) });
    res.json({ ok: true, applied, required });
  });

  router.use(`${cfg.VIBE_AUTH_BASE_PATH}/api/admin`, express.json(), api);
  return { router, ready: () => auth.start() };
}

const SOURCE_MAPPING_NAME = "Vibe: map roles/groups claims to groups";
/** Entra app roles (`roles`) or Google/OIDC `groups` → authentik groups by name (group_matching_mode=name_link). */
export const SOURCE_GROUP_EXPRESSION = `# Vibe Auth: map the identity provider's "roles" (Entra App Roles) or "groups" claim to authentik groups by name.
# The "groups" key is authentik's special user-mapping attribute: identifiers become group names (group_matching_mode=name_link).
try:
    claims = info
except NameError:
    claims = data
claims = claims or {}
names = list(claims.get("roles") or []) + list(claims.get("groups") or [])
return {"groups": [n for n in names if isinstance(n, str) and n.startswith("vibe-")]}
`;

async function ensureSourceGroupMapping(ak: Authentik): Promise<string> {
  const all = await ak.sourcePropertyMappings();
  const found = all.find((m) => m.name === SOURCE_MAPPING_NAME);
  if (found) return found.pk;
  const created = await ak.createSourcePropertyMapping({ name: SOURCE_MAPPING_NAME, expression: SOURCE_GROUP_EXPRESSION });
  return created.pk;
}
