import type { VibeAuth } from "./engine.js";
import type { HttpRequest } from "./http.js";

/**
 * Fastify 5 plugin (AI Router, Recap, 1040 are Fastify apps — Phase 0).
 * Typed loosely so this package does not depend on fastify.
 *
 *   await app.register(vibeAuthFastify, { auth });
 *
 * Requires @fastify/formbody (for the back-channel logout POST) or an
 * equivalent content-type parser for application/x-www-form-urlencoded.
 */
interface FastifyLikeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
}
interface FastifyLikeReply {
  status(code: number): FastifyLikeReply;
  header(name: string, value: string): FastifyLikeReply;
  send(payload?: unknown): unknown;
  hijack?(): void;
}
interface FastifyLikeInstance {
  route(opts: { method: string | string[]; url: string; handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<unknown> }): unknown;
}

export interface VibeAuthFastifyOptions {
  auth: VibeAuth;
}

export async function vibeAuthFastify(instance: FastifyLikeInstance, opts: VibeAuthFastifyOptions): Promise<void> {
  const prefix = opts.auth.basePath + "/auth";
  instance.route({
    method: ["GET", "POST", "PUT"],
    url: `${prefix}/*`,
    handler: async (req, reply) => {
      const httpReq: HttpRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        ip: req.ip,
        raw: { req, res: reply },
      };
      const r = await opts.auth.handle(httpReq);
      if (!r) return reply.status(404).send({ error: "not_found" });
      reply.status(r.status);
      for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      if (r.body === undefined || r.body === "") return reply.send();
      if (typeof r.body === "string" || Buffer.isBuffer(r.body)) return reply.send(r.body);
      return reply.send(JSON.stringify(r.body));
    },
  });
}
// Fastify plugin metadata: skip-override so the routes register on the parent scope
// (equivalent to wrapping with fastify-plugin without taking the dependency).
Object.defineProperty(vibeAuthFastify, Symbol.for("skip-override"), { value: true });
Object.defineProperty(vibeAuthFastify, Symbol.for("fastify.display-name"), { value: "vibe-auth" });
