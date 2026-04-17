import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

// ─── images ───────────────────────────────────────────────────────────────
// Banco de imagens (referências, brand, produto, Dra. Priscila).
// RLS via workspace_id — era nullable no legado, mantido nullable para
// compatibilidade. Crons que precisam cross-workspace usam dbAdmin.
export const images = pgTable("images", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  name: text("name").notNull(),
  category: text("category").notNull(), // 'dra-priscila' | 'marca' | 'produto' | 'referencia'
  blobUrl: text("blob_url").notNull(), // Vercel Blob atual → Supabase Storage na Fase 5
  thumbnailUrl: text("thumbnail_url"),
  width: integer("width"),
  height: integer("height"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── creatives ────────────────────────────────────────────────────────────
// Criativo de ad (imagem gerada ou importada). RLS via workspace_id.
// parent_id → self-reference (variações/iterações).
export const creatives = pgTable("creatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  name: text("name").notNull(),
  blobUrl: text("blob_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  prompt: text("prompt"),
  promptJson: text("prompt_json"),
  model: text("model").default("gemini-2.5-flash-image"),
  width: integer("width"),
  height: integer("height"),
  parentId: uuid("parent_id").references((): AnyPgColumn => creatives.id),
  generation: integer("generation").default(0),
  status: text("status").default("generated"), // generated|testing|winner|killed|paused
  metadata: jsonb("metadata").default({}),
  // Colunas adicionadas historicamente via ALTER TABLE — já consolidadas aqui
  isControl: boolean("is_control").default(false),
  funnelKey: text("funnel_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── creative_edges ───────────────────────────────────────────────────────
// Grafo de relacionamento entre creatives (variation / iteration / style-transfer / remix).
// Adicionado workspace_id REDUNDANTE para simplificar policy RLS (plano 5.4 ¹).
export const creativeEdges = pgTable("creative_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => creatives.id),
  targetId: uuid("target_id")
    .notNull()
    .references(() => creatives.id),
  relationship: text("relationship").default("variation"), // variation|iteration|style-transfer|remix
  variableIsolated: text("variable_isolated"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── creative_ref_images ──────────────────────────────────────────────────
// Imagens de referência de um creative (style-transfer, character, etc.).
// Adicionado workspace_id REDUNDANTE para simplificar policy RLS (plano 5.4 ¹).
export const creativeRefImages = pgTable("creative_ref_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  creativeId: uuid("creative_id")
    .notNull()
    .references(() => creatives.id),
  imageId: uuid("image_id")
    .notNull()
    .references(() => images.id),
  role: text("role").default("reference"), // reference|style|character|composition
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
