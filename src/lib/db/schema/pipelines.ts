import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { testRounds } from "./testing";

// ─── pipeline_executions ──────────────────────────────────────────────────
// Execução de pipeline (generate / publish / analyze / kill). Registra steps
// como JSONB + tempo total. RLS via workspace_id.
// test_round_id é NULLABLE — pipelines podem rodar sem test_round associado.
export const pipelineExecutions = pgTable("pipeline_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  testRoundId: uuid("test_round_id").references(() => testRounds.id),
  pipelineType: text("pipeline_type").notNull(), // generate|publish|analyze|kill
  status: text("status").default("running"), // running|completed|failed|cancelled
  inputData: jsonb("input_data").default({}),
  outputData: jsonb("output_data").default({}),
  errorMessage: text("error_message"),
  steps: jsonb("steps").default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
});
