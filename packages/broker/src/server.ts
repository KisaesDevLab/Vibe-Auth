import express, { type Request, type RequestHandler } from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { buildAdmin } from "./admin.js";
import { BrokerAudit, startEventForwarder } from "./audit.js";
import { Authentik } from "./authentik.js";
import { bootstrapAuthentik, type BootstrapResult, ensureBaseUrl } from "./bootstrap.js";
import { loadConfig, rebaseConfig, type BrokerConfig } from "./config.js";
import { Db } from "./db.js";
import { createLogger } from "./log.js";
import { NotFound, registrationInput, Registrations } from "./registrations.js";
import { Setup, setupDonePage, setupPage } from "./setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function main(): Promise<void> {
  let cfg: BrokerConfig = loadConfig();
  const log = createLogger(cfg.VIBE_AUTH_LOG_LEVEL);
  const db = new Db(cfg);
  await db.ensureDatabase();
  await db.migrate();

  // A persisted rebase (host/routing change) survives restarts until the env is updated.
  const persisted = await db.getState<{ host?: string; routing?: BrokerConfig["VIBE_AUTH_ROUTING"]; scheme?: BrokerConfig["VIBE_AUTH_SCHEME"]; publicUrl?: string | null }>("rebase");
  if (persisted) cfg = rebaseConfig(cfg, persisted);

  const ak = new Authentik(cfg.authentikInternalBase, cfg.VIBE_AUTH_AUTHENTIK_TOKEN);
  const audit = new BrokerAudit(cfg, db, log);
  const setup = new Setup(cfg, db, ak, log);
  let boot: BootstrapResult | null = null;
  let bootError: string | null = null;
  const regs = new Registrations(
    () => cfg,
    ak,
    db,
    () => {
      if (!boot) throw new Error("authentik not bootstrapped yet");
      return boot;
    },
  );

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  const base = cfg.VIBE_AUTH_BASE_PATH;

  // ---- health / version (unauthenticated; §2.2 healthcheck)
  app.get([`${base}/health`, "/health"], async (_req, res) => {
    let dbOk = false;
    try {
      await db.query("SELECT 1");
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const ok = dbOk && !!boot;
    res.status(ok ? 200 : 503).json({ ok, db: dbOk, authentik: !!boot, authentikVersion: boot?.version, bootError, setupDone: (await setup.state()).done, version: cfg.VIBE_AUTH_VERSION });
  });
  app.get([`${base}/version`, "/version"], (_req, res) => res.json({ version: cfg.VIBE_AUTH_VERSION, authentik: boot?.version ?? null, routing: cfg.VIBE_AUTH_ROUTING, publicBase: cfg.authentikPublicBase }));

  // ---- console-token protected registration API (§2.3)
  const requireConsole: RequestHandler = (req, res, next) => {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const a = Buffer.from(token);
    const b = Buffer.from(cfg.VIBE_AUTH_CONSOLE_TOKEN);
    if (!token || a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: "unauthorized" });
    if (!boot) return res.status(503).json({ error: "authentik_not_ready", bootError });
    next();
  };
  const consoleApi = express.Router();
  consoleApi.use(express.json());
  // Only the registration/rebase/setup-token surface is console-token protected; the
  // setup wizard, health, version and admin console share the same base path.
  consoleApi.use(["/registrations", "/rebase", "/setup/token"], requireConsole);
  consoleApi.get("/registrations", async (_req, res) => res.json(await regs.list()));
  consoleApi.get("/registrations/verify", async (_req, res) => res.json(await regs.verify()));
  consoleApi.post("/registrations", async (req, res) => {
    const parsed = registrationInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "validation_failed", issues: parsed.error.issues });
    const r = await regs.upsert(parsed.data);
    audit.emit({ type: `vibe.auth.registration.${r.created ? "created" : "updated"}` as never, at: new Date().toISOString(), slug: r.registration.slug, action: r.created ? "create" : "update", actor: "console" });
    res.status(r.created ? 201 : 200).json({ registration: r.registration, env: r.env, envFile: toEnvFile(r.env) });
  });
  consoleApi.get("/registrations/:slug", async (req, res) => {
    const r = await regs.get(req.params.slug);
    if (!r) return res.status(404).json({ error: "not_found" });
    const reveal = req.query.reveal === "1";
    const env = regs.envBlock(r, reveal ? ((await regs.secret(r.slug)) ?? undefined) : undefined);
    res.json({ registration: r, env, envFile: toEnvFile(env) });
  });
  consoleApi.post("/registrations/:slug/rotate", async (req, res) => {
    try {
      const r = await regs.rotate(req.params.slug);
      audit.emit({ type: "vibe.auth.registration.rotated" as never, at: new Date().toISOString(), slug: r.registration.slug, action: "rotate", actor: "console" });
      res.json({ registration: r.registration, env: r.env, envFile: toEnvFile(r.env) });
    } catch (e) {
      if (e instanceof NotFound) return res.status(404).json({ error: "not_found" });
      throw e;
    }
  });
  consoleApi.delete("/registrations/:slug", async (req, res) => {
    const ok = await regs.remove(req.params.slug);
    if (ok) audit.emit({ type: "vibe.auth.registration.deleted" as never, at: new Date().toISOString(), slug: req.params.slug, action: "delete", actor: "console" });
    res.status(ok ? 200 : 404).json({ ok });
  });
  consoleApi.post("/rebase", async (req, res) => {
    const b = req.body as { host?: string; routing?: BrokerConfig["VIBE_AUTH_ROUTING"]; scheme?: BrokerConfig["VIBE_AUTH_SCHEME"]; publicUrl?: string | null; products?: Record<string, string> };
    const patch = { host: b.host, routing: b.routing, scheme: b.scheme, publicUrl: b.publicUrl };
    const hasPatch = Object.values(patch).some((v) => v !== undefined);
    if (hasPatch) {
      cfg = rebaseConfig(cfg, patch);
      await db.setState("rebase", { ...(persisted ?? {}), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
      if (boot) await ensureBaseUrl(cfg, ak, log).catch((err: Error) => log.warn("base URL not updated on rebase", { error: err.message }));
    }
    const out = await regs.rebase(b.products ?? {});
    audit.emit({ type: "vibe.auth.registration.rebased" as never, at: new Date().toISOString(), action: "rebase", actor: "console", host: cfg.VIBE_AUTH_HOST, routing: cfg.VIBE_AUTH_ROUTING, count: out.length });
    res.json({ publicBase: cfg.authentikPublicBase, internalBase: cfg.authentikInternalBase, products: out.map((o) => ({ slug: o.slug, env: o.env, envFile: toEnvFile(o.env) })) });
  });
  consoleApi.get("/setup/token", async (_req, res) => res.json({ token: await setup.tokenForConsole(), state: await setup.state() }));
  app.use(base, consoleApi);

  // ---- setup wizard (D13)
  app.get(`${base}/setup`, async (req, res) => {
    const s = await setup.state();
    if (s.done) return res.redirect(`${base}/admin`);
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!(await setup.verifyToken(token))) return res.status(403).type("html").send(setupPage({ basePath: base, token: "", brand: cfg.VIBE_AUTH_BRAND_NAME, error: "A valid one-time setup token is required. Find it in the broker log or the Appliance console." }));
    res.type("html").send(setupPage({ basePath: base, token, brand: cfg.VIBE_AUTH_BRAND_NAME }));
  });
  app.post(`${base}/setup`, express.urlencoded({ extended: false }), async (req, res) => {
    if (!boot) return res.status(503).type("html").send(setupPage({ basePath: base, token: String(req.body.token ?? ""), brand: cfg.VIBE_AUTH_BRAND_NAME, error: "Authentik is still starting; try again in a minute." }));
    const b = req.body as Record<string, string>;
    const r = await setup.complete({ token: b.token ?? "", firmName: b.firmName ?? "", adminEmail: b.adminEmail ?? "", adminName: b.adminName ?? "", password: b.password ?? "" }, boot);
    if (!r.ok) return res.status(400).type("html").send(setupPage({ basePath: base, token: b.token ?? "", brand: cfg.VIBE_AUTH_BRAND_NAME, error: r.error }));
    cfg.VIBE_AUTH_BRAND_NAME = b.firmName!;
    audit.emit({ type: "vibe.auth.setup.completed" as never, at: new Date().toISOString(), admin_email: b.adminEmail });
    res.type("html").send(setupDonePage({ loginUrl: r.loginUrl, adminUrl: `${cfg.brokerPublicBase}/admin`, brand: b.firmName! }));
  });

  // ---- admin console (mounted after bootstrap completes)
  let adminRouter: express.Router | null = null;
  app.use((req, res, next) => (adminRouter ? adminRouter(req, res, next) : next()));
  const ui = join(__dirname, "ui");
  if (existsSync(ui)) {
    app.use(`${base}/admin`, express.static(ui));
    app.get(`${base}/admin/*`, (_req: Request, res) => res.sendFile(join(ui, "index.html")));
  } else {
    app.get(`${base}/admin`, (_req, res) => res.type("html").send("<h1>Vibe Auth</h1><p>Admin UI not built.</p>"));
  }
  app.get([base, `${base}/`], (_req, res) => res.redirect(`${base}/admin`));

  const server = app.listen(cfg.VIBE_AUTH_PORT, () => log.info("broker listening", { port: cfg.VIBE_AUTH_PORT, base, publicBase: cfg.authentikPublicBase, routing: cfg.VIBE_AUTH_ROUTING }));

  // ---- bootstrap in the background so /health can report progress
  let stopForwarder: () => void = () => undefined;
  (async () => {
    for (;;) {
      try {
        boot = await bootstrapAuthentik(cfg, ak, db, log);
        await setup.init();
        const admin = await buildAdmin({ cfg: () => cfg, db, ak, boot: () => boot!, regs, audit, setup, log });
        adminRouter = admin.router;
        await admin.ready();
        stopForwarder = startEventForwarder(cfg, ak, db, audit, log);
        bootError = null;
        log.info("bootstrap complete", { groups: Object.keys(boot.groups), mfaRequired: boot.mfaRequired });
        return;
      } catch (err) {
        bootError = (err as Error).message;
        log.error("bootstrap failed; retrying in 15s", { error: bootError });
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  })();

  const shutdown = () => {
    stopForwarder();
    server.close(() => void db.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function toEnvFile(env: object): string {
  return Object.entries(env as Record<string, string | undefined>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, "/") || process.argv[1].endsWith("server.js") || process.argv[1].endsWith("server.ts") : false;
if (entry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
