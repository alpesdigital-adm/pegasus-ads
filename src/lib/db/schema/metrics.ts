import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  doublePrecision,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { creatives } from "./creatives";

// ─── metrics ──────────────────────────────────────────────────────────────
// Métricas diárias agregadas por creative (spend/impressions/cpl/etc).
// RLS via workspace_id. Unique (creative_id, date).
// Nota: `date` é TEXT (formato YYYY-MM-DD) por compatibilidade com a API Meta
// — não uso `date()` do Postgres para evitar timezone edge cases.
export const metrics = pgTable(
  "metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    creativeId: uuid("creative_id")
      .notNull()
      .references(() => creatives.id),
    date: text("date").notNull(),
    spend: doublePrecision("spend").default(0),
    impressions: integer("impressions").default(0),
    cpm: doublePrecision("cpm").default(0),
    ctr: doublePrecision("ctr").default(0),
    clicks: integer("clicks").default(0),
    cpc: doublePrecision("cpc").default(0),
    leads: integer("leads").default(0),
    cpl: doublePrecision("cpl"),
    metaAdId: text("meta_ad_id"),
    landingPageViews: integer("landing_page_views").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_metrics_creative_date").on(t.creativeId, t.date)],
);

// ─── metrics_breakdowns ──────────────────────────────────────────────────
// Métricas por posicionamento (publisher_platform × platform_position).
// Unique (creative_id, date, publisher_platform, platform_position).
export const metricsBreakdowns = pgTable(
  "metrics_breakdowns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    creativeId: uuid("creative_id")
      .notNull()
      .references(() => creatives.id),
    date: text("date").notNull(),
    publisherPlatform: text("publisher_platform").notNull().default(""),
    platformPosition: text("platform_position").notNull().default(""),
    spend: doublePrecision("spend").default(0),
    impressions: integer("impressions").default(0),
    cpm: doublePrecision("cpm").default(0),
    ctr: doublePrecision("ctr").default(0),
    clicks: integer("clicks").default(0),
    cpc: doublePrecision("cpc").default(0),
    leads: integer("leads").default(0),
    cpl: doublePrecision("cpl"),
    metaAdId: text("meta_ad_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("uq_metrics_bd").on(t.creativeId, t.date, t.publisherPlatform, t.platformPosition),
  ],
);

// ─── metrics_demographics ─────────────────────────────────────────────────
// Métricas por demografia (age × gender).
// Unique (creative_id, date, age, gender).
export const metricsDemographics = pgTable(
  "metrics_demographics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    creativeId: uuid("creative_id")
      .notNull()
      .references(() => creatives.id),
    date: text("date").notNull(),
    age: text("age").notNull().default(""),
    gender: text("gender").notNull().default(""),
    spend: doublePrecision("spend").default(0),
    impressions: integer("impressions").default(0),
    cpm: doublePrecision("cpm").default(0),
    ctr: doublePrecision("ctr").default(0),
    clicks: integer("clicks").default(0),
    cpc: doublePrecision("cpc").default(0),
    leads: integer("leads").default(0),
    cpl: doublePrecision("cpl"),
    metaAdId: text("meta_ad_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_metrics_demo").on(t.creativeId, t.date, t.age, t.gender)],
);
