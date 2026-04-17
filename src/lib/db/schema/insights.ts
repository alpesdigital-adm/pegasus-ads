// =============================================================================
// Insights — ad_insights, hourly_insights, sync_logs
// =============================================================================
// Dados de sync da Meta Marketing API. Armazenados em GLOBAL (não RLS-isolated),
// acessados por crons via dbAdmin.
//
// - ad_insights: daily aggregate por ad (insights brutos)
// - hourly_insights: mesmo grão mas hourly (mais volumoso, 25k+ rows)
// - sync_logs: audit trail dos jobs de sync
// =============================================================================

import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  integer,
  numeric,
  varchar,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { adAccounts } from "./ad-accounts";

// ─── ad_insights ─────────────────────────────────────────────────────────
// Insights diários brutos da Meta Marketing API.
// Conversão: id serial → uuid, account_id int → uuid (FK ad_accounts).
// UNIQUE (date, ad_id) preserva deduplicação por dia/ad.
export const adInsights = pgTable(
  "ad_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").references(() => adAccounts.id),
    date: date("date").notNull(),
    campaignId: varchar("campaign_id", { length: 50 }).notNull(),
    campaignName: varchar("campaign_name", { length: 500 }),
    adsetId: varchar("adset_id", { length: 50 }).notNull(),
    adsetName: varchar("adset_name", { length: 500 }),
    adId: varchar("ad_id", { length: 50 }).notNull(),
    adName: varchar("ad_name", { length: 500 }),

    spend: numeric("spend", { precision: 12, scale: 2 }).default("0"),
    impressions: integer("impressions").default(0),
    reach: integer("reach").default(0),
    linkClicks: integer("link_clicks").default(0),
    landingPageViews: integer("landing_page_views").default(0),
    leads: integer("leads").default(0),
    addToWishlist: integer("add_to_wishlist").default(0),
    addToCart: integer("add_to_cart").default(0),
    initiateCheckout: integer("initiate_checkout").default(0),
    purchases: integer("purchases").default(0),
    purchaseValue: numeric("purchase_value", { precision: 12, scale: 2 }).default("0"),

    videoViews3s: integer("video_views_3s").default(0),
    videoViews25: integer("video_views_25").default(0),
    videoViews50: integer("video_views_50").default(0),
    videoViews75: integer("video_views_75").default(0),
    videoViews95: integer("video_views_95").default(0),

    profileVisits: integer("profile_visits").default(0),
    newFollowers: integer("new_followers").default(0),
    comments: integer("comments").default(0),
    reactions: integer("reactions").default(0),
    shares: integer("shares").default(0),
    saves: integer("saves").default(0),

    conversationsStarted: integer("conversations_started").default(0),
    messagesReceived: integer("messages_received").default(0),

    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("uq_ad_insights_date_ad").on(t.date, t.adId),
    index("idx_ad_insights_account_date").on(t.accountId, t.date),
    index("idx_ad_insights_campaign").on(t.campaignId),
    index("idx_ad_insights_date").on(t.date),
  ],
);

// ─── hourly_insights (25k+ rows — maior tabela do sistema) ──────────────
// Insights granularidade hourly. Usado para análise de performance intraday.
export const hourlyInsights = pgTable(
  "hourly_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").references(() => adAccounts.id),
    date: date("date").notNull(),
    hour: integer("hour").notNull(),
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

    spend: numeric("spend", { precision: 12, scale: 2 }).default("0"),
    impressions: integer("impressions").default(0),
    reach: integer("reach").default(0),
    linkClicks: integer("link_clicks").default(0),
    landingPageViews: integer("landing_page_views").default(0),
    leads: integer("leads").default(0),
    purchases: integer("purchases").default(0),
    purchaseValue: numeric("purchase_value", { precision: 12, scale: 2 }).default("0"),
    videoViews3s: integer("video_views_3s").default(0),

    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("uq_hourly_insights_date_hour_ad").on(t.date, t.hour, t.adId),
    index("idx_hourly_insights_date").on(t.date),
    index("idx_hourly_insights_date_hour").on(t.date, t.hour),
    index("idx_hourly_insights_date_phase").on(t.date, t.phase),
    index("idx_hourly_insights_phase").on(t.phase),
  ],
);

// ─── sync_logs ───────────────────────────────────────────────────────────
// Audit trail de jobs de sync (sync-all, collect, etc).
export const syncLogs = pgTable("sync_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").references(() => adAccounts.id),
  jobType: varchar("job_type", { length: 50 }).notNull(),
  dateFrom: date("date_from").notNull(),
  dateTo: date("date_to").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  rowsSynced: integer("rows_synced").default(0),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
