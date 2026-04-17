import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { creatives } from "./creatives";

// ─── prompts ──────────────────────────────────────────────────────────────
// Histórico de prompts de geração (audit trail + debugging).
// NOTA: hoje NÃO tem workspace_id — avaliar adicionar na Fase 5 (o creative
// referenciado já tem, então RLS pode ser via JOIN se necessário).
export const prompts = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  creativeId: uuid("creative_id").references(() => creatives.id),
  promptText: text("prompt_text").notNull(),
  promptFormat: text("prompt_format").default("text"), // text|json|markdown
  model: text("model"),
  referenceImageIds: jsonb("reference_image_ids").default([]),
  responseRaw: text("response_raw"),
  tokensUsed: integer("tokens_used"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── settings (LEGADO global) ─────────────────────────────────────────────
// Settings globais fora de workspace. Migrar para workspace_settings na Fase 5
// (TD-005). NÃO tem workspace_id — NÃO entra no RLS.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
