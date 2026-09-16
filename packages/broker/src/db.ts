import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pg from "pg";
import type { BrokerConfig } from "./config.js";

export type Row = Record<string, unknown>;

export class Db {
  pool: pg.Pool;
  private key: Buffer;
  constructor(private cfg: BrokerConfig) {
    this.pool = new pg.Pool({ connectionString: cfg.VIBE_AUTH_DATABASE_URL, max: 5 });
    this.key = Buffer.from(cfg.VIBE_AUTH_SECRET_KEY, "hex");
  }

  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const r = await this.pool.query(sql, params);
    return r.rows as Row[];
  }

  /** D7: create database + role when a superuser URL is supplied and they are absent. Idempotent. */
  async ensureDatabase(): Promise<void> {
    if (!this.cfg.VIBE_AUTH_PG_ADMIN_URL) return;
    const target = new URL(this.cfg.VIBE_AUTH_DATABASE_URL);
    const dbName = target.pathname.replace(/^\//, "");
    const user = decodeURIComponent(target.username);
    const pass = decodeURIComponent(target.password);
    if (!/^[a-z_][a-z0-9_]*$/.test(dbName) || !/^[a-z_][a-z0-9_]*$/.test(user)) throw new Error("vibe_auth database/role names must be [a-z0-9_]");
    const admin = new pg.Client({ connectionString: this.cfg.VIBE_AUTH_PG_ADMIN_URL });
    await admin.connect();
    try {
      const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
      if (!role.rowCount) await admin.query(`CREATE ROLE "${user}" WITH LOGIN PASSWORD '${pass.replace(/'/g, "''")}'`);
      else await admin.query(`ALTER ROLE "${user}" WITH LOGIN PASSWORD '${pass.replace(/'/g, "''")}'`);
      const db = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      if (!db.rowCount) await admin.query(`CREATE DATABASE "${dbName}" OWNER "${user}"`);
      await admin.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
      await admin.query(`GRANT CONNECT, TEMP ON DATABASE "${dbName}" TO "${user}"`);
    } finally {
      await admin.end();
    }
  }

  /**
   * Broker tables live in the same vibe_auth database as authentik (§2.1) and
   * are prefixed vibe_broker_ so they can never collide with Django's auth_* tables.
   */
  async migrate(): Promise<void> {
    await this.query(`CREATE TABLE IF NOT EXISTS vibe_broker_registrations (
      slug TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      internal_url TEXT,
      client_id TEXT NOT NULL,
      client_secret_enc TEXT NOT NULL,
      redirect_paths JSONB NOT NULL DEFAULT '[]',
      logout_paths JSONB NOT NULL DEFAULT '[]',
      public_paths JSONB NOT NULL DEFAULT '[]',
      edge_gate BOOLEAN NOT NULL DEFAULT FALSE,
      provider_pk INTEGER,
      application_slug TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      rotated_at TIMESTAMPTZ
    )`);
    await this.query(`ALTER TABLE vibe_broker_registrations ADD COLUMN IF NOT EXISTS internal_url TEXT`);
    await this.query(`CREATE TABLE IF NOT EXISTS vibe_broker_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await this.query(`CREATE TABLE IF NOT EXISTS vibe_broker_audit (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL, type TEXT NOT NULL, payload JSONB NOT NULL)`);
    await this.query(`CREATE INDEX IF NOT EXISTS vibe_broker_audit_at_idx ON vibe_broker_audit (at DESC)`);
    await this.query(`CREATE TABLE IF NOT EXISTS vibe_broker_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'admin',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await this.query(`CREATE TABLE IF NOT EXISTS vibe_broker_sessions (
      sid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      issuer TEXT, subject TEXT, oidc_sid TEXT, id_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);
    await this.query(`CREATE TABLE IF NOT EXISTS vibe_broker_identities (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      email TEXT, email_verified BOOLEAN NOT NULL DEFAULT FALSE, last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (issuer, subject))`);
    await this.query(`CREATE TABLE IF NOT EXISTS vibe_broker_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await this.query(`CREATE TABLE IF NOT EXISTS vibe_broker_revocations (subject_key TEXT PRIMARY KEY, revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_until TIMESTAMPTZ NOT NULL)`);
    await this.query(`ALTER TABLE vibe_broker_revocations ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
  }

  async getState<T = unknown>(key: string): Promise<T | null> {
    const r = await this.query("SELECT value FROM vibe_broker_state WHERE key = $1", [key]);
    return r[0] ? (r[0].value as T) : null;
  }
  async setState(key: string, value: unknown): Promise<void> {
    await this.query("INSERT INTO vibe_broker_state (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [key, JSON.stringify(value)]);
  }

  wrap(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
  }
  unwrap(w: string): string {
    const [v, ivB, tagB, ctB] = w.split(":");
    if (v !== "v1" || !ivB || !tagB || !ctB) throw new Error("bad wrapped value");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
