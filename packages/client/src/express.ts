import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { VibeAuth } from "./engine.js";
import type { HttpRequest, HttpResponse } from "./http.js";

export function toHttpRequest(req: Request, res: Response): HttpRequest {
  return {
    method: req.method,
    url: req.originalUrl ?? req.url,
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: req.body,
    ip: req.ip,
    raw: { req, res },
  };
}

export function sendHttpResponse(res: Response, r: HttpResponse): void {
  res.status(r.status);
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  if (r.body === undefined || r.body === "") return void res.end();
  if (typeof r.body === "string" || Buffer.isBuffer(r.body)) return void res.end(r.body);
  res.end(JSON.stringify(r.body));
}

/**
 * Express middleware. Mount at app level (it matches on the full path):
 *   app.use(express.json(), express.urlencoded({ extended: false }));
 *   app.use(vibeAuthExpress(auth));
 * The back-channel endpoint needs urlencoded parsing; JSON parsing is used by the settings API.
 */
export function vibeAuthExpress(auth: VibeAuth): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await auth.handle(toHttpRequest(req, res));
      if (!r) return next();
      // Session adapters may have already written (e.g. set-cookie); headers from the engine are merged.
      sendHttpResponse(res, r);
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Local-login guard for oidc_only mode: place before the product's password
 * login handler. `identify` extracts the username/email from the request.
 */
export function guardLocalLogin(auth: VibeAuth, identify: (req: Request) => string | undefined): RequestHandler {
  return (req, res, next) => {
    const id = identify(req) ?? "";
    const v = auth.localLoginAllowed(id);
    if (v.allowed) return next();
    res.status(403).json({ error: "local_login_disabled", message: "Local sign-in is disabled; use single sign-on." });
  };
}
