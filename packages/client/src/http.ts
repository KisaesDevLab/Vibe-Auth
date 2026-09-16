/**
 * Framework-neutral HTTP shapes. Phase 0 found that AI Router, Recap and 1040
 * are Fastify 5 apps while the rest are Express 4, so the engine handles a
 * neutral request and thin adapters (express.ts, fastify.ts) translate.
 */

export interface HttpRequest {
  method: string;
  /** Path + query, e.g. "/auth/oidc/callback?code=..&state=..". */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed body when the framework parsed it (JSON or urlencoded). */
  body?: unknown;
  ip?: string;
  /** Framework request/response objects, passed through to adapters. */
  raw: { req: unknown; res: unknown };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: string | Buffer | Record<string, unknown> | unknown[];
}

export function json(status: number, body: Record<string, unknown> | unknown[], headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }, body };
}

export function html(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", ...headers },
    body,
  };
}

export function redirect(location: string, status = 302): HttpResponse {
  return { status, headers: { location, "cache-control": "no-store" }, body: "" };
}

export function header(req: HttpRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function parseUrl(req: HttpRequest): { path: string; query: URLSearchParams } {
  const u = new URL(req.url, "http://local");
  return { path: u.pathname, query: u.searchParams };
}

/** Body as a flat string map (JSON object or urlencoded). */
export function formBody(req: HttpRequest): Record<string, string> {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") return Object.fromEntries(new URLSearchParams(b));
  if (Buffer.isBuffer(b)) return Object.fromEntries(new URLSearchParams(b.toString("utf8")));
  if (typeof b === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) if (v !== undefined && v !== null) out[k] = String(v);
    return out;
  }
  return {};
}

/** Public origin of this request, honouring proxy headers when trusted. */
export function requestOrigin(req: HttpRequest, trustProxy: boolean): string {
  const fwdProto = trustProxy ? header(req, "x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
  const fwdHost = trustProxy ? header(req, "x-forwarded-host")?.split(",")[0]?.trim() : undefined;
  const host = fwdHost ?? header(req, "host") ?? "localhost";
  const proto = fwdProto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Only allow same-origin relative paths for post-login redirects. */
export function safeReturnTo(v: string | null | undefined, fallback = "/"): string {
  if (!v) return fallback;
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(v)) return fallback;
  return v;
}
