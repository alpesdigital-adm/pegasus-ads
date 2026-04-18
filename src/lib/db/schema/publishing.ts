import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { creatives } from "./creatives";
import { testRoundVariants } from "./testing";

// ─── published_ads ────────────────────────────────────────────────────────
// Ads publicados na Meta — rastreio completo do que está rodando.
// RLS via workspace_id.
export const publishedAds = pgTable("published_ads", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => testRoundVariants.id),
  creativeId: uuid("creative_id")
    .notNull()
    .references(() => creatives.id),
  // IDs externos Meta (TEXT, não UUID)
  metaAdId: text("meta_ad_id").notNull(),
  metaAdsetId: text("meta_adset_id").notNull(),
  metaCreativeId: text("meta_creative_id").notNull(),
  metaImageHash: text("meta_image_hash"),
  adName: text("ad_name").notNull(),
  adsetName: text("adset_name").notNull(),
  placement: text("placement").notNull(), // feed|stories
  status: text("status").default("pending_review"),
  // pending_review|active|paused|rejected|deleted
  driveFileId: text("drive_file_id"),
  driveFileName: text("drive_file_name"),
  publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Staging Queue v2 (TD-007) vive em ./staging-queue.ts — 4 tabelas
// (publication_batches, publication_steps, step_dependencies, step_events)
// + 2 enums. Spec completa em docs/staging-queue-v2.md. Adicionada em
// 2026-04-18 (migration 0010).
