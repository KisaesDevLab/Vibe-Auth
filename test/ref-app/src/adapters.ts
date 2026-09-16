import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { AuditSink, SecretWrap, SessionAdapter, SessionIdentity, UserAdapter, VibeUser } from "@kisaes/vibe-auth";
import { query } from "./db.js";

export const ROLES = { roles: ["admin", "reviewer", "preparer"] as const, adminRole: "admin" };

// ---- passwords (scrypt) ----
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 32);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [, saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const key = scryptSync(pw, Buffer.from(saltHex, "hex"), 32);
  return timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}

function rowToUser(r: Record<string, unknown>): VibeUser {
  return {
    id: String(r.id),
    email: String(r.email),
    name: r.name ? String(r.name) : undefined,
    role: String(r.role),
    active: Boolean(r.active),
    local: !!r.password_hash,
    username: r.username ? String(r.username) : undefined,
  };
}

export const users: UserAdapter = {
  async findById(id) {
    const r = await query("SELECT * FROM users WHERE id = $1", [Number(id)]);
    return r[0] ? rowToUser(r[0]) : null;
  },
  async findByEmail(email) {
    const r = await query("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
    return r[0] ? rowToUser(r[0]) : null;
  },
  async findByUsername(username) {
    const r = await query("SELECT * FROM users WHERE lower(username) = lower($1)", [username]);
    return r[0] ? rowToUser(r[0]) : null;
  },
  async create(i) {
    const r = await query("INSERT INTO users (email, name, role) VALUES ($1, $2, $3) RETURNING *", [i.email, i.name ?? null, i.role]);
    return rowToUser(r[0]!);
  },
  async setRole(userId, role) {
    await query("UPDATE users SET role = $2 WHERE id = $1", [Number(userId), role]);
  },
  async createLocalUser(i) {
    const r = await query("INSERT INTO users (username, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING *", [i.username, i.email, i.name, i.role, hashPassword(i.password)]);
    return rowToUser(r[0]!);
  },
  async setLocalPassword(userId, password) {
    await query("UPDATE users SET password_hash = $2 WHERE id = $1", [Number(userId), hashPassword(password)]);
  },
  async setActive(userId, active) {
    await query("UPDATE users SET active = $2 WHERE id = $1", [Number(userId), active]);
  },
};

export async function verifyLocalLogin(username: string, password: string): Promise<VibeUser | null> {
  const r = await query("SELECT * FROM users WHERE lower(username) = lower($1) AND active", [username]);
  const row = r[0];
  if (!row || !verifyPassword(password, row.password_hash as string | null)) return null;
  return rowToUser(row);
}

// ---- sessions (server-side, cookie sid) ----
const COOKIE = "ref_sid";
const TTL_MS = 8 * 60 * 60_000;

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export const sessions: SessionAdapter = {
  async create(_req: Request, res: Response, user: VibeUser, identity: SessionIdentity) {
    const sid = randomBytes(24).toString("base64url");
    await query("INSERT INTO sessions (sid, user_id, issuer, subject, oidc_sid, id_token, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      sid,
      Number(user.id),
      identity.issuer,
      identity.subject,
      identity.sid ?? null,
      identity.idToken ?? null,
      new Date(Date.now() + TTL_MS),
    ]);
    const secure = (process.env.SESSION_SECURE ?? "false") === "true";
    res.setHeader("set-cookie", `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${TTL_MS / 1000}`);
  },
  async destroy(req: Request, res: Response) {
    const sid = readCookie(req, COOKIE);
    if (sid) await query("DELETE FROM sessions WHERE sid = $1", [sid]);
    res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  },
  async currentUserId(req: Request) {
    const sid = readCookie(req, COOKIE);
    if (!sid) return null;
    const r = await query("SELECT user_id FROM sessions WHERE sid = $1 AND expires_at > now()", [sid]);
    return r[0] ? String(r[0].user_id) : null;
  },
  async currentIdentity(req: Request) {
    const sid = readCookie(req, COOKIE);
    if (!sid) return null;
    const r = await query("SELECT issuer, subject, oidc_sid, id_token FROM sessions WHERE sid = $1", [sid]);
    const row = r[0];
    if (!row || !row.issuer) return null;
    return { issuer: String(row.issuer), subject: String(row.subject), sid: row.oidc_sid ? String(row.oidc_sid) : undefined, idToken: row.id_token ? String(row.id_token) : undefined };
  },
  async destroyByIdentity(i) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (i.sid) {
      params.push(i.sid);
      clauses.push(`oidc_sid = $${params.length}`);
    }
    if (i.subject) {
      params.push(i.issuer, i.subject);
      clauses.push(`(issuer = $${params.length - 1} AND subject = $${params.length})`);
    }
    if (i.userId) {
      params.push(Number(i.userId));
      clauses.push(`user_id = $${params.length}`);
    }
    if (!clauses.length) return 0;
    const r = await query(`DELETE FROM sessions WHERE ${clauses.join(" OR ")} RETURNING sid`, params);
    return r.length;
  },
  async issueToken(user, identity) {
    // Desktop clients: the sid doubles as a bearer token (Authorization: Bearer <sid>).
    const sid = randomBytes(24).toString("base64url");
    await query("INSERT INTO sessions (sid, user_id, issuer, subject, oidc_sid, id_token, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      sid,
      Number(user.id),
      identity.issuer,
      identity.subject,
      identity.sid ?? null,
      identity.idToken ?? null,
      new Date(Date.now() + TTL_MS),
    ]);
    return { token: sid, expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
  },
};

// ---- audit ----
export const audit: AuditSink = {
  async emit(e) {
    const { type, at, ...payload } = e;
    await query("INSERT INTO audit_log (at, type, payload) VALUES ($1, $2, $3)", [at, type, JSON.stringify(payload)]);
    process.stdout.write(JSON.stringify(e) + "\n");
  },
};

// ---- secret wrap (AES-256-GCM with ENCRYPTION_KEY, mirroring the products' pattern) ----
export const secretWrap: SecretWrap = {
  async wrap(p) {
    const key = createHash("sha256").update(process.env.ENCRYPTION_KEY ?? "ref-dev-key").digest();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(p, "utf8"), c.final()]);
    return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
  },
  async unwrap(w) {
    const [v, ivB, tagB, ctB] = w.split(":");
    if (v !== "v1" || !ivB || !tagB || !ctB) throw new Error("bad wrapped secret");
    const key = createHash("sha256").update(process.env.ENCRYPTION_KEY ?? "ref-dev-key").digest();
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
  },
};
