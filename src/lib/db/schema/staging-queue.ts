// Staging Queue v2 — orquestração assíncrona de publicação Meta Ads.
// Spec completa em docs/staging-queue-v2.md (TD-007, 1994 linhas).
//
// 4 tabelas + 2 enums. O worker (src/lib/staging-queue/worker.ts) acquire
// batches via SELECT ... FOR UPDATE SKIP LOCKED ordenado por (status,
// priority, created_at) e executa steps respeitando o DAG (step_dependencies).
//
// RLS:
//  - publication_batches.workspace_id → direto
//  - publication_steps.workspace_id → direto (denorm pra evitar join)
//  - step_events.workspace_id → DENORMALIZADO (não estava no spec original).
//    Motivo: o canal Realtime `events-{batchId}` do frontend precisa que o
//    postgres_changes respeite RLS por workspace. Se RLS fosse via EXISTS
//    subquery, o Realtime perde performance. Redundância mínima em troca
//    de RLS trivial + Realtime funcional (casa de tijolos).
//  - step_dependencies → SEM RLS. Acesso só via dbAdmin/worker; frontend
//    não lê diretamente (apenas derivação do grafo server-side).

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces";

// ─── enums ────────────────────────────────────────────────────────────────

export const batchStatusEnum = pgEnum("batch_status", [
  "scheduled",        // Agendado pra execução futura (scheduled_at > NOW())
  "pending",          // Criado, aguardando worker acquire
  "running",          // Worker processando steps
  "paused",           // Pausado manualmente (entre steps)
  "partial_success",  // Alguns steps succeeded + outros failed (após max retries)
  "succeeded",        // Todos os steps succeeded
  "failed",           // Step crítico falhou após max retries
  "cancelled",        // Cancelado pelo usuário
]);

export const stepStatusEnum = pgEnum("step_status", [
  "pending",           // Aguardando deps serem satisfeitas
  "ready",             // Deps OK, pronto pra executar
  "running",           // Handler em execução
  "succeeded",         // Concluído com sucesso
  "retryable_failed",  // Falhou, será retentado (attempts < maxAttempts)
  "failed",            // Falha definitiva (attempts >= maxAttempts) ou não-retryable
  "skipped",           // Dep falhou + step é não-crítico
  "cancelled",         // Cancelado junto com o batch
]);

// ─── publication_batches ──────────────────────────────────────────────────
// Orquestração em nível de publicação. State machine em docs §5.1.
export const publicationBatches = pgTable(
  "publication_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    // Tipo do batch (determina quais steps são criados pelo factory)
    batchType: text("batch_type", {
      enum: [
        "test_round_publish",
        "publish_to_adsets",
        "publish_carousel",
        "publish_videos",
        "publish_external",
        "import_campaigns",
      ],
    }).notNull(),

    status: batchStatusEnum("status").default("pending").notNull(),

    // Menor = mais urgente. Publicação=10, import=50.
    priority: integer("priority").default(10).notNull(),

    // 'after_all' (default) → cria ads PAUSED, ativa em lote no final.
    // 'immediate' → cria ACTIVE (legacy, reposição urgente).
    activationMode: text("activation_mode", {
      enum: ["after_all", "immediate"],
    })
      .default("after_all")
      .notNull(),

    // Input original da request (usado pra replay/debug)
    inputData: jsonb("input_data").default({}).notNull(),

    // Resultado agregado (preenchido na conclusão)
    outputData: jsonb("output_data").default({}),

    // Contexto de negócio opcional
    testRoundId: uuid("test_round_id"),
    importJobId: uuid("import_job_id"),

    // Contadores atualizados pelo worker a cada step
    stepsTotal: integer("steps_total").default(0).notNull(),
    stepsSucceeded: integer("steps_succeeded").default(0).notNull(),
    stepsFailed: integer("steps_failed").default(0).notNull(),
    stepsSkipped: integer("steps_skipped").default(0).notNull(),

    // Agendamento: se preenchido e status='scheduled', worker ignora até
    // scheduled_at <= NOW().
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    estimatedCompletionAt: timestamp("estimated_completion_at", {
      withTimezone: true,
    }),

    errorMessage: text("error_message"),
    errorContext: jsonb("error_context"),

    // Lock cooperativo. lockedBy = hostname/pid do worker; lockedAt expira 5min.
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
  },
  (t) => ({
    // Worker acquire — SKIP LOCKED sobre (status, priority, created_at)
    statusPriorityCreated: index("idx_pb_status_priority_created").on(
      t.status,
      t.priority,
      t.createdAt,
    ),
    // API list per-workspace
    workspaceStatus: index("idx_pb_workspace_status").on(
      t.workspaceId,
      t.status,
    ),
  }),
);

