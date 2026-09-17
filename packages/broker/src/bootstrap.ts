import type { Authentik, AkGroup } from "./authentik.js";
import type { BrokerConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";

/**
 * Idempotent Authentik bootstrap (Phase 5). Blueprints in deploy/blueprints
 * create the brand, groups, MFA-required flow and recovery flow when the
 * container starts; this code verifies and repairs the pieces the broker
 * depends on, so a partially-applied blueprint never leaves the system dark.
 */

export const VIBE_GROUPS = ["vibe-admin", "vibe-partner", "vibe-manager", "vibe-staff", "vibe-it"] as const;
export const AUTH_FLOW_SLUG = "vibe-authentication";
export const RECOVERY_FLOW_SLUG = "vibe-recovery";
export const MFA_STAGE_NAME = "vibe-mfa-validation";
export const SCOPE_MAPPING_NAME = "Vibe roles and groups";
export const ADMIN_APP_SLUG = "vibe-auth-admin";

export interface BootstrapResult {
  version: string;
  groups: Record<string, string>;
  authorizationFlow: string;
  invalidationFlow: string;
  authenticationFlow: string | null;
  scopeMappings: string[];
  signingKey: string | null;
  mfaRequired: boolean;
}

export const ROLES_EXPRESSION = `# Vibe Auth: expose group membership as both "groups" and "roles" claims (D22),
# and assert the email as verified: firm accounts are administrator-managed.
u = request.user
mgr = getattr(u, "groups", None) or u.ak_groups
groups = [g.name for g in mgr.all()]
return {
    "groups": groups,
    "roles": [g for g in groups if g.startswith("vibe-")],
    "email_verified": bool(u.email),
}
`;

export async function waitForAuthentik(ak: Authentik, log: Logger, timeoutMs = 10 * 60_000): Promise<string> {
  const start = Date.now();
  let delay = 2000;
  for (;;) {
    try {
      const v = await ak.version();
      return v.version_current;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw new Error(`authentik not reachable after ${timeoutMs / 1000}s: ${(err as Error).message}`);
      log.info("waiting for authentik", { error: (err as Error).message, retryMs: delay });
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 15_000);
    }
  }
}

/**
 * authentik answers /admin/version/ well before its default blueprints (brand, default
 * flows) and ours have been applied by the worker. Bootstrapping against a half-applied
 * instance produced an empty brand list and a 500ing consent flow on a slow CI runner,
 * so wait for the objects we depend on.
 */
const REQUIRED_FLOWS = ["default-provider-authorization-implicit-consent", "default-provider-invalidation-flow", "default-source-authentication", "default-source-enrollment", AUTH_FLOW_SLUG];

export async function waitForDefaults(ak: Authentik, log: Logger, timeoutMs = 10 * 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const missing: string[] = [];
    try {
      if (!(await ak.defaultBrand())) missing.push("brand");
      for (const slug of REQUIRED_FLOWS) if (!(await ak.flowBySlug(slug))) missing.push(`flow:${slug}`);
      if (!(await ak.validateStageByName(MFA_STAGE_NAME))) missing.push(`stage:${MFA_STAGE_NAME}`);
    } catch (err) {
      missing.push(`api:${(err as Error).message}`);
    }
    if (!missing.length) return;
    if (Date.now() - start > timeoutMs) throw new Error(`authentik blueprints not applied after ${timeoutMs / 1000}s; still missing: ${missing.join(", ")}`);
    log.info("waiting for authentik blueprints", { missing, elapsedMs: Date.now() - start });
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function ensureGroups(ak: Authentik): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of VIBE_GROUPS) {
    let g: AkGroup | null = await ak.groupByName(name);
    if (!g) g = await ak.createGroup({ name, is_superuser: false, attributes: { "vibe.managed": true } });
    out[name] = g.pk;
  }
  return out;
}

export async function ensureScopeMapping(ak: Authentik): Promise<string[]> {
  const all = await ak.scopeMappings();
  let ours = all.find((m) => m.name === SCOPE_MAPPING_NAME);
  if (!ours) ours = await ak.createScopeMapping({ name: SCOPE_MAPPING_NAME, scope_name: "profile", expression: ROLES_EXPRESSION, description: "Vibe Auth groups/roles claims" });
  else if (ours.expression !== ROLES_EXPRESSION) await ak.updateScopeMapping(ours.pk, { expression: ROLES_EXPRESSION });
  // Standard openid/email/profile mappings shipped by authentik (managed names).
  const std = all.filter((m) => m.managed && /goauthentik\.io\/providers\/oauth2\/scope-(openid|email|profile)$/.test(m.managed)).map((m) => m.pk);
  return [...new Set([...std, ours.pk])];
}

