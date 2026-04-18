import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── workspaces ───────────────────────────────────────────────────────────
// Tenant raiz. Toda tabela multi-tenant aponta para workspaces.id.
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    plan: text("plan").default("free").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check("workspaces_plan_check", sql`${t.plan} IN ('free', 'pro', 'enterprise')`)],
);

// ─── plans ────────────────────────────────────────────────────────────────
// Dados globais (seed). NÃO tem workspace_id, NÃO entra no RLS.
export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  maxCreatives: integer("max_creatives").notNull().default(50),
  maxCampaigns: integer("max_campaigns").notNull().default(3),
  maxMetaAccounts: integer("max_meta_accounts").notNull().default(1),
  maxMembers: integer("max_members").notNull().default(1),
  maxApiKeys: integer("max_api_keys").notNull().default(2),
  aiGenerationsPerMonth: integer("ai_generations_per_month").notNull().default(20),
  features: jsonb("features").notNull().default({}),
  priceCents: integer("price_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── workspace_members ────────────────────────────────────────────────────
// FK user_id aponta para auth.users do Supabase (Fase 2). Durante Fase 1, ainda
// aponta para a tabela `users` legada — o ALTER para auth.users acontece na
// Fase 2 e é feito manualmente via SQL (não via Drizzle diff).
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check("workspace_members_role_check", sql`${t.role} IN ('owner', 'admin', 'member')`),
  ],
);

// ─── workspace_settings ───────────────────────────────────────────────────
// Config multi-tenant (chave-valor por workspace). RLS-enabled.
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);
