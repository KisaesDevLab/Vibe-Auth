import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";

const require = createRequire(import.meta.url);

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://ref:ref@localhost:5433/ref" });

export async function query(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(sql, params);
  return r.rows as Array<Record<string, unknown>>;
}

export async function migrate(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'preparer',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issuer TEXT,
    subject TEXT,
    oidc_sid TEXT,
    id_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS audit_log (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), type TEXT NOT NULL, payload JSONB NOT NULL)`);
  // The package's SQL fragment (auth_identities, auth_settings, auth_revocations).
  const sqlPath = require.resolve("@kisaes/vibe-auth/sql/auth_identities.sql");
  await query(readFileSync(sqlPath, "utf8"));
}
