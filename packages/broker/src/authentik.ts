/**
 * Minimal authentik REST client (API v3). Only the calls the broker needs.
 * Field names follow authentik 2026.8 (see COMPAT.md §C).
 */

export class AuthentikError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: unknown,
  ) {
    super(`authentik ${status} ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

export interface Paginated<T> {
  results: T[];
  pagination: { next: number; count: number };
}

export interface AkGroup {
  pk: string;
  name: string;
  is_superuser: boolean;
  users?: number[];
  attributes?: Record<string, unknown>;
}
export interface AkUser {
  pk: number;
  uuid: string;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  last_login: string | null;
  groups: string[];
  groups_obj?: Array<{ pk: string; name: string }>;
  attributes?: Record<string, unknown>;
  type?: string;
}
export interface AkEmailStage extends AkStage {
  use_global_settings?: boolean;
  host?: string;
  port?: number;
  username?: string;
  from_address?: string;
  use_tls?: boolean;
  use_ssl?: boolean;
}
export interface AkFlow {
  pk: string;
  slug: string;
  name: string;
  designation: string;
}
export interface AkOAuth2Provider {
  pk: number;
  name: string;
  client_id: string;
  client_secret?: string;
  client_type: "confidential" | "public";
  authorization_flow: string;
  invalidation_flow: string;
  redirect_uris: Array<{ matching_mode: "strict" | "regex"; url: string; redirect_uri_type?: "authorization" | "logout" }>;
  signing_key: string | null;
  property_mappings: string[];
  sub_mode: string;
  issuer_mode: "global" | "per_provider";
  access_token_validity: string;
  refresh_token_validity: string;
  logout_uri?: string | null;
  logout_method?: "backchannel" | "frontchannel";
  include_claims_in_id_token?: boolean;
}
export interface AkApplication {
  pk: string;
  slug: string;
  name: string;
  provider: number | null;
  meta_launch_url: string;
  group: string;
  policy_engine_mode?: "all" | "any";
}
/** A policy binding on a PolicyBindingModel (here: an application). Exactly one of policy / group / user is set. */
export interface AkBinding {
  pk: string;
  target: string;
  policy: string | null;
  group: string | null;
  user: number | null;
  enabled: boolean;
  order: number;
}
export interface AkScopeMapping {
  pk: string;
  name: string;
  scope_name: string;
  expression: string;
  managed?: string | null;
}
export interface AkCert {
  pk: string;
  name: string;
}
export interface AkStage {
  pk: string;
  name: string;
  component?: string;
  not_configured_action?: string;
}
export interface AkSource {
  pk: string;
  slug: string;
  name: string;
  enabled: boolean;
  provider_type?: string;
  component?: string;
}
export interface AkEvent {
  pk: string;
  action: string;
  created: string;
  user: { pk?: number; username?: string; email?: string } | Record<string, unknown>;
  client_ip?: string;
  context?: Record<string, unknown>;
  brand?: Record<string, unknown>;
}
export interface AkDevice {
  pk: number | string;
  name: string;
  type: string;
  verbose_name?: string;
  confirmed?: boolean;
}
export interface AkSession {
  uuid: string;
  user?: { pk: number; username: string };
  last_ip?: string;
  last_used?: string;
  expires?: string;
}

export class Authentik {
  constructor(
    private base: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.base = base.replace(/\/+$/, "");
  }

  get apiBase(): string {
    return `${this.base}/api/v3`;
  }

  async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(this.apiBase + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // keep text
      }
      if (!res.ok) throw new AuthentikError(res.status, path, json);
      return json as T;
    } finally {
      clearTimeout(t);
    }
  }

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>("GET", path, undefined, query);
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body);
  }
  delete(path: string) {
    return this.request<void>("DELETE", path);
  }

  async list<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const r = await this.get<Paginated<T>>(path, { ...query, page, page_size: 200 });
      out.push(...r.results);
      if (!r.pagination.next) break;
      page = r.pagination.next;
    }
    return out;
  }

  // ---- health / meta
  version() {
    return this.get<{ version_current: string; version_latest?: string; build_hash?: string }>("/admin/version/");
  }
  system() {
    return this.get<Record<string, unknown>>("/admin/system/");
  }
  /** System settings (authentik >= 2026.8 carries `base_url`, required from 2026.11). */
  settings() {
    return this.get<Record<string, unknown> & { base_url?: string }>("/admin/settings/");
  }
  patchSettings(body: Record<string, unknown>) {
    return this.patch<Record<string, unknown>>("/admin/settings/", body);
  }

  // ---- flows / stages / certs / mappings
  async flowBySlug(slug: string): Promise<AkFlow | null> {
    const r = await this.get<Paginated<AkFlow>>("/flows/instances/", { slug });
    return r.results[0] ?? null;
  }
  async stagesByName(name: string): Promise<AkStage[]> {
    const r = await this.get<Paginated<AkStage>>("/stages/all/", { name });
    return r.results;
  }
  async validateStageByName(name: string) {
    const r = await this.get<Paginated<AkStage>>("/stages/authenticator/validate/", { name });
    return r.results[0] ?? null;
  }
  patchValidateStage(pk: string, body: Record<string, unknown>) {
    return this.patch<AkStage>(`/stages/authenticator/validate/${pk}/`, body);
  }
  async emailStageByName(name: string): Promise<AkEmailStage | null> {
    const r = await this.get<Paginated<AkEmailStage>>("/stages/email/", { name });
    return r.results[0] ?? null;
  }
  /** `password` is write-only on authentik's side; pass use_global_settings=true to fall back to AUTHENTIK_EMAIL__*. */
  patchEmailStage(pk: string, body: Record<string, unknown>) {
    return this.patch<AkEmailStage>(`/stages/email/${pk}/`, body);
  }
  async certByName(name: string): Promise<AkCert | null> {
    const r = await this.get<Paginated<AkCert>>("/crypto/certificatekeypairs/", { name });
    return r.results[0] ?? null;
  }
  async firstCert(): Promise<AkCert | null> {
    const r = await this.get<Paginated<AkCert>>("/crypto/certificatekeypairs/", { has_key: true, ordering: "name" });
    return r.results.find((c) => /self-signed/i.test(c.name)) ?? r.results[0] ?? null;
  }
  scopeMappings(query: Record<string, string | undefined> = {}) {
    return this.list<AkScopeMapping>("/propertymappings/provider/scope/", query);
  }
  createScopeMapping(body: { name: string; scope_name: string; expression: string; description?: string }) {
    return this.post<AkScopeMapping>("/propertymappings/provider/scope/", body);
  }
  updateScopeMapping(pk: string, body: Partial<{ name: string; scope_name: string; expression: string; description: string }>) {
    return this.patch<AkScopeMapping>(`/propertymappings/provider/scope/${pk}/`, body);
  }

  // ---- groups / users
  groups(query: Record<string, string | undefined> = {}) {
    return this.list<AkGroup>("/core/groups/", query);
  }
  async groupByName(name: string): Promise<AkGroup | null> {
    const r = await this.get<Paginated<AkGroup>>("/core/groups/", { name });
    return r.results.find((g) => g.name === name) ?? null;
  }
  createGroup(body: { name: string; is_superuser?: boolean; attributes?: Record<string, unknown> }) {
    return this.post<AkGroup>("/core/groups/", body);
  }
  addUserToGroup(groupPk: string, userPk: number) {
    return this.post<void>(`/core/groups/${groupPk}/add_user/`, { pk: userPk });
  }
  removeUserFromGroup(groupPk: string, userPk: number) {
    return this.post<void>(`/core/groups/${groupPk}/remove_user/`, { pk: userPk });
  }
  users(query: Record<string, string | number | boolean | undefined> = {}) {
    return this.list<AkUser>("/core/users/", query);
  }
  user(pk: number) {
    return this.get<AkUser>(`/core/users/${pk}/`);
  }
  async userByUsername(username: string): Promise<AkUser | null> {
    const r = await this.get<Paginated<AkUser>>("/core/users/", { username });
    return r.results.find((u) => u.username === username) ?? null;
  }
  createUser(body: { username: string; name: string; email: string; is_active?: boolean; groups?: string[]; attributes?: Record<string, unknown>; path?: string; type?: string }) {
    return this.post<AkUser>("/core/users/", body);
  }
  patchUser(pk: number, body: Partial<{ name: string; email: string; is_active: boolean; groups: string[]; attributes: Record<string, unknown> }>) {
    return this.patch<AkUser>(`/core/users/${pk}/`, body);
  }
  setPassword(pk: number, password: string) {
    return this.post<void>(`/core/users/${pk}/set_password/`, { password });
  }
  /** One-time link into the brand's recovery flow (set by bootstrap); the token expires per authentik's default (30 min). */
  async createRecoveryLink(pk: number): Promise<string> {
    const r = await this.post<{ link: string }>(`/core/users/${pk}/recovery/`, undefined);
    return r.link;
  }
  /** Ask authentik to email a recovery link through the given email stage. Delivery is asynchronous on authentik's side. */
  sendRecoveryEmail(pk: number, emailStagePk: string) {
    return this.request<void>("POST", `/core/users/${pk}/recovery_email/`, undefined, { email_stage: emailStagePk });
  }
  /** All authenticator devices for a user (admin view). */
  devices(userPk: number) {
    return this.get<AkDevice[]>("/authenticators/admin/all/", { user: userPk });
  }
  async deleteAllDevices(userPk: number): Promise<number> {
    const devices = await this.devices(userPk);
    let n = 0;
    for (const d of devices) {
      const kind = deviceKindPath(d.type);
      if (!kind) continue;
      await this.delete(`/authenticators/admin/${kind}/${d.pk}/`);
      n++;
    }
    return n;
  }
  sessions(query: Record<string, string | number | undefined> = {}) {
    return this.list<AkSession>("/core/authenticated_sessions/", query);
  }
  deleteSession(uuid: string) {
    return this.delete(`/core/authenticated_sessions/${uuid}/`);
  }
  async endUserSessions(userPk: number): Promise<number> {
    const s = await this.sessions({ user__id: userPk } as never);
    for (const x of s) await this.deleteSession(x.uuid);
    return s.length;
  }

  // ---- providers / applications
  async providerByName(name: string): Promise<AkOAuth2Provider | null> {
    const r = await this.get<Paginated<AkOAuth2Provider>>("/providers/oauth2/", { name });
    return r.results.find((p) => p.name === name) ?? null;
  }
  provider(pk: number) {
    return this.get<AkOAuth2Provider>(`/providers/oauth2/${pk}/`);
  }
  createProvider(body: Record<string, unknown>) {
    return this.post<AkOAuth2Provider>("/providers/oauth2/", body);
  }
  patchProvider(pk: number, body: Record<string, unknown>) {
    return this.patch<AkOAuth2Provider>(`/providers/oauth2/${pk}/`, body);
  }
  deleteProvider(pk: number) {
    return this.delete(`/providers/oauth2/${pk}/`);
  }
  async applicationBySlug(slug: string): Promise<AkApplication | null> {
    try {
      return await this.get<AkApplication>(`/core/applications/${slug}/`);
    } catch (e) {
      if (e instanceof AuthentikError && e.status === 404) return null;
      throw e;
    }
  }
  createApplication(body: { name: string; slug: string; provider: number; meta_launch_url?: string; group?: string; open_in_new_tab?: boolean; meta_description?: string }) {
    return this.post<AkApplication>("/core/applications/", body);
  }
  patchApplication(slug: string, body: Record<string, unknown>) {
    return this.patch<AkApplication>(`/core/applications/${slug}/`, body);
  }
  // ---- application access (policy bindings). An application with zero bindings admits everyone;
  // with bindings and policy_engine_mode "any", a user must match at least one of them.
  bindings(target: string) {
    return this.list<AkBinding>("/policies/bindings/", { target });
  }
  createGroupBinding(target: string, groupPk: string, order: number) {
    return this.post<AkBinding>("/policies/bindings/", { target, group: groupPk, order, enabled: true, negate: false, timeout: 30, failure_result: false });
  }
  deleteBinding(pk: string) {
    return this.delete(`/policies/bindings/${pk}/`);
  }
  /** Only meaningful with a superuser token: authentik silently checks the caller otherwise. */
  checkAccess(slug: string, userPk: number) {
    return this.get<{ passing: boolean; messages: string[] }>(`/core/applications/${slug}/check_access/`, { for_user: userPk });
  }
  deleteApplication(slug: string) {
    return this.delete(`/core/applications/${slug}/`);
  }

  // ---- proxy providers / embedded outpost (edge gate, D10)
  async proxyProviderByName(name: string): Promise<{ pk: number; name: string } | null> {
    const r = await this.get<Paginated<{ pk: number; name: string }>>("/providers/proxy/", { name });
    return r.results.find((p) => p.name === name) ?? null;
  }
  createProxyProvider(body: Record<string, unknown>) {
    return this.post<{ pk: number; name: string }>("/providers/proxy/", body);
  }
  patchProxyProvider(pk: number, body: Record<string, unknown>) {
    return this.patch<{ pk: number; name: string }>(`/providers/proxy/${pk}/`, body);
  }
  deleteProxyProvider(pk: number) {
    return this.delete(`/providers/proxy/${pk}/`);
  }
  async embeddedOutpost(): Promise<{ pk: string; name: string; providers: number[] } | null> {
    const r = await this.get<Paginated<{ pk: string; name: string; providers: number[]; managed?: string | null }>>("/outposts/instances/", { managed__iexact: "goauthentik.io/outposts/embedded" });
    return r.results.find((o) => o.managed === "goauthentik.io/outposts/embedded") ?? r.results[0] ?? null;
  }
  patchOutpost(pk: string, body: Record<string, unknown>) {
    return this.patch<unknown>(`/outposts/instances/${pk}/`, body);
  }

  // ---- brand
  async defaultBrand(): Promise<Record<string, unknown> | null> {
    // Prefer the brand flagged default; on a fresh instance fall back to the built-in
    // "authentik-default" domain, then to any brand at all.
    const all = await this.list<Record<string, unknown>>("/core/brands/");
    return all.find((b) => b.default === true) ?? all.find((b) => b.domain === "authentik-default") ?? all[0] ?? null;
  }
  patchBrand(uuid: string, body: Record<string, unknown>) {
    return this.patch<Record<string, unknown>>(`/core/brands/${uuid}/`, body);
  }

  // ---- sources (Entra ID / Google)
  sources() {
    return this.list<AkSource>("/sources/oauth/");
  }
  async sourceBySlug(slug: string): Promise<(AkSource & Record<string, unknown>) | null> {
    try {
      return await this.get<AkSource & Record<string, unknown>>(`/sources/oauth/${slug}/`);
    } catch (e) {
      if (e instanceof AuthentikError && e.status === 404) return null;
      throw e;
    }
  }
  createSource(body: Record<string, unknown>) {
    return this.post<AkSource>("/sources/oauth/", body);
  }
  patchSource(slug: string, body: Record<string, unknown>) {
    return this.patch<AkSource>(`/sources/oauth/${slug}/`, body);
  }
  deleteSource(slug: string) {
    return this.delete(`/sources/oauth/${slug}/`);
  }
  /** Identification stages render only the sources listed on them; add a new source to every one of ours. */
  async addSourceToIdentificationStages(sourcePk: string): Promise<void> {
    const stages = await this.list<{ pk: string; name: string; sources: string[] }>("/stages/identification/");
    for (const s of stages) {
      if (!s.name.startsWith("vibe-")) continue;
      if (s.sources.includes(sourcePk)) continue;
      await this.patch(`/stages/identification/${s.pk}/`, { sources: [...s.sources, sourcePk] });
    }
  }
  sourceTypes() {
    return this.get<Array<{ name: string; slug: string; urls_customizable: boolean; authorization_url?: string; access_token_url?: string; profile_url?: string; oidc_well_known_url?: string }>>("/sources/oauth/source_types/");
  }
  sourcePropertyMappings(query: Record<string, string | undefined> = {}) {
    return this.list<{ pk: string; name: string; expression: string }>("/propertymappings/source/oauth/", query);
  }
  createSourcePropertyMapping(body: { name: string; expression: string }) {
    return this.post<{ pk: string; name: string }>("/propertymappings/source/oauth/", body);
  }
  updateSourcePropertyMapping(pk: string, body: Partial<{ name: string; expression: string }>) {
    return this.patch<{ pk: string; name: string }>(`/propertymappings/source/oauth/${pk}/`, body);
  }

  // ---- events (for audit forwarding)
  events(query: Record<string, string | number | undefined> = {}) {
    return this.get<Paginated<AkEvent>>("/events/events/", query);
  }
}

function deviceKindPath(type: string): string | null {
  // type looks like "authentik_stages_authenticator_totp.TOTPDevice"
  const t = type.toLowerCase();
  if (t.includes("totp")) return "totp";
  if (t.includes("webauthn")) return "webauthn";
  if (t.includes("static")) return "static";
  if (t.includes("duo")) return "duo";
  if (t.includes("sms")) return "sms";
  if (t.includes("email")) return "email";
  return null;
}
