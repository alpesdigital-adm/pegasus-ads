import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { campaigns } from "./campaigns";
import { creatives } from "./creatives";

// ─── test_rounds ──────────────────────────────────────────────────────────
// Rodada de teste A/B — um control + N variantes, isolando UMA variável.
// Fluxo: draft → generating → reviewing → publishing → live → analyzing → decided.
// RLS via workspace_id.
export const testRounds = pgTable("test_rounds", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  controlCreativeId: uuid("control_creative_id")
    .notNull()
    .references(() => creatives.id),
  variableType: text("variable_type").notNull(),
  variableValue: text("variable_value"),
  roundNumber: integer("round_number").notNull().default(1),
  status: text("status").default("draft"),
  // draft|generating|reviewing|publishing|live|analyzing|decided|failed
  aiPromptUsed: text("ai_prompt_used"),
  aiVerification: jsonb("ai_verification").default({}),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decision: text("decision"), // winner|loser|inconclusive
  decisionReason: text("decision_reason"),
  // Marca quando o round virou 'live' (batch terminou com ads ativos na Meta).
  // Adicionado em migration 0011. Nullable — rounds em draft/reviewing/failed
  // nunca publicam. Distinto de updatedAt (toda transição) e decidedAt (decisão
  // de winner/loser).
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── test_round_variants ──────────────────────────────────────────────────
// Variantes de uma rodada (incluindo o control duplicado como referência).
// RLS enforced via JOIN em test_rounds (tabela NÃO tem workspace_id próprio).
// Nota: para simplificar policy RLS, avaliar adicionar workspace_id redundante
// quando a política for escrita (similar ao que foi feito em creative_edges).
export const testRoundVariants = pgTable("test_round_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  testRoundId: uuid("test_round_id")
    .notNull()
    .references(() => testRounds.id),
  creativeId: uuid("creative_id")
    .notNull()
    .references(() => creatives.id),
  role: text("role").notNull().default("variant"), // control|variant
  placement: text("placement"), // feed|stories|both
  // IDs externos Meta
  metaAdId: text("meta_ad_id"),
  metaAdsetId: text("meta_adset_id"),
  metaCreativeId: text("meta_creative_id"),
  status: text("status").default("pending"),
  // pending|generated|verified|published|live|paused|killed
  verificationResult: jsonb("verification_result").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
