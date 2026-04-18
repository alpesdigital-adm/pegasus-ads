import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  doublePrecision,
  boolean,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

// ─── campaigns ────────────────────────────────────────────────────────────
// Campanhas Meta Ads (rastreadas pelo Pegasus para testes e análise).
// RLS via workspace_id. meta_campaign_id é o ID externo da Meta.
export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  name: text("name").notNull(),
  // IDs externos Meta (TEXT, não UUID)
  metaCampaignId: text("meta_campaign_id").notNull(),
  metaAccountId: text("meta_account_id").notNull(),
  pixelId: text("pixel_id"),
  pageId: text("page_id"),
  instagramUserId: text("instagram_user_id"),
  objective: text("objective").default("OUTCOME_LEADS"),
  cplTarget: doublePrecision("cpl_target"),
  status: text("status").default("active"), // active|paused|archived
  config: jsonb("config").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── funnels ──────────────────────────────────────────────────────────────
// Multi-funil (T4, T7, etc). Vincula a config de ebook + campanha.
// RLS via workspace_id. Seeded com T4/T7 no legado (preservar seed na migration).
export const funnels = pgTable("funnels", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  ebookTitle: text("ebook_title"),
  cplTarget: doublePrecision("cpl_target"),
  metaCampaignId: text("meta_campaign_id"),
  metaAccountId: text("meta_account_id"),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// NOTA: a tabela `ad_sets` (primeira classe, Fase 6 — seção 13.5 do plano) NÃO
// entra nesta PR. Será adicionada quando a feature de importação Meta for
// implementada, para evitar código inútil até lá. Nome reservado neste comment
// para referência futura.
