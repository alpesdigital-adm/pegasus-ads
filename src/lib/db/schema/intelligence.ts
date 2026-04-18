import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  doublePrecision,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { creatives } from "./creatives";

// ─── visual_elements ──────────────────────────────────────────────────────
// Galeria de elementos visuais por dimensão (hero, ebook, copy, palette, etc).
// Usado pelo gerador para manter consistência de marca.
// Unique (code, funnel_key). RLS via workspace_id.
export const visualElements = pgTable(
  "visual_elements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    code: text("code").notNull(),
    dimension: text("dimension").notNull(), // hero|ebook|copy|palette|style|layout
    name: text("name").notNull(),
    description: text("description"),
    activeInMeta: boolean("active_in_meta").default(false),
    priority: integer("priority").default(5),
    funnelKey: text("funnel_key"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_visual_elements_code_funnel").on(t.code, t.funnelKey)],
);

// ─── hypotheses ───────────────────────────────────────────────────────────
// Hipóteses de teste (geradas por IA ou manualmente) — candidatas a virar
// test_round. RLS via workspace_id.
export const hypotheses = pgTable("hypotheses", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  campaignKey: text("campaign_key").notNull(),
  variableDimension: text("variable_dimension").notNull(),
  variableCode: text("variable_code"),
  hypothesis: text("hypothesis").notNull(),
  rationale: text("rationale"),
  priority: integer("priority").default(5),
  status: text("status").default("pending"), // pending|in_test|validated|discarded
  sourceCreativeIds: jsonb("source_creative_ids").default([]),
  aiModel: text("ai_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── templates ────────────────────────────────────────────────────────────
// Template library de padrões visuais validados (tarefa 4.4).
// Originalmente criado via CREATE TABLE IF NOT EXISTS na rota. Adicionado
// aos schemas Drizzle na Fase 1C Wave 4 + migration 0005.
// RLS via workspace_id.
export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  name: text("name").notNull(),
  description: text("description"),
  funnelKey: text("funnel_key").notNull(),
  sourceCreativeId: uuid("source_creative_id").references(() => creatives.id, {
    onDelete: "set null",
  }),
  dimensions: jsonb("dimensions").notNull().default({}),
  promptFragment: text("prompt_fragment"),
  cplValidated: doublePrecision("cpl_validated"),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── alerts ───────────────────────────────────────────────────────────────
// Alertas de anomalia (kill rules, CPL spike, etc). RLS via workspace_id.
export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  creativeId: uuid("creative_id").references(() => creatives.id),
  campaignKey: text("campaign_key"),
  date: text("date").notNull(),
  level: text("level").notNull(),
  ruleName: text("rule_name"),
  message: text("message").notNull(),
  spend: doublePrecision("spend"),
  cpl: doublePrecision("cpl"),
  cplTarget: doublePrecision("cpl_target"),
  resolved: boolean("resolved").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
