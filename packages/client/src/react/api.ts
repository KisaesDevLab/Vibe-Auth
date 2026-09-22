/** Tiny fetch helpers shared by the React components. Products may pass their own fetch (for CSRF headers). */

export interface ClientOptions {
  basePath?: string;
  fetch?: typeof fetch;
  /** Extra headers, e.g. Authorization or x-csrf-token, per request. */
  headers?: () => Record<string, string>;
}

export interface AuthStatusDto {
  mode: "local" | "both" | "oidc_only";
  product: string;
  oidc: { enabled: boolean; idpName: string; reachable: boolean; lastError?: string; issuer?: string; startPath: string };
  localLoginVisible: boolean;
  breakglassPath: string;
}

export interface AuthSettingsDto {
  mode: "local" | "both" | "oidc_only";
  modes: readonly string[];
  env: { issuer?: string; clientId?: string; hasSecret: boolean; internalBase?: string; mode: string };
  stored: {
    mode?: string;
    issuer?: string;
    internalBase?: string;
    clientId?: string;
    hasSecret: boolean;
    roleMap?: Record<string, string>;
    defaultRole?: string;
    requireMfaAmr?: boolean;
    allowJit?: boolean;
    idpName?: string;
    updatedBy?: string;
    updatedAt?: string;
  };
  effective: {
    issuer: string;
    internalBase?: string;
    clientId: string;
    hasSecret: boolean;
    redirectUri: string;
    scopes: string;
    roleMap: Record<string, string>;
    defaultRole?: string;
    requireMfaAmr: boolean;
    allowJit: boolean;
    idpName: string;
    roleClaim: string;
    groupsClaim: string;
  } | null;
  idp: { reachable: boolean; lastError?: string; discoveredAt?: number };
  roles: readonly string[];
  adminRole: string;
  breakglass: { username: string; exists: boolean; active: boolean };
  testLogin: { ok: boolean; at?: string; by?: string };
  guards: { canEnableOidcOnly: boolean };
}

export function authClient(o: ClientOptions = {}) {
  const base = (o.basePath ?? "").replace(/\/+$/, "") + "/auth";
  const f = o.fetch ?? fetch;
  const req = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await f(base + path, {
      credentials: "same-origin",
      ...init,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(o.headers?.() ?? {}), ...(init.headers as Record<string, string> | undefined) },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; errors?: string[] };
    if (!res.ok) {
      const err = new Error(body.errors?.join("; ") ?? body.error ?? `HTTP ${res.status}`) as Error & { status: number; body: unknown };
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  };
  return {
    status: () => req<AuthStatusDto>("/status"),
    settings: () => req<AuthSettingsDto>("/settings"),
    saveSettings: (patch: Record<string, unknown>) => req<AuthSettingsDto>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
    testUrl: () => req<{ url: string }>("/settings/test", { method: "POST", body: "{}" }),
    startPath: (returnTo?: string) => `${base}/oidc/start${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`,
    /** Step-up re-authentication at the IdP for the CURRENT session (1.0.8); navigate the whole window here. */
    reauthPath: (returnTo?: string) => `${base}/oidc/start?reauth=1${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""}`,
    logoutPath: () => `${base}/oidc/logout`,
  };
}
