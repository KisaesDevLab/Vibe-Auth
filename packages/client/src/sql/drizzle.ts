/**
 * Drizzle schema fragment for the Vibe Auth client tables. Import into the
 * product's schema file so drizzle-kit generates the migration:
 *
 *   export { authIdentities, authSettings, authRevocations } from "@kisaes/vibe-auth/sql/drizzle";
 *
 * drizzle-orm is an optional peer; this module is only loaded by products that use it.
 */
import { bigserial, boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id").notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issuerSubject: uniqueIndex("auth_identities_issuer_subject_uq").on(t.issuer, t.subject),
    userIdx: index("auth_identities_user_id_idx").on(t.userId),
  }),
);

export const authSettings = pgTable("auth_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authRevocations = pgTable(
  "auth_revocations",
  {
    subjectKey: text("subject_key").primaryKey(),
    revokedUntil: timestamp("revoked_until", { withTimezone: true }).notNull(),
  },
  (t) => ({ untilIdx: index("auth_revocations_until_idx").on(t.revokedUntil) }),
);
