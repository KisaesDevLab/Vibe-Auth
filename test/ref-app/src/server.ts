/**
 * Reference product (Phase 1 exit): a minimal Express app using @kisaesdevlab/vibe-auth.
 * Mirrors how a Vibe product integrates: local login kept, SSO added, settings page, break-glass CLI.
 */
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPgStores, createVibeAuth, guardLocalLogin, vibeAuthExpress } from "@kisaesdevlab/vibe-auth";
import { audit, ROLES, secretWrap, sessions, users, verifyLocalLogin } from "./adapters.js";
import { migrate, query } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3005);
const BASE_PATH = (process.env.VITE_BASE_PATH ?? "/").replace(/\/+$/, "");

async function main() {
  await migrate();
  const stores = createPgStores({ query });
  const auth = createVibeAuth({
    product: { slug: "ref-app", name: "Ref App", roles: ROLES },
    users,
    session: sessions,
    identities: stores.identities,
    settings: stores.settings,
    revocations: stores.revocations,
    secretWrap,
    audit,
    basePath: BASE_PATH,
    loginPath: "/login",
    breakglassLoginPath: "/login/local",
    trustProxy: true,
  });

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Machine endpoints (public_paths) — before any auth.
  app.get(`${BASE_PATH}/api/health`, (_req, res) => res.json({ ok: true, mode: auth.mode, idp: auth.idpReachable }));
  app.get(`${BASE_PATH}/api/ping`, (_req, res) => res.status(204).end());

  // Vibe Auth routes: /auth/status, /auth/oidc/*, /auth/settings ...
  app.use(vibeAuthExpress(auth));

  // Local login, guarded in oidc_only mode (only the break-glass user passes).
  app.post(
    `${BASE_PATH}/api/login`,
    guardLocalLogin(auth, (r) => (r.body as { username?: string }).username),
    async (req, res) => {
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username || !password) return res.status(400).json({ error: "missing_credentials" });
      const u = await verifyLocalLogin(username, password);
      if (!u) {
        await audit.emit({ type: "vibe.auth.login.failure", at: new Date().toISOString(), method: "local", reason: "bad_credentials", ip: req.ip });
        return res.status(401).json({ error: "bad_credentials" });
      }
      await sessions.create(req, res, u, { issuer: "local", subject: u.id });
      await auth.afterLocalLogin({ userId: u.id, username, ip: req.ip });
      await audit.emit({ type: "vibe.auth.login.success", at: new Date().toISOString(), user_id: u.id, method: "local", ip: req.ip });
      res.json({ ok: true, user: { id: u.id, email: u.email, role: u.role } });
    },
  );
  app.post(`${BASE_PATH}/api/logout`, async (req, res) => {
    await sessions.destroy(req, res);
    res.json({ ok: true });
  });

  const requireAuth: express.RequestHandler = async (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const userId = bearer ? ((await query("SELECT user_id FROM sessions WHERE sid = $1 AND expires_at > now()", [bearer]))[0]?.user_id as number | undefined) : await sessions.currentUserId(req);
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    const u = await users.findById(String(userId));
    if (!u || !u.active) return res.status(401).json({ error: "unauthenticated" });
    (req as express.Request & { user?: typeof u }).user = u;
    next();
  };
  app.get(`${BASE_PATH}/api/me`, requireAuth, (req, res) => res.json({ user: (req as express.Request & { user?: unknown }).user }));
  app.get(`${BASE_PATH}/api/secret`, requireAuth, (_req, res) => res.json({ secret: "42" }));

  // SPA
  const ui = join(__dirname, "ui");
  if (existsSync(ui)) {
    app.use(BASE_PATH || "/", express.static(ui));
    app.get(`${BASE_PATH}/*`, (_req, res) => res.sendFile(join(ui, "index.html")));
  } else {
    app.get(`${BASE_PATH}/`, (_req, res) => res.type("html").send(`<h1>Ref App</h1><p>UI not built. <a href="${BASE_PATH}/auth/oidc/start">Sign in with SSO</a></p>`));
  }

  await auth.start();
  app.listen(PORT, () => console.log(JSON.stringify({ msg: "ref-app listening", port: PORT, mode: auth.mode, basePath: BASE_PATH })));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
