// =============================================================================
// projects + crm_import_mappings — multi-tenant extras
// =============================================================================
// Tabelas com workspace_id mas que não estavam no initDb(). RLS-isoladas.
// =============================================================================

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  varchar,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

// ─── projects (1 row) ────────────────────────────────────────────────────
// Agrupa campanhas por projeto dentro de um workspace (ex: RAT T7).
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    campaignFilter: text("campaign_filter").notNull().default(""),
    description: text("description").default(""),
    status: text("status").default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_projects_workspace").on(t.workspaceId)],
);

// ─── crm_import_mappings (0 rows) ───────────────────────────────────────
// Salvou mappings de coluna CSV → campo CRM para reutilização.
export const crmImportMappings = pgTable(
  "crm_import_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    columnMappings: jsonb("column_mappings").notNull().default({}),
    targetFields: jsonb("target_fields").notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    importCount: integer("import_count").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("uq_crm_import_mappings_ws_name").on(t.workspaceId, t.name),
    index("idx_crm_import_mappings_workspace").on(t.workspaceId),
  ],
);
