import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

// ─── crm_leads ────────────────────────────────────────────────────────────
// Leads importados do CRM (Kommo, etc) para enriquecimento de métricas.
// PK composta (workspace_id, crm_id) — crm_id NÃO migra para UUID (é TEXT
// externo controlado pelo CRM fonte). workspace_id É UUID.
// Atribuição via trio UTM (utm_content = ad_name, utm_campaign, utm_term).
export const crmLeads = pgTable(
  "crm_leads",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    crmId: text("crm_id").notNull(), // ID do CRM fonte — NÃO UUID
    email: text("email"),
    phone: text("phone"),
    fullName: text("full_name"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    fbclid: text("fbclid"),
    adId: text("ad_id"),
    adsetId: text("adset_id"),
    campaignId: text("campaign_id"),
    isQualified: boolean("is_qualified").default(false),
    qualificationData: jsonb("qualification_data").default({}),
    subscribedAt: timestamp("subscribed_at", { withTimezone: true }),
    firstSubscribedAt: timestamp("first_subscribed_at", { withTimezone: true }),
    sourceFile: text("source_file"),
    rawData: jsonb("raw_data").default({}),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.crmId] })],
);

// ─── lead_qualification_rules ─────────────────────────────────────────────
// Regras de qualificação de lead por projeto (JSON policy).
// Unique (workspace_id, project_key).
export const leadQualificationRules = pgTable(
  "lead_qualification_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectKey: text("project_key").notNull(),
    rules: jsonb("rules").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_qual_rules_ws_project").on(t.workspaceId, t.projectKey)],
);
