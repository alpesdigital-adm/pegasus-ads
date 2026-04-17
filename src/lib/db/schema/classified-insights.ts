// =============================================================================
// classified_insights (TD-008 — resolvido na Fase 1B commit 574a412)
// =============================================================================
// Tabela de insights da Meta API classificados por launch/phase/audiência.
// Criada no Neon em 2026-04-12 fora do initDb() — usada pelo /api/cron/sync-all
// e pela /insights page.
//
// FKs (resolvidas — ad_accounts e ad_insights agora existem nos schemas):
//   - account_id → ad_accounts(id): adicionado. Antes era bigint (vestigial),
//     agora UUID com reference.
//   - insight_id → ad_insights(id): adicionado. Antes era integer sem FK.
//
// Conversão na Fase 1B:
//   - id integer → uuid (gen_random_uuid)
//   - account_id bigint → uuid (via mapping ad_accounts)
//   - insight_id integer → uuid (via mapping ad_insights)
//   - varchar(N) mantém para compatibilidade com queries existentes
// =============================================================================

import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  varchar,
  integer,
  numeric,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { adAccounts } from "./ad-accounts";
import { adInsights } from "./insights";

export const classifiedInsights = pgTable(
  "classified_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    insightId: uuid("insight_id")
      .notNull()
      .references(() => adInsights.id),
    accountId: uuid("account_id").references(() => adAccounts.id),

    date: date("date").notNull(),
    campaignId: varchar("campaign_id", { length: 50 }).notNull(),
    campaignName: varchar("campaign_name", { length: 500 }),
    adsetId: varchar("adset_id", { length: 50 }).notNull(),
    adsetName: varchar("adset_name", { length: 500 }),
    adId: varchar("ad_id", { length: 50 }).notNull(),
    adName: varchar("ad_name", { length: 500 }),

    launch: varchar("launch", { length: 50 }),
    phase: varchar("phase", { length: 50 }),
    subphase: varchar("subphase", { length: 100 }),
    captureType: varchar("capture_type", { length: 50 }),
    audienceCategory: varchar("audience_category", { length: 10 }),
    temperature: varchar("temperature", { length: 20 }),
    creativeType: varchar("creative_type", { length: 30 }),
    page: varchar("page", { length: 100 }),
    ebook: varchar("ebook", { length: 100 }),

    classificationStatus: varchar("classification_status", { length: 30 }).default(
      "classified",
    ),
    appliedRule: varchar("applied_rule", { length: 200 }),
    classificationReason: text("classification_reason"),
    conflicts: text("conflicts"),

    spend: numeric("spend", { precision: 12, scale: 2 }).default("0"),
    impressions: integer("impressions").default(0),
    reach: integer("reach").default(0),
    linkClicks: integer("link_clicks").default(0),
    landingPageViews: integer("landing_page_views").default(0),
    leads: integer("leads").default(0),
    purchases: integer("purchases").default(0),
    purchaseValue: numeric("purchase_value", { precision: 12, scale: 2 }).default("0"),
    videoViews3s: integer("video_views_3s").default(0),

    classifiedAt: timestamp("classified_at", { withTimezone: true }).defaultNow(),
    effectiveStatus: varchar("effective_status", { length: 30 }),
  },
  (t) => [
    unique("uq_classified_date_ad").on(t.date, t.adId),
    index("idx_classified_account").on(t.accountId),
    index("idx_classified_adname").on(t.adName),
    index("idx_classified_adname_campaign").on(t.adName, t.campaignId),
    index("idx_classified_adname_campaign_adset").on(t.adName, t.campaignId, t.adsetId),
    index("idx_classified_date_account").on(t.date, t.accountId, t.phase),
    // idx_classified_date_adsetname tem DESC — Drizzle aceita via .desc() na
    // sintaxe estendida; aqui simplifico para idx ascendente (menor diff vs.
    // origem). Replanejar se necessário.
    index("idx_classified_date_adsetname").on(t.date, t.adsetName),
    index("idx_classified_date_campaign").on(t.date, t.campaignId),
    index("idx_classified_date_phase").on(t.date, t.phase),
    index("idx_classified_effective_status").on(t.effectiveStatus),
    index("idx_classified_launch_phase").on(t.launch, t.phase),
    index("idx_classified_phase").on(t.phase),
    index("idx_classified_phase_date_account").on(t.phase, t.date, t.accountId),
    index("idx_classified_temperature").on(t.temperature),
  ],
);
