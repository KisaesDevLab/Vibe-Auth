import type { IdentityRecord, IdentityStore, RevocationList, SettingsStore, StoredAuthSettings } from "./types.js";
import { keysOf } from "./memory.js";

/**
 * Query-function-backed stores for the auth_identities / auth_settings /
 * auth_revocations tables (see sql/auth_identities.sql). Works with pg,
 * postgres.js, knex or drizzle: pass any function that runs parameterised SQL
 * with $1..$n placeholders and returns rows.
 */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export interface PgStoresOptions {
  query: QueryFn;
  /** Table name overrides (schema-qualified allowed). */
  tables?: { identities?: string; settings?: string; revocations?: string };
}

function ident(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(name)) throw new Error(`invalid table name: ${name}`);
  return name;
}

export function createPgIdentityStore(o: PgStoresOptions): IdentityStore {
  const t = ident(o.tables?.identities ?? "auth_identities");
  const row = (r: Record<string, unknown>): IdentityRecord => ({
    userId: String(r.user_id),
    issuer: String(r.issuer),
    subject: String(r.subject),
    email: r.email == null ? undefined : String(r.email),
    emailVerified: Boolean(r.email_verified),
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at as string) : undefined,
  });
  const norm = (iss: string) => iss.replace(/\/+$/, "") + "/";
  return {
    async findByIssuerSubject(issuer, subject) {
      const rows = await o.query(`SELECT * FROM ${t} WHERE issuer = $1 AND subject = $2 LIMIT 1`, [norm(issuer), subject]);
      return rows[0] ? row(rows[0]) : null;
    },
    async listForUser(userId) {
      const rows = await o.query(`SELECT * FROM ${t} WHERE user_id = $1 ORDER BY created_at`, [userId]);
      return rows.map(row);
    },
    async link(rec) {
      await o.query(
        `INSERT INTO ${t} (user_id, issuer, subject, email, email_verified, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (issuer, subject) DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified, last_login_at = EXCLUDED.last_login_at`,
        [rec.userId, norm(rec.issuer), rec.subject, rec.email ?? null, rec.emailVerified, rec.lastLoginAt ?? null],
      );
    },
    async touch(issuer, subject, at) {
      await o.query(`UPDATE ${t} SET last_login_at = $3 WHERE issuer = $1 AND subject = $2`, [norm(issuer), subject, at]);
    },
    async unlink(issuer, subject) {
      await o.query(`DELETE FROM ${t} WHERE issuer = $1 AND subject = $2`, [norm(issuer), subject]);
    },
  };
}

export function createPgSettingsStore(o: PgStoresOptions, key = "vibe_auth"): SettingsStore {
  const t = ident(o.tables?.settings ?? "auth_settings");
  return {
    async get() {
      const rows = await o.query(`SELECT value FROM ${t} WHERE key = $1`, [key]);
      const v = rows[0]?.value;
      if (v == null) return null;
      return (typeof v === "string" ? JSON.parse(v) : v) as StoredAuthSettings;
    },
    async set(next) {
      await o.query(
        `INSERT INTO ${t} (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(next)],
      );
    },
  };
}

export function createPgRevocationList(o: PgStoresOptions): RevocationList {
  const t = ident(o.tables?.revocations ?? "auth_revocations");
  return {
    async revoke(key, revokedAt, until) {
      for (const k of keysOf(key)) {
        await o.query(
          `INSERT INTO ${t} (subject_key, revoked_at, revoked_until) VALUES ($1, $2, $3)
           ON CONFLICT (subject_key) DO UPDATE SET revoked_at = GREATEST(${t}.revoked_at, EXCLUDED.revoked_at), revoked_until = GREATEST(${t}.revoked_until, EXCLUDED.revoked_until)`,
          [k, revokedAt, until],
        );
      }
    },
    async isRevoked(key, issuedAtMs) {
      const keys = keysOf(key);
      if (!keys.length) return false;
      const rows = await o.query(`SELECT revoked_at FROM ${t} WHERE subject_key = ANY($1::text[]) AND revoked_until > now()`, [keys]);
      return rows.some((r) => new Date(r.revoked_at as string).getTime() >= issuedAtMs);
    },
  };
}

export function createPgStores(o: PgStoresOptions) {
  return {
    identities: createPgIdentityStore(o),
    settings: createPgSettingsStore(o),
    revocations: createPgRevocationList(o),
  };
}
