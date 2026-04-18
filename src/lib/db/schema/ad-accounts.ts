// =============================================================================
// ad_accounts — tabela pivot do grafo de FKs Meta
// =============================================================================
// Descoberta na Fase 1B (commit 574a412): referenciada por 4 tabelas —
// ad_insights, classified_insights, hourly_insights, sync_logs. Armazena
// credenciais de contas Meta Ads (diferente de workspace_meta_accounts, que é
// per-workspace com encryption).
//
// Diferenças vs. workspace_meta_accounts:
// - ad_accounts: global (não tem workspace_id). Credenciais do sistema.
// - workspace_meta_accounts: per-workspace, com token_encrypted (AES-256-GCM).
//
// Conversão Neon → Drizzle:
// - id: integer serial → uuid (gen_random_uuid). Mapping no step 05.
// - meta_account_id: varchar(50) → text com UNIQUE
// =============================================================================

import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  varchar,
} from "drizzle-orm/pg-core";

export const adAccounts = pgTable("ad_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  metaAccountId: varchar("meta_account_id", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  accessToken: text("access_token").notNull(),
  appSecret: text("app_secret"),
  apiVersion: varchar("api_version", { length: 10 }).default("v25.0"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
