// =============================================================================
// Misc — classification_rules, saved_views
// =============================================================================
// Tabelas globais sem workspace_id (não RLS-isoladas). Acessadas via dbAdmin.
// =============================================================================

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  varchar,
} from "drizzle-orm/pg-core";

// ─── classification_rules (0 rows) ──────────────────────────────────────
// Regras de classificação de insights por dimensão (launch, phase, etc).
// Global — compartilhado entre workspaces.
export const classificationRules = pgTable("classification_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").default(1),
  dimension: varchar("dimension", { length: 50 }).notNull(),
  sourceField: varchar("source_field", { length: 30 }).notNull(),
  pattern: text("pattern").notNull(),
  value: varchar("value", { length: 100 }).notNull(),
  priority: integer("priority").default(100),
  isActive: boolean("is_active").default(true),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── saved_views (0 rows) ───────────────────────────────────────────────
// Views salvas de dashboard/insights. created_by é string livre (não FK).
export const savedViews = pgTable("saved_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  filtersJson: text("filters_json").notNull(),
  pathname: varchar("pathname", { length: 255 }).default("/dashboard"),
  isShared: boolean("is_shared").default(false),
  createdBy: varchar("created_by", { length: 255 }).default("default"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
