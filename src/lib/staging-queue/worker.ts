// Worker da Staging Queue v2.
// Spec: docs/staging-queue-v2.md §6 + §7.
//
// Padrão: cron HTTP (POST /api/cron/process-queue) invoca processQueueTick()
// a cada 60s. Um tick processa no máximo 1 batch até o fim (ou até pause/
// cancel/esgotar ready steps). MVP é sequencial dentro do batch — paralelismo
// entre batches vem gratuitamente de múltiplas invocações simultâneas do cron
// (SKIP LOCKED garante não pegarem o mesmo).
//
// Multi-tenancy: dbAdmin (BYPASSRLS) + filtro manual de workspace em queries
// que retornam dados (pattern CRM validado, spec §7). Writes no worker não
// passam por RLS intencionalmente — orquestração é cross-workspace por design.

import { dbAdmin } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import {
  publicationBatches,
  publicationSteps,
  stepDependencies,
  testRounds,
} from "@/lib/db/schema";
import {
  calculateNextRetry,
  classifyError,
  isNonRetryable,
} from "./errors";
import { emitEvent } from "./events";
import { getStepHandler, isMetaApiStep } from "./handlers";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "staging-queue/worker" });

const LOCK_TIMEOUT_MINUTES = 5;
const META_RATE_LIMIT_MS = 2000;

// ─── Promoção de batches scheduled → pending ──────────────────────────────

export async function promoteScheduledBatches(): Promise<number> {
  const rows = await dbAdmin.execute<{ id: string }>(sql`
    UPDATE publication_batches
    SET status = 'pending'
    WHERE status = 'scheduled'
      AND scheduled_at <= NOW()
    RETURNING id
  `);
  return rows.length;
}

// ─── Aquisição de batch (SKIP LOCKED) ─────────────────────────────────────

interface AcquiredBatch {
  id: string;
  workspaceId: string;
}

export async function acquireBatch(): Promise<AcquiredBatch | null> {
  const workerId = `worker-${process.env.HOSTNAME ?? "local"}-${Date.now()}`;

  // Prioriza batches 'running' (continua trabalho) sobre 'pending' (novo).
  // Menor priority = mais urgente. Lock de 5min pra sobreviver a worker crash.
  const rows = await dbAdmin.execute<{ id: string; workspace_id: string }>(sql`
    UPDATE publication_batches
    SET locked_by = ${workerId},
        locked_at = NOW(),
        status = CASE WHEN status = 'pending' THEN 'running'::batch_status ELSE status END,
        started_at = CASE WHEN started_at IS NULL THEN NOW() ELSE started_at END
    WHERE id = (
      SELECT id FROM publication_batches
      WHERE status IN ('pending', 'running')
        AND (locked_by IS NULL OR locked_at < NOW() - INTERVAL '${sql.raw(String(LOCK_TIMEOUT_MINUTES))} minutes')
      ORDER BY
        CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 END,
        priority ASC,
        created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, workspace_id
  `);

  if (rows.length === 0) return null;
  return { id: rows[0].id, workspaceId: rows[0].workspace_id };
}

export async function releaseBatch(batchId: string): Promise<void> {
  await dbAdmin
    .update(publicationBatches)
    .set({ lockedBy: null, lockedAt: null })
    .where(eq(publicationBatches.id, batchId));
}

// ─── DAG resolution ───────────────────────────────────────────────────────

/**
 * Steps ficam 'ready' quando:
 *  - Status atual 'pending' E todas deps em {succeeded, skipped}
 *  - OU root step (sem nenhuma dep)
 * Steps ficam 'skipped' quando:
 *  - Status 'pending' E não-crítico E alguma dep em 'failed'
 * Steps voltam 'ready' quando:
 *  - Status 'retryable_failed' E next_retry_at <= NOW()
 */
