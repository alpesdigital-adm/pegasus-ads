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

// Tabela `settings` global foi removida na migration 0009 (TD-005).
// Use `workspace_settings` (em schema/workspaces.ts) pra config per-workspace.
