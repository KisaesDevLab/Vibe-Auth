import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { AuthentikError } from "./authentik.js";
import type { Logger } from "./log.js";

/**
 * Express 4 does not catch a promise rejected by an `async` route handler: it becomes an unhandled
 * rejection, and Node exits. A console or admin call that reached authentik while it was down or
 * restarting therefore killed the whole broker. `catchAsync(router)` makes every handler registered
 * on that router afterwards pass such a rejection to `next(err)`, where `jsonErrors` answers it.
 */
const METHODS = ["get", "post", "put", "patch", "delete", "all", "use"] as const;

type Routable = { [K in (typeof METHODS)[number]]: (...args: unknown[]) => unknown };

export function catchAsync<T>(router: T): T {
  const r = router as unknown as Routable;
  for (const m of METHODS) {
    const original = r[m].bind(r);
    r[m] = (...args: unknown[]) => original(...args.map(wrapHandler));
  }
  return router;
}

function wrapHandler(a: unknown): unknown {
  if (Array.isArray(a)) return a.map(wrapHandler);
  // Not a handler (a path or a setting name), an error handler (4 arguments), or a mounted
  // router or app (they pass their own errors on): leave as is.
  if (typeof a !== "function" || a.length === 4 || isRouter(a)) return a;
  const handler = a as (req: Request, res: Response, next: NextFunction) => unknown;
  return function caught(req: Request, res: Response, next: NextFunction) {
    try {
      const out = handler(req, res, next);
      if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function isRouter(f: object): boolean {
  const x = f as { handle?: unknown; stack?: unknown; set?: unknown };
  return typeof x.handle === "function" && (Array.isArray(x.stack) || typeof x.set === "function");
}

/** authentik down, restarting or timing out: the network call failed, or it said it is not ready. */
export function authentikUnavailable(err: unknown): boolean {
  if (err instanceof AuthentikError) return err.status === 502 || err.status === 503 || err.status === 504;
  const e = err as { name?: string; message?: string; cause?: { code?: string } } | null;
  if (!e) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  return e.message === "fetch failed" || ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(e.cause?.code ?? "");
}

/** The broker's last handler: a JSON answer for an error a route did not handle, never a crash. */
export function jsonErrors(log: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const message = err instanceof Error ? err.message : String(err);
    if (authentikUnavailable(err)) {
      log.warn("authentik unavailable for a request", { path: req.path, error: message });
      return res.status(503).json({ error: "authentik_unavailable" });
    }
    if (err instanceof AuthentikError) {
      log.warn("authentik refused a request", { path: req.path, status: err.status, error: message });
      return res.status(502).json({ error: "authentik_error", status: err.status });
    }
    log.error("unhandled request error", { path: req.path, error: message });
    res.status(500).json({ error: "internal" });
  };
}
