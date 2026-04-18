/**
 * POST /api/batches/[id]/retry — Re-enfileira steps failed de um batch.
 *
 * Comportamento:
 *  - Batch em status succeeded: retorna 409 (nada a retentar).
 *  - Batch em status cancelled: retorna 409 (cancel é irreversível por
 *    design — criar novo batch se quiser re-publicar).
 *  - Batch em failed/partial_success: reset de steps com status='failed'
 *    pra status='ready', attempts=0, last_error=NULL. Muda batch pra
 *    status='pending' (worker retoma no próximo tick).
 *
 * ⚠️  Aviso ao chamador: retry pode duplicar efeitos na Meta em handlers
 * sem idempotência forte (create_creative/adset/ad). Débito aceito no spec
 * §D4; reconciliation semanal (Fase 5) mitiga. Use com critério.
 *
 * Auth: cookie Supabase ou x-api-key. RLS filtra por workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { publicationBatches, publicationSteps } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { and, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

const RETRYABLE_BATCH_STATUSES = ["failed", "partial_success"];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const result = await withWorkspace(auth.workspace_id, async (tx) => {
      const [batch] = await tx
        .select({ id: publicationBatches.id, status: publicationBatches.status })
        .from(publicationBatches)
        .where(eq(publicationBatches.id, id))
        .limit(1);

      if (!batch) return { error: "not_found" as const };
      if (!RETRYABLE_BATCH_STATUSES.includes(batch.status)) {
        return { error: "not_retryable" as const, status: batch.status };
      }

      // Conta steps failed antes de resetar
      const failedSteps = await tx
        .select({ id: publicationSteps.id })
        .from(publicationSteps)
        .where(
          and(
            eq(publicationSteps.batchId, id),
            eq(publicationSteps.status, "failed"),
          ),
        );

      if (failedSteps.length === 0) {
        return { error: "nothing_to_retry" as const };
      }

      // Reset: failed → ready, attempts=0, erros limpos
      await tx
        .update(publicationSteps)
        .set({
          status: "ready",
          attempts: 0,
          lastError: null,
          lastErrorCode: null,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        })
        .where(
          and(
            eq(publicationSteps.batchId, id),
            eq(publicationSteps.status, "failed"),
          ),
        );

      // Cancelled steps (de cascata após critical fail) voltam pra pending
      // pra resolveReadySteps reavaliar as deps na próxima iteração
      await tx
        .update(publicationSteps)
        .set({ status: "pending" })
        .where(
          and(
            eq(publicationSteps.batchId, id),
            eq(publicationSteps.status, "cancelled"),
          ),
        );

      // Batch volta pra pending (worker acquira no próximo tick)
      await tx
        .update(publicationBatches)
        .set({
          status: "pending",
          completedAt: null,
          errorMessage: null,
          errorContext: null,
          lockedBy: null,
          lockedAt: null,
          // Zera counters — evaluateBatchCompletion recalcula
          stepsSucceeded: sql`GREATEST(${publicationBatches.stepsSucceeded} - 0, 0)`,
          stepsFailed: 0,
          stepsSkipped: 0,
        })
        .where(eq(publicationBatches.id, id));

      return { error: null as null, retried: failedSteps.length };
    });

    if (result.error === "not_found") {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }
    if (result.error === "not_retryable") {
      return NextResponse.json(
        {
          error: `Batch in status '${result.status}' is not retryable (only failed|partial_success)`,
        },
        { status: 409 },
      );
    }
    if (result.error === "nothing_to_retry") {
      return NextResponse.json(
        { error: "No failed steps in this batch" },
        { status: 409 },
      );
    }

    return NextResponse.json({
      batch_id: id,
      status: "pending",
      steps_retried: result.retried,
      warning:
        "Retry pode duplicar entities na Meta (<1/mês). Reconciliation job semanal cobre.",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to retry batch";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