export async function resolveReadySteps(batchId: string): Promise<string[]> {
  // 1. retryable_failed → ready (timer expirou)
  await dbAdmin.execute(sql`
    UPDATE publication_steps
    SET status = 'ready', started_at = NULL
    WHERE batch_id = ${batchId}
      AND status = 'retryable_failed'
      AND next_retry_at <= NOW()
  `);

  // 2. pending → ready quando deps satisfeitas (ou root sem deps)
  await dbAdmin.execute(sql`
    UPDATE publication_steps ps
    SET status = 'ready'
    WHERE ps.batch_id = ${batchId}
      AND ps.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM step_dependencies sd
        JOIN publication_steps dep ON dep.id = sd.depends_on_step_id
        WHERE sd.step_id = ps.id
          AND dep.status NOT IN ('succeeded', 'skipped')
      )
  `);

  // 3. pending → skipped (não-crítico com dep falhada)
  await dbAdmin.execute(sql`
    UPDATE publication_steps ps
    SET status = 'skipped'
    WHERE ps.batch_id = ${batchId}
      AND ps.status = 'pending'
      AND ps.is_critical = 'false'
      AND EXISTS (
        SELECT 1 FROM step_dependencies sd
        JOIN publication_steps dep ON dep.id = sd.depends_on_step_id
        WHERE sd.step_id = ps.id
          AND dep.status = 'failed'
      )
  `);

  // 4. Retorna TODOS os steps em 'ready' do batch, não só os que
  // transicionaram neste tick. TD-019: a versão anterior usava RETURNING
  // no UPDATE (2), perdendo os steps que (a) foram promovidos de
  // retryable_failed no passo (1) acima ou (b) já estavam ready de
  // ticks anteriores. Resultado: após o 1º fail de um step retryable,
  // o worker reportava 'evaluated' em loop eterno. Agora o ciclo do
  // retry converge (backoff expira → UPDATE 1 promove → SELECT vê →
  // executeStep roda → 3 attempts → failed → evaluateBatchCompletion
  // finaliza).
  const rows = await dbAdmin.execute<{ id: string }>(sql`
    SELECT id FROM publication_steps
    WHERE batch_id = ${batchId}
      AND status = 'ready'
    ORDER BY ordinal ASC
  `);
  return rows.map((r) => r.id);
}

/**
 * Depois de um step suceder, propaga outputs pros inputs dos dependentes
 * via jsonb_set. Só propaga se outputKey/inputKey estão definidos na aresta.
 */
