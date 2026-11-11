import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { authentikUnavailable, catchAsync, jsonErrors } from "./async-routes.js";
import { AuthentikError } from "./authentik.js";
import { createLogger } from "./log.js";

const log = createLogger("error");
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  close = () => new Promise((r) => server.close(() => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** What undici throws when authentik is not listening. */
function fetchFailed(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

describe("a broker route that reaches authentik while it is down (1.0.22)", () => {
  it("answers 503 authentik_unavailable instead of crashing the process", async () => {
    const app = catchAsync(express());
    const api = catchAsync(express.Router());
    api.get("/registrations/verify", async () => {
      throw fetchFailed();
    });
    // An async middleware before the routes (like the admin console's requireAdmin).
    api.use(async (_req, _res, next) => next());
    app.use("/vibe-auth", api);
    app.use(jsonErrors(log));
    const rejections: unknown[] = [];
    const onRejection = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      const base = await serve(app);
      const r = await fetch(`${base}/vibe-auth/registrations/verify`);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "authentik_unavailable" });
      await new Promise((res) => setTimeout(res, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("other authentik refusals are 502, anything else 500, and a thrown sync error is caught too", async () => {
    const app = catchAsync(express());
    app.get("/refused", async () => {
      throw new AuthentikError(400, "/core/users/", { detail: "bad" });
    });
    app.get("/starting", async () => {
      throw new AuthentikError(503, "/admin/version/", { error: "authentik starting" });
    });
    app.get("/bug", async () => {
      throw new Error("boom");
    });
    app.get("/sync", () => {
      throw new Error("sync boom");
    });
    app.use(jsonErrors(log));
    const base = await serve(app);
    expect((await fetch(`${base}/refused`)).status).toBe(502);
    expect((await fetch(`${base}/starting`)).status).toBe(503);
    const bug = await fetch(`${base}/bug`);
    expect([bug.status, await bug.json()]).toEqual([500, { error: "internal" }]);
    expect((await fetch(`${base}/sync`)).status).toBe(500);
  });

  it("leaves settings, mounted routers, static files and answered requests alone", async () => {
    const app = catchAsync(express());
    app.set("trust proxy", true);
    expect(app.get("trust proxy")).toBe(true); // app.get(name) is still the settings getter
    const inner = express.Router();
    inner.get("/ok", async (_req, res) => {
      res.json({ ok: true });
    });
    app.use("/inner", inner);
    app.use(jsonErrors(log));
    const base = await serve(app);
    const r = await fetch(`${base}/inner/ok`);
    expect([r.status, await r.json()]).toEqual([200, { ok: true }]);
    expect((await fetch(`${base}/nowhere`)).status).toBe(404);
  });

  it("recognises authentik being unreachable", () => {
    expect(authentikUnavailable(fetchFailed())).toBe(true);
    expect(authentikUnavailable(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(authentikUnavailable(new AuthentikError(504, "/x", null))).toBe(true);
    expect(authentikUnavailable(new AuthentikError(404, "/x", null))).toBe(false);
    expect(authentikUnavailable(new Error("boom"))).toBe(false);
  });
});
