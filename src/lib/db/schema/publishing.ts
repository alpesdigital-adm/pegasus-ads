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

// NOTA: As tabelas da Staging Queue v1.5 (publication_batches, publication_steps,
// step_dependencies, step_events) NÃO entram nesta PR — o documento v1.5 não
// está no repo e especificação de colunas é incompleta. Ficam como TD-007 para
// quando o plano v1.5 for finalizado, antes ou durante a Fase 6.