export async function propagateOutputs(completedStepId: string): Promise<void> {
  const deps = await dbAdmin
    .select()
    .from(stepDependencies)
    .where(eq(stepDependencies.dependsOnStepId, completedStepId));

  if (deps.length === 0) return;

  const [completed] = await dbAdmin
    .select({ outputData: publicationSteps.outputData })
    .from(publicationSteps)
    .where(eq(publicationSteps.id, completedStepId));

  const output = (completed?.outputData ?? {}) as Record<string, unknown>;

  for (const dep of deps) {
    if (!dep.outputKey || !dep.inputKey) continue;
    const value = output[dep.outputKey];
    if (value === undefined) continue;

    await dbAdmin.execute(sql`
      UPDATE publication_steps
      SET input_data = jsonb_set(
        COALESCE(input_data, '{}'::jsonb),
        ${sql.raw(`'{${dep.inputKey.replace(/'/g, "''")}}'`)},
        ${JSON.stringify(value)}::jsonb,
        true
      )
      WHERE id = ${dep.stepId}
    `);
  }
}

// ─── Execução de step ─────────────────────────────────────────────────────

async function markStepSucceeded(
  stepId: string,
  batchId: string,
  workspaceId: string,
  output: Record<string, unknown>,
): Promise<void> {
  await dbAdmin.execute(sql`
    UPDATE publication_steps
    SET status = 'succeeded',
        output_data = ${JSON.stringify(output)}::jsonb,
        completed_at = NOW(),
        duration_ms = CASE
          WHEN started_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
          ELSE NULL
        END
    WHERE id = ${stepId}
  `);
  await emitEvent({
    stepId,
    batchId,
    workspaceId,
    fromStatus: "running",
    toStatus: "succeeded",
    message: "Step completed",
  });
}

export async function executeStep(stepId: string): Promise<void> {
  // 1. running + attempts++
  await dbAdmin.execute(sql`
    UPDATE publication_steps
    SET status = 'running',
        started_at = NOW(),
        attempts = attempts + 1
    WHERE id = ${stepId}
  `);

  const [step] = await dbAdmin
    .select()
    .from(publicationSteps)
    .where(eq(publicationSteps.id, stepId));

  if (!step) throw new Error(`executeStep: step ${stepId} not found`);

  await emitEvent({
    stepId: step.id,
    batchId: step.batchId,
    workspaceId: step.workspaceId,
    fromStatus: "ready",
    toStatus: "running",
    message: `Attempt ${step.attempts}/${step.maxAttempts}`,
  });

  try {
    // TODO Fase 2: idempotency check via verifyMetaEntity(metaEntityId, metaEntityType)
    // Por enquanto pulamos — handlers reais ainda não existem.

    const handler = getStepHandler(step.stepType);
    const input = (step.inputData ?? {}) as Record<string, unknown>;
    const output = await handler(input, step.workspaceId);

    await markStepSucceeded(step.id, step.batchId, step.workspaceId, output);
    await propagateOutputs(step.id);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const code = classifyError(error);

    // Falha definitiva: excedeu maxAttempts OU erro não-retentável
    const isDefinitive =
      step.attempts >= step.maxAttempts || isNonRetryable(code);

    if (isDefinitive) {
      await dbAdmin.execute(sql`
        UPDATE publication_steps
        SET status = 'failed',
            last_error = ${errMsg},
            last_error_code = ${code},
            completed_at = NOW(),
            duration_ms = CASE
              WHEN started_at IS NOT NULL
              THEN (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
              ELSE NULL
            END
        WHERE id = ${stepId}
      `);
      await emitEvent({
        stepId: step.id,
        batchId: step.batchId,
        workspaceId: step.workspaceId,
        fromStatus: "running",
        toStatus: "failed",
        message: errMsg,
        metadata: { errorCode: code, attempts: step.attempts },
      });
      log.warn(
        { stepId, stepType: step.stepType, code, attempts: step.attempts },
        "step failed definitively",
      );
    } else {
      const nextRetry = calculateNextRetry(step.attempts);
      await dbAdmin
        .update(publicationSteps)
        .set({
          status: "retryable_failed",
          lastError: errMsg,
          lastErrorCode: code,
          nextRetryAt: nextRetry,
        })
        .where(eq(publicationSteps.id, stepId));
      await emitEvent({
        stepId: step.id,
        batchId: step.batchId,
        workspaceId: step.workspaceId,
        fromStatus: "running",
        toStatus: "retryable_failed",
        message: errMsg,
        metadata: {
          errorCode: code,
          attempts: step.attempts,
          nextRetryAt: nextRetry.toISOString(),
        },
      });
      log.info(
        { stepId, stepType: step.stepType, code, nextRetry },
        "step retryable",
      );
    }
  }
}

// ─── Avaliação de conclusão do batch ──────────────────────────────────────

export async function evaluateBatchCompletion(batchId: string): Promise<void> {
  const counts = await dbAdmin.execute<{
    succeeded: string;
    failed: string;
    skipped: string;
    active: string;
    critical_failed: string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'succeeded') as succeeded,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
      COUNT(*) FILTER (WHERE status IN ('pending','ready','running','retryable_failed')) as active,
      COUNT(*) FILTER (WHERE status = 'failed' AND is_critical = 'true') as critical_failed
    FROM publication_steps
    WHERE batch_id = ${batchId}
  `);

  const c = counts[0];
  const succeeded = Number(c.succeeded);
  const failed = Number(c.failed);
  const skipped = Number(c.skipped);
  const active = Number(c.active);
  const criticalFailed = Number(c.critical_failed);

  await dbAdmin
    .update(publicationBatches)
    .set({
      stepsSucceeded: succeeded,
      stepsFailed: failed,
      stepsSkipped: skipped,
    })
    .where(eq(publicationBatches.id, batchId));

  if (criticalFailed > 0) {
    // Cancela steps ainda pendentes (não tem sentido executar)
    await dbAdmin.execute(sql`
      UPDATE publication_steps
      SET status = 'cancelled'
      WHERE batch_id = ${batchId}
        AND status IN ('pending', 'ready')
    `);
    await finalizeBatch(batchId, "failed");
  } else if (active === 0) {
    await finalizeBatch(batchId, failed > 0 ? "partial_success" : "succeeded");
  }
  // Se active > 0: batch continua, próximo tick do worker processa
}

