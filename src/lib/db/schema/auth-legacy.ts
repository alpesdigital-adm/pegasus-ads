import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

// ─── users ────────────────────────────────────────────────────────────────
// Fase 2 PR 2c fechou a migração: autenticação 100% via Supabase gotrue.
// Esta tabela vira "profile local" — name, avatar, metadata por app.
// Credenciais moram em auth.users (gotrue). password_hash foi dropado.
//
// authUserId NOT NULL: todo profile agora obrigatoriamente liga a um user
// do gotrue (migration 0008).
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  googleId: text("google_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  authUserId: uuid("auth_user_id").notNull().unique(),
  // Legacy (descobertas no cutover 2026-04-18 — bridge step 0):
  accountId: integer("account_id"),
  role: varchar("role", { length: 20 }).notNull().default("viewer"),
  isActive: boolean("is_active").default(true),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

// ─── api_keys ─────────────────────────────────────────────────────────────
// API keys são específicas do Pegasus Ads (não passam por gotrue).
// Continuam — chaves externas (Apps Script, cowork CRM, etc) pra consumo
// server-to-server.
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  // FK lógica para users.id.
  userId: uuid("user_id").notNull(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
