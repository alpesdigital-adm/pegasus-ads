// =============================================================================
// Creative Intelligence (TD-008)
// =============================================================================
// 5 tabelas criadas no Neon em 2026-04-12 FORA do initDb() — extraídas pelo
// gêmeo VPS na Fase 1B (docs/migration/fase1b-ci-schemas.md).
//
// Mudanças vs. Neon original:
// - PKs: integer + sequence → uuid (gen_random_uuid()) per plano v1.4
// - workspace_id: text → uuid per plano v1.4
// - FKs entre essas 5 tabelas continuam (ON DELETE conforme original)
//
// Hierarquia: offers → concepts → angles → ad_creatives (+ launches separado)
// =============================================================================

import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  unique,
  index,
  bigint,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

// ─── offers ──────────────────────────────────────────────────────────────
// Iscas/produtos vendidos (lead_magnet | paid_product | tripwire | etc).
// Unique (workspace_id, key). RLS via workspace_id.
export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    offerType: text("offer_type").notNull().default("lead_magnet"),
    description: text("description"),
    cplTarget: numeric("cpl_target", { precision: 10, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_offers_workspace_key").on(t.workspaceId, t.key)],
);

// ─── concepts ────────────────────────────────────────────────────────────
// Tema estratégico (C1 Gap Técnico, C2 Transição, etc). Pertence a uma offer.
// Unique (offer_id, code). RLS herda da offer (sem workspace_id direto).
// CASCADE: deletar offer apaga concepts associados (semântica do Neon original).
export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_concepts_offer_code").on(t.offerId, t.code)],
);

// ─── angles ──────────────────────────────────────────────────────────────
// Abordagem emocional (A Formação, B Erro Silencioso, etc). Pertence a um
// concept. CASCADE igual a concepts.
export const angles = pgTable(
  "angles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    motor: text("motor"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_angles_concept_code").on(t.conceptId, t.code)],
);

// ─── launches ────────────────────────────────────────────────────────────
// Turma/cohort (T4, T7, etc). Multi-tenant via workspace_id.
// Unique (workspace_id, key). starts_at/ends_at são DATE (não timestamptz).
export const launches = pgTable(
  "launches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    startsAt: date("starts_at"),
    endsAt: date("ends_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_launches_workspace_key").on(t.workspaceId, t.key)],
);

// ─── ad_creatives ────────────────────────────────────────────────────────
// Mapeamento criativo→hierarquia (offer/launch/angle). NÃO é a tabela
// `creatives` (essa é IA image gen). Renomeada explicitamente em 2026-04-12
// para evitar conflito de nome.
//
// FKs: NO ACTION (não cascade) — preserva criativo se offer/launch/angle for
// removido. angle_id é NULLABLE (Pre-Conceito não tem angle).
//
// Unique (workspace_id, ad_name) — ad_name é a chave de attribution UTM.
//
// meta_creative_id é BIGINT (ID numérico da Meta, não UUID).
export const adCreatives = pgTable(
  "ad_creatives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    offerId: uuid("offer_id")
      .notNull()
      .references((): AnyPgColumn => offers.id),
    launchId: uuid("launch_id")
      .notNull()
      .references((): AnyPgColumn => launches.id),
    angleId: uuid("angle_id").references((): AnyPgColumn => angles.id),
    adName: text("ad_name").notNull(),
    format: text("format").notNull(),
    placement: text("placement"),
    variant: text("variant"),
    hook: text("hook"),
    motor: text("motor"),
    conceptLabel: text("concept_label"),
    status: text("status").notNull().default("active"),
    imageUrl: text("image_url"),
    videoUrl: text("video_url"),
    metaCreativeId: bigint("meta_creative_id", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("uq_ad_creatives_workspace_adname").on(t.workspaceId, t.adName),
    index("idx_ad_creatives_ad_name").on(t.adName),
    index("idx_ad_creatives_offer_id").on(t.offerId),
    index("idx_ad_creatives_launch_id").on(t.launchId),
    index("idx_ad_creatives_angle_id").on(t.angleId),
  ],
);
