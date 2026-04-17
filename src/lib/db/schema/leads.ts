// =============================================================================
// Leads legacy — accounts, lead_sources, leads
// =============================================================================
// Sistema legado de captura de leads via Google Sheets (pré-CRM import).
// Diferente de crm_leads (que é multi-tenant, workspace_id-based).
//
// Cadeia FK: leads → lead_sources → accounts (tudo integer serial → uuid).
//
// NOTA: apenas 1 account/1 lead_source hoje — provavelmente legado do tempo
// single-tenant. Considerar DROP após migração (TD futuro) se não usado.
// =============================================================================

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  varchar,
  jsonb,
  unique,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ─── accounts (legacy — 1 row) ──────────────────────────────────────────
// NÃO confundir com ad_accounts (central para Meta sync). Este é multi-tenancy
// legacy antes da migração pra workspaces.
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  metaAccessToken: text("meta_access_token"),
  metaAccountId: varchar("meta_account_id", { length: 50 }),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── lead_sources ───────────────────────────────────────────────────────
// Config de onde leads vêm (Google Sheets, etc).
export const leadSources = pgTable(
  "lead_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: varchar("name", { length: 255 }).notNull(),
    sheetId: varchar("sheet_id", { length: 255 }).notNull(),
    sheetTab: varchar("sheet_tab", { length: 100 }).default("Leads"),
    headerRow: integer("header_row").default(1),
    columnMap: jsonb("column_map").notNull(),
    campaignMatchRules: jsonb("campaign_match_rules"),
    isActive: boolean("is_active").default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastRowCount: integer("last_row_count").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_lead_sources_account").on(t.accountId),
    index("idx_lead_sources_active").on(t.isActive),
  ],
);

// ─── leads ──────────────────────────────────────────────────────────────
// Leads individuais importados (3833 rows atual).
// UNIQUE (source_type, source_id, email_hash) — dedupe por fonte + email.
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    sourceType: varchar("source_type", { length: 20 }).notNull(),
    sourceId: uuid("source_id").references((): AnyPgColumn => leadSources.id),
    email: varchar("email", { length: 320 }),
    emailHash: varchar("email_hash", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }),
    phone: varchar("phone", { length: 50 }),
    utmSource: varchar("utm_source", { length: 200 }),
    utmMedium: varchar("utm_medium", { length: 200 }),
    utmCampaign: varchar("utm_campaign", { length: 500 }),
    utmContent: varchar("utm_content", { length: 500 }),
    utmTerm: varchar("utm_term", { length: 500 }),
    utmId: varchar("utm_id", { length: 100 }),
    campaignId: varchar("campaign_id", { length: 50 }),
    adsetId: varchar("adset_id", { length: 50 }),
    adId: varchar("ad_id", { length: 50 }),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow(),
    qualificado: boolean("qualificado"),
    pagina: varchar("pagina", { length: 200 }),
    objeto: varchar("objeto", { length: 200 }),
    formato: varchar("formato", { length: 100 }),
    temperatura: varchar("temperatura", { length: 30 }),
    evento: varchar("evento", { length: 200 }),
    fase: varchar("fase", { length: 30 }),
  },
  (t) => [
    unique("uq_leads_source_email").on(t.sourceType, t.sourceId, t.emailHash),
    index("idx_leads_account_created").on(t.accountId, t.createdAt),
    index("idx_leads_campaign").on(t.campaignId),
    index("idx_leads_evento").on(t.evento),
    index("idx_leads_fase").on(t.fase),
    index("idx_leads_qualificado").on(t.qualificado),
    index("idx_leads_source").on(t.sourceType, t.sourceId),
  ],
);
