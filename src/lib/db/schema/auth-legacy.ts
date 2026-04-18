import {
  pgTable,
  uuid,
  text,
  timestamp,
  check,
  varchar,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces";

// ─── users — LEGADO (remover na Fase 5) ───────────────────────────────────
// Fase 2 migra usuários para auth.users (Supabase gotrue). Tabela mantida
// como bridge ativa (commit ea7b4a6 — cutover 2026-04-18) até Fase 2 estar
// estável + 30 dias.
//
// As 4 últimas colunas (account_id/role/is_active/last_login_at) existiam no
// Neon mas não estavam neste schema — descobertas durante a bridge. Mantidas
// aqui pra evitar drift entre Drizzle e DB. Vão embora junto com a tabela.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  passwordHash: text("password_hash"),
  googleId: text("google_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // Fase 2 — liga ao auth.users (gotrue). Nullable durante transição; passa a
  // NOT NULL no final da Fase 2 após script de migração rodar.
  authUserId: uuid("auth_user_id").unique(),
  // Legacy (descobertas no cutover 2026-04-18 — bridge step 0):
  accountId: integer("account_id"),
  role: varchar("role", { length: 20 }).notNull().default("viewer"),
  isActive: boolean("is_active").default(true),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

// ─── sessions — LEGADO (remover na Fase 5) ────────────────────────────────
// Fase 2 usa Supabase Auth (cookies sb-*-auth-token gerenciados por @supabase/ssr).
export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  () => [],
);

// ─── api_keys ─────────────────────────────────────────────────────────────
// API keys são específicas do Pegasus (não migram para gotrue).
// Continuam após Fase 2 — a chave da organização acessar a Meta.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // FK para users (legado) / auth.users (Fase 2+). Mantido como uuid.
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  () => [],
);

// Nota: CHECK sobre sessions/api_keys não precisa — tipos garantem.
// placeholder para satisfazer lint quando refatorar policies RLS depois.
void check;
void sql;
