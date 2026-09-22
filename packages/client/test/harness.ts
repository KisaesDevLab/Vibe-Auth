/** Test harness: an Express app with in-memory adapters wired to createVibeAuth. */
import express from "express";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import type { AuditEvent, SessionAdapter, SessionIdentity, UserAdapter, VibeUser } from "../src/adapters/types.js";
import { MemoryRevocationList } from "../src/adapters/memory.js";
import { createVibeAuth, type VibeAuthOptions } from "../src/engine.js";
import { vibeAuthExpress, guardLocalLogin } from "../src/express.js";

export const ROLES = { roles: ["admin", "reviewer", "preparer"], adminRole: "admin" } as const;

export class MemoryUsers implements UserAdapter {
  rows = new Map<string, VibeUser & { password?: string }>();
  seq = 0;
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findByEmail(email: string) {
    return [...this.rows.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
  }
  async findByUsername(username: string) {
    return [...this.rows.values()].find((u) => u.username?.toLowerCase() === username.toLowerCase()) ?? null;
  }
  async create(i: { email: string; name?: string; role: string }) {
    const id = String(++this.seq);
    const u: VibeUser = { id, email: i.email, name: i.name, role: i.role, active: true };
    this.rows.set(id, u);
    return u;
  }
  async setRole(userId: string, role: string) {
    const u = this.rows.get(userId);
    if (u) u.role = role;
  }
  async createLocalUser(i: { username: string; email: string; name: string; role: string; password: string }) {
    const id = String(++this.seq);
    const u = { id, email: i.email, name: i.name, role: i.role, active: true, local: true, username: i.username, password: i.password };
    this.rows.set(id, u);
    return u;
  }
  async setLocalPassword(userId: string, password: string) {
    const u = this.rows.get(userId);
    if (u) u.password = password;
  }
  async setActive(userId: string, active: boolean) {
    const u = this.rows.get(userId);
    if (u) u.active = active;
  }
}

/** Cookie session keyed by an opaque id; stores identity for logout tests. */
export class MemorySessions implements SessionAdapter {
  store = new Map<string, { userId: string; identity: SessionIdentity }>();
  tokens = new Map<string, { userId: string; identity: SessionIdentity }>();
  /** Step-up markers written by markStepUp (1.0.8), keyed by sid. */
  stepUps = new Map<string, number>();
  async create(_req: express.Request, res: express.Response, user: VibeUser, identity: SessionIdentity) {
    const sid = "s" + Math.random().toString(36).slice(2);
    this.store.set(sid, { userId: user.id, identity });
    res.setHeader("set-cookie", `sid=${sid}; Path=/; HttpOnly`);
  }
  async destroy(req: express.Request, res: express.Response) {
    const sid = cookie(req, "sid");
    if (sid) this.store.delete(sid);
    res.setHeader("set-cookie", "sid=; Path=/; Max-Age=0");
  }
  async currentUserId(req: express.Request) {
    const sid = cookie(req, "sid");
    return sid ? (this.store.get(sid)?.userId ?? null) : null;
  }
  async currentIdentity(req: express.Request) {
    const sid = cookie(req, "sid");
    return sid ? (this.store.get(sid)?.identity ?? null) : null;
  }
  async destroyByIdentity(i: { issuer: string; subject?: string; sid?: string; userId?: string }) {
    let n = 0;
    for (const [k, v] of this.store) {
      const match = (i.sid && v.identity.sid === i.sid) || (i.subject && v.identity.subject === i.subject && v.identity.issuer === i.issuer) || (i.userId && v.userId === i.userId);
      if (match) {
        this.store.delete(k);
        n++;
      }
    }
    return n;
  }
  async markStepUp(req: express.Request, _res: express.Response, _user: VibeUser, _identity: SessionIdentity) {
    const sid = cookie(req, "sid");
    if (!sid || !this.store.has(sid)) throw new Error("no session to mark");
    this.stepUps.set(sid, Date.now());
  }
  async issueToken(user: VibeUser, identity: SessionIdentity) {
    const token = "t" + createHash("sha256").update(user.id + Math.random()).digest("hex").slice(0, 16);
    this.tokens.set(token, { userId: user.id, identity });
    return { token };
  }
}

export function cookie(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export interface Harness {
  app: express.Express;
  server: Server;
  base: string;
  users: MemoryUsers;
  sessions: MemorySessions;
  events: AuditEvent[];
  auth: ReturnType<typeof createVibeAuth>;
  revocations: MemoryRevocationList;
  stop(): Promise<void>;
}

export async function startHarness(env: Record<string, string>, extra: Partial<VibeAuthOptions> = {}): Promise<Harness> {
  const users = (extra.users as MemoryUsers | undefined) ?? new MemoryUsers();
  const sessions = (extra.session as MemorySessions | undefined) ?? new MemorySessions();
  const events: AuditEvent[] = [];
  const revocations = new MemoryRevocationList();
  const auth = createVibeAuth({
    product: { slug: "ref", name: "Ref App", roles: ROLES },
    users,
    session: sessions,
    audit: { emit: (e) => void events.push(e) },
    revocations,
    env,
    logger: { info() {}, warn() {}, error() {} },
    ...extra,
  });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(vibeAuthExpress(auth));
  app.post(
    "/login",
    guardLocalLogin(auth, (r) => (r.body as { username?: string }).username),
    async (req, res) => {
      const { username, password } = req.body as { username: string; password: string };
      const u = await users.findByUsername(username);
      if (!u || u.password !== password) return res.status(401).json({ error: "bad_credentials" });
      await sessions.create(req, res, u, { issuer: "local", subject: u.id });
      await auth.afterLocalLogin({ userId: u.id, username, ip: req.ip });
      res.json({ ok: true });
    },
  );
  app.get("/", (_req, res) => res.send("home"));
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  await auth.start();
  return {
    app,
    server,
    base,
    users,
    sessions,
    events,
    auth,
    revocations,
    async stop() {
      auth.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Follows the redirect chain from /auth/oidc/start through the fake IdP back to the app, collecting cookies. */
export async function loginViaBrowser(base: string, startPath = "/auth/oidc/start", cookies: string[] = []) {
  let url = base + startPath;
  let lastStatus = 0;
  let lastBody = "";
  let lastLocation = "";
  for (let i = 0; i < 8; i++) {
    const res = await fetch(url, { redirect: "manual", headers: { cookie: cookies.join("; ") } });
    lastStatus = res.status;
    const sc = res.headers.get("set-cookie");
    if (sc) cookies.push(sc.split(";")[0]!);
    lastLocation = res.headers.get("location") ?? "";
    if (res.status >= 300 && res.status < 400 && lastLocation) {
      // The callback's redirect is the end of the flow; report its Location.
      if (url.includes("/auth/oidc/callback")) break;
      url = new URL(lastLocation, url).toString();
      if (!url.startsWith(base) && !url.includes("127.0.0.1")) break;
      continue;
    }
    lastBody = await res.text();
    break;
  }
  return { status: lastStatus, body: lastBody, cookies, location: lastLocation, url };
}