/**
 * authentik >= 2026.8 has a "Base URL" system setting: the scheme + host it is
 * reachable at, WITHOUT the path (everything is served under AUTHENTIK_WEB__PATH).
 * Empty, the admin UI shows "The base URL has not been configured"; from 2026.11
 * it is required. The deploy profile seeds it via AUTHENTIK_WEB__BASE_URL, but a
 * value in the database wins over the env, so write it here too — at bootstrap
 * and again on /rebase — so a host/IP/scheme change keeps it current. Older
 * authentik (no such field) is tolerated: the PATCH is skipped, not failed.
 */
export async function ensureBaseUrl(cfg: BrokerConfig, ak: Authentik, log: Logger): Promise<boolean> {
  const want = new URL(cfg.authentikPublicBase).origin;
  let current: { base_url?: string };
  try {
    current = await ak.settings();
  } catch (err) {
    log.warn("could not read authentik settings; base URL not set", { error: (err as Error).message });
    return false;
  }
  if (!("base_url" in current)) return false; // pre-2026.8 authentik
  if (current.base_url === want) return true;
  await ak.patchSettings({ base_url: want });
  log.info("authentik base URL set", { base_url: want, was: current.base_url ?? "" });
  return true;
}

export async function setMfaRequired(ak: Authentik, required: boolean): Promise<boolean> {
  const stage = await ak.validateStageByName(MFA_STAGE_NAME);
  if (!stage) return false;
  // "configure" requires configuration stages; resolve the enrolment stages by name so this
  // never depends on what the blueprint managed to attach.
  const setupNames = ["vibe-totp-setup", "vibe-webauthn-setup"];
  const setup: string[] = [];
  for (const name of setupNames) {
    const s = (await ak.stagesByName(name))[0];
    if (s) setup.push(s.pk);
  }
  await ak.patchValidateStage(stage.pk, {
    not_configured_action: required ? "configure" : "skip",
    ...(setup.length ? { configuration_stages: setup } : {}),
    device_classes: ["totp", "webauthn", "static"],
  });
  return true;
}

export async function bootstrapAuthentik(cfg: BrokerConfig, ak: Authentik, db: Db, log: Logger): Promise<BootstrapResult> {
  const version = await waitForAuthentik(ak, log);
  log.info("authentik reachable", { version });
  await waitForDefaults(ak, log);

  const groups = await ensureGroups(ak);
  const scopeMappings = await ensureScopeMapping(ak);

  // Implicit consent: products are first-party, so no consent screen (explicit consent would
  // also break headless/desktop logins).
  const authz = await ak.flowBySlug("default-provider-authorization-implicit-consent");
  const inval = await ak.flowBySlug("default-provider-invalidation-flow");
  if (!authz || !inval) throw new Error("authentik default authorization/invalidation flows missing");
  const authn = await ak.flowBySlug(AUTH_FLOW_SLUG);
  if (!authn) throw new Error(`vibe authentication flow "${AUTH_FLOW_SLUG}" missing (blueprint not applied)`);

  // Brand: title + our flows (blueprint also sets these; repair if missing). The firm name
  // chosen in the setup wizard wins over the env default and is carried into cfg.
  const firm = await db.getState<{ name?: string }>("firm");
  if (firm?.name) cfg.VIBE_AUTH_BRAND_NAME = firm.name;
  const brand = await ak.defaultBrand();
  if (brand) {
    const patch: Record<string, unknown> = {};
    if (brand.branding_title !== cfg.VIBE_AUTH_BRAND_NAME) patch.branding_title = cfg.VIBE_AUTH_BRAND_NAME;
    if (authn && brand.flow_authentication !== authn.pk) patch.flow_authentication = authn.pk;
    const rec = await ak.flowBySlug(RECOVERY_FLOW_SLUG);
    if (rec && brand.flow_recovery !== rec.pk) patch.flow_recovery = rec.pk;
    if (Object.keys(patch).length) await ak.patchBrand(String(brand.brand_uuid), patch);
  }

  await ensureBaseUrl(cfg, ak, log);

  // MFA enforcement (D23): default on; a logged acknowledgement can turn it off (stored in broker_state).
  const mfaState = (await db.getState<{ required: boolean }>("mfa"))?.required ?? cfg.VIBE_AUTH_MFA_REQUIRED;
  const applied = await setMfaRequired(ak, mfaState);
  if (!applied) log.warn("MFA validation stage not found (blueprint not applied yet)");

  const cert = await ak.firstCert();
  return {
    version,
    groups,
    authorizationFlow: authz.pk,
    invalidationFlow: inval.pk,
    authenticationFlow: authn?.pk ?? null,
    scopeMappings,
    signingKey: cert?.pk ?? null,
    mfaRequired: mfaState,
  };
}