async function finalizeBatch(
  batchId: string,
  status: "succeeded" | "partial_success" | "failed" | "cancelled",
): Promise<void> {
  // 1. Finaliza batch em si (sempre acontece). Cancel pode chegar aqui
  // vindo de /api/batches/[id]/cancel — batch pode já estar em status
  // 'cancelled' (cancel route faz UPDATE preventivo). Este UPDATE é
  // idempotente: seta completed_at/lock=NULL caso ainda não estejam.
  await dbAdmin.execute(sql`
    UPDATE publication_batches
    SET status = ${status}::batch_status,
        completed_at = COALESCE(completed_at, NOW()),
        locked_by = NULL,
        locked_at = NULL
    WHERE id = ${batchId}
  `);

  // 2. Propaga status pro test_rounds (só se batchType = test_round_publish).
  // Regra "status reflete tráfego real": succeeded=live, failed=failed,
  // partial_success inspeciona activate_ads pra decidir. Cancelled reverte
  // pra 'reviewing' (batch foi abortado pelo usuário, round volta pro
  // estado pré-publicação pra permitir novo batch).
  const [batch] = await dbAdmin
    .select({
      batchType: publicationBatches.batchType,
      testRoundId: publicationBatches.testRoundId,
      workspaceId: publicationBatches.workspaceId,
    })
    .from(publicationBatches)
    .where(eq(publicationBatches.id, batchId));

  if (batch?.batchType === "test_round_publish" && batch.testRoundId) {
    const { roundStatus, reason } = await resolveTestRoundStatus(
      batchId,
      status,
    );

    await dbAdmin
      .update(testRounds)
      .set({
        status: roundStatus,
        // publishedAt marca finalização do batch (não primeira impression
        // real na Meta). Se no futuro quisermos medir "tempo de pacing
        // desde publicação", esse delta importa — cobre por TD-menor
        // anotado inline, não vale resolver agora.
        ...(roundStatus === "live" ? { publishedAt: sql`NOW()` } : {}),
        updatedAt: sql`NOW()`,
      })
      .where(eq(testRounds.id, batch.testRoundId));

    // Event meta batch-level (step_id=NULL desde migration 0011).
    // Trilha de auditoria: que regra levou o round pro status final.
    await dbAdmin.execute(sql`
      INSERT INTO step_events (batch_id, workspace_id, from_status, to_status, message, metadata)
      VALUES (
        ${batchId},
        ${batch.workspaceId},
        ${status},
        ${roundStatus},
        ${`test_round.status → ${roundStatus} (rule: ${reason})`},
        ${JSON.stringify({
          batchFinalStatus: status,
          testRoundStatus: roundStatus,
          reason,
        })}::jsonb
      )
    `);

    log.info(
      { batchId, testRoundId: batch.testRoundId, status, roundStatus, reason },
      "test_round status propagated",
    );
  } else {
    log.info({ batchId, status }, "batch finalized");
  }
}

/**
 * Decide test_rounds.status baseado no status final do batch.
 *
 * Regra "status reflete tráfego real":
 *   succeeded          → live (all good)
 *   failed             → failed (algo crítico quebrou)
 *   cancelled          → reviewing (cancel é reversível, round volta ao
 *                        estado pré-batch pra permitir re-publicação)
 *   partial_success    → depende do activate_ads:
 *     activate_ads.succeeded         → live (ads foram ativados, tráfego real)
 *     activate_ads não sucedeu       → failed (zero tráfego)
 *     activate_ads não existe no DAG → live (modo immediate: create_ad cria
 *                                       ACTIVE direto, partial = algum ad
 *                                       não-crítico falhou mas outros rodam)
 */
