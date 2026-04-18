/**
 * GET /api/batches/[id]/status — Snapshot de batch + steps.
 *
 * Resposta:
 *  - batch: counts + timestamps + error
 *  - steps: lista ordenada por ordinal com status, attempts, lastError,
 *           nextRetryAt, metaEntityId
 *  - progress: percent completo (baseado em stepsSucceeded+skipped vs total)
 *
 * Consumido pela UI pra polling (fallback enquanto Realtime está bloqueado
 * por TD-015). Futuro: deprecate em favor de Realtime channel batch-{id}.
 *
 * Auth: cookie Supabase ou x-api-key. RLS filtra por workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { publicationBatches, publicationSteps } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { asc, eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const result = await withWorkspace(auth.workspace_id, async (tx) => {
      const [batch] = await tx
        .select()
        .from(publicationBatches)
        .where(eq(publicationBatches.id, id))
        .limit(1);

      if (!batch) return null;

      const steps = await tx
        .select({
          id: publicationSteps.id,
          step_type: publicationSteps.stepType,
          ordinal: publicationSteps.ordinal,
          status: publicationSteps.status,
          is_critical: publicationSteps.isCritical,
          attempts: publicationSteps.attempts,
          max_attempts: publicationSteps.maxAttempts,
          last_error: publicationSteps.lastError,
          last_error_code: publicationSteps.lastErrorCode,
          next_retry_at: publicationSteps.nextRetryAt,
          meta_entity_id: publicationSteps.metaEntityId,
          meta_entity_type: publicationSteps.metaEntityType,
          started_at: publicationSteps.startedAt,
          completed_at: publicationSteps.completedAt,
          duration_ms: publicationSteps.durationMs,
        })
        .from(publicationSteps)
        .where(eq(publicationSteps.batchId, id))
        .orderBy(asc(publicationSteps.ordinal));

      return { batch, steps };
    });

    if (!result) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }

    const { batch, steps } = result;
    const total = batch.stepsTotal || 0;
    const settled =
      (batch.stepsSucceeded ?? 0) +
      (batch.stepsFailed ?? 0) +
      (batch.stepsSkipped ?? 0);
    const percentComplete = total > 0 ? Math.round((settled / total) * 100) : 0;

    return NextResponse.json({
      batch: {
        id: batch.id,
        batch_type: batch.batchType,
        status: batch.status,
        activation_mode: batch.activationMode,
        priority: batch.priority,
        steps_total: batch.stepsTotal,
        steps_succeeded: batch.stepsSucceeded,
        steps_failed: batch.stepsFailed,
        steps_skipped: batch.stepsSkipped,
        scheduled_at: batch.scheduledAt,
        created_at: batch.createdAt,
        started_at: batch.startedAt,
        completed_at: batch.completedAt,
        estimated_completion_at: batch.estimatedCompletionAt,
        test_round_id: batch.testRoundId,
        error_message: batch.errorMessage,
      },
      steps,
      progress: { percent_complete: percentComplete },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to load batch";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
