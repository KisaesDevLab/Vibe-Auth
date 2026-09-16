-- Vibe Auth client tables (Phase 3). Add to the product's migration set.
-- user_id is TEXT so it fits uuid and text primary keys alike; products may
-- add a FOREIGN KEY to their users table in their own migration.

CREATE TABLE IF NOT EXISTS auth_identities (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  email           TEXT,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auth_identities_issuer_subject_uq UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id);

-- Settings → Authentication values (mode, issuer, wrapped client secret, role map...).
CREATE TABLE IF NOT EXISTS auth_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Revocation list for stateless-JWT products (D16). Keys: "u:<user_id>" or "s:<sid>".
CREATE TABLE IF NOT EXISTS auth_revocations (
  subject_key    TEXT PRIMARY KEY,
  revoked_until  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_revocations_until_idx ON auth_revocations (revoked_until);