async function resolveTestRoundStatus(
  batchId: string,
  batchStatus: "succeeded" | "partial_success" | "failed" | "cancelled",
): Promise<{ roundStatus: string; reason: string }> {
  if (batchStatus === "succeeded") {
    return { roundStatus: "live", reason: "all_steps_succeeded" };
  }
  if (batchStatus === "failed") {
    return { roundStatus: "failed", reason: "critical_step_failed" };
  }
  if (batchStatus === "cancelled") {
    return { roundStatus: "reviewing", reason: "cancelled_by_user" };
  }

  // partial_success — inspeciona activate_ads
  const [activateStep] = await dbAdmin
    .select({ status: publicationSteps.status })
    .from(publicationSteps)
    .where(
      and(
        eq(publicationSteps.batchId, batchId),
        eq(publicationSteps.stepType, "activate_ads"),
      ),
    )
    .limit(1);

  if (!activateStep) {
    // Modo immediate: sem activate_ads. partial_success = algum create_ad
    // não-crítico falhou, outros succeeded com status=ACTIVE. Tráfego real.
    return {
      roundStatus: "live",
      reason: "partial_success_immediate_mode",
    };
  }
  if (activateStep.status === "succeeded") {
    return {
      roundStatus: "live",
      reason: "partial_success_with_active_traffic",
    };
  }
  return {
    roundStatus: "failed",
    reason: `partial_success_no_active_traffic_activate_step_${activateStep.status}`,
  };
}

// Exportado pra /api/batches/[id]/cancel chamar e fechar o fluxo completo
// (test_rounds.status + step_events batch-level). TD-020.
export { finalizeBatch };

async function getBatchStatus(batchId: string): Promise<string | null> {
  const [row] = await dbAdmin
    .select({ status: publicationBatches.status })
    .from(publicationBatches)
    .where(eq(publicationBatches.id, batchId));
  return row?.status ?? null;
}

// ─── Main tick ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TickResult {
  status:
    | "idle"
    | "processed"
    | "evaluated"
    | "paused"
    | "cancelled"
    | "error";
  batchId?: string;
  stepsProcessed?: number;
  promotedScheduled?: number;
  reason?: string;
  error?: string;
}

/**
 * Uma iteração do worker:
 *  0. Promove scheduled → pending cujo horário chegou
 *  1. Acquire 1 batch (SKIP LOCKED)
 *  2. Resolve steps ready
 *  3. Executa em sequência, checando interrupção (paused/cancelled) entre cada
 *  4. Reavalia conclusão e solta lock
 */
export async function processQueueTick(): Promise<TickResult> {
  const promotedScheduled = await promoteScheduledBatches();

  const batch = await acquireBatch();
  if (!batch) {
    return { status: "idle", promotedScheduled };
  }

  try {
    const readyStepIds = await resolveReadySteps(batch.id);

    if (readyStepIds.length === 0) {
      await evaluateBatchCompletion(batch.id);
      await releaseBatch(batch.id);
      return {
        status: "evaluated",
        batchId: batch.id,
        promotedScheduled,
      };
    }

    let processed = 0;
    for (const stepId of readyStepIds) {
      const currentStatus = await getBatchStatus(batch.id);
      if (currentStatus === "paused" || currentStatus === "cancelled") {
        await releaseBatch(batch.id);
        return {
          status: currentStatus,
          batchId: batch.id,
          stepsProcessed: processed,
          reason: "batch_interrupted_between_steps",
          promotedScheduled,
        };
      }

      const [step] = await dbAdmin
        .select({ stepType: publicationSteps.stepType })
        .from(publicationSteps)
        .where(eq(publicationSteps.id, stepId));

      await executeStep(stepId);
      processed++;

      if (step && isMetaApiStep(step.stepType)) {
        await sleep(META_RATE_LIMIT_MS);
      }
    }

    await evaluateBatchCompletion(batch.id);
    await releaseBatch(batch.id);

    return {
      status: "processed",
      batchId: batch.id,
      stepsProcessed: processed,
      promotedScheduled,
    };
  } catch (error) {
    await releaseBatch(batch.id);
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ batchId: batch.id, error: msg }, "tick failed");
    return { status: "error", batchId: batch.id, error: msg };
  }
}