// ─── publication_steps ────────────────────────────────────────────────────
// Unidade atômica retryable. State machine em docs §5.2.
export const publicationSteps = pgTable(
  "publication_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => publicationBatches.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    // Determina qual handler de src/lib/staging-queue/handlers.ts executa.
    stepType: text("step_type", {
      enum: [
        // Upload
        "upload_image",
        "upload_video",
        // Labels
        "create_ad_label",
        // Creative
        "create_creative",
        "create_carousel_creative",
        // Ad Set
        "create_adset",
        "clone_adset",
        // Ad
        "create_ad",
        // Verificação
        "verify_pre_publish",
        "verify_post_publish",
        // Contexto
        "load_context",
        "resolve_model_ad",
        "list_adsets",
        "download_drive_files",
        // Ativação (modo after_all)
        "activate_ads",
        // Persistência
        "persist_results",
        // Import (Fase 6)
        "import_structure",
        "import_image",
        "import_video",
        "import_insights",
      ],
    }).notNull(),

    // Posição pra ordenação visual (não afeta execução; essa é governada pelo DAG)
    ordinal: integer("ordinal").default(0).notNull(),

    status: stepStatusEnum("status").default("pending").notNull(),

    // Crítico=true: se falhar, batch → failed.
    // Crítico=false: dependentes viram skipped, batch continua → partial_success.
    isCritical: text("is_critical", { enum: ["true", "false"] })
      .default("true")
      .notNull(),

    inputData: jsonb("input_data").default({}).notNull(),
    outputData: jsonb("output_data").default({}),

    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    lastError: text("last_error"),
    // ex: META_RATE_LIMIT, META_VALIDATION, NETWORK, META_DUPLICATE
    lastErrorCode: text("last_error_code"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),

    // Idempotência: se handler já criou entity na Meta, ID mora aqui.
    // Retry verifica via GET antes de POST novo.
    metaEntityId: text("meta_entity_id"),
    metaEntityType: text("meta_entity_type"), // image|creative|adset|ad|label|video

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => ({
    // Worker — resolveReadySteps
    batchStatus: index("idx_ps_batch_status").on(t.batchId, t.status),
    // activate_ads lista create_ad steps do batch
    batchStepType: index("idx_ps_batch_step_type").on(t.batchId, t.stepType),
    // Promoção retryable_failed → ready quando nextRetryAt <= NOW()
    statusNextRetry: index("idx_ps_status_next_retry")
      .on(t.status, t.nextRetryAt)
      .where(sql`next_retry_at IS NOT NULL`),
  }),
);

// ─── step_dependencies ────────────────────────────────────────────────────
// DAG: step depende de dependsOnStepId. outputKey/inputKey propagam dados.
// Sem RLS — só worker/admin acessa; frontend não lê direto.
export const stepDependencies = pgTable(
  "step_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id")
      .notNull()
      .references(() => publicationSteps.id, { onDelete: "cascade" }),
    dependsOnStepId: uuid("depends_on_step_id")
      .notNull()
      .references(() => publicationSteps.id, { onDelete: "cascade" }),

    // Ex: upload produz 'imageHash' (outputKey) → create_creative consome
    // em 'imageHash' (inputKey). Worker faz jsonb_set no input_data após
    // dep suceder.
    outputKey: text("output_key"),
    inputKey: text("input_key"),
  },
  (t) => ({
    step: index("idx_sd_step").on(t.stepId),
    dependsOn: index("idx_sd_depends_on").on(t.dependsOnStepId),
    // Evita duplicata da mesma aresta
    unique: uniqueIndex("uq_sd_step_depends_on").on(
      t.stepId,
      t.dependsOnStepId,
    ),
  }),
);

// ─── step_events ──────────────────────────────────────────────────────────
// Log append-only. Toda transição de status emite 1 row. Progresso intra-step
// (ex: upload_video em chunks) usa metadata.percent, throttled a cada 5%
// ou 5s pra não explodir rows.
export const stepEvents = pgTable(
  "step_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id")
      .notNull()
      .references(() => publicationSteps.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => publicationBatches.id, { onDelete: "cascade" }),
    // Denormalizado pra RLS trivial em Realtime (ver header do arquivo).
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    // 'pending'|'ready'|'running'|'succeeded'|'retryable_failed'|'failed'|'skipped'|'cancelled'|'progress'
    // 'progress' é evento intra-step, não transição de state machine
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),

    message: text("message"),
    // Ex pra progress: { percent: 45, bytesUploaded: 104857600, totalBytes: 233017344 }
    metadata: jsonb("metadata").default({}),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    batchCreated: index("idx_se_batch_created").on(t.batchId, t.createdAt),
    step: index("idx_se_step").on(t.stepId),
  }),
);
