/**
 * POST /api/batches/[id]/cancel — Cancela um batch em andamento.
 *
 * Comportamento:
 *  - Batch em status terminal (succeeded/partial_success/failed/cancelled)
 *    retorna 409 Conflict.
 *  - Caso contrário: cascata pending/ready → cancelled, depois chama
 *    finalizeBatch('cancelled') pra propagar test_rounds.status='reviewing'
 *    (cancel é reversível por design) e emitir step_event batch-level com
 *    reason='cancelled_by_user'. Worker detecta interrupção entre steps e
 *    aborta (processQueueTick verifica status a cada iteração).
 *  - Steps em running completam naturalmente (não interrompemos chamada
 *    Meta API em voo — segurança > UX).
 *
 * NÃO reverte efeitos colaterais já escritos na Meta (creatives criados,
 * ads PAUSED ainda existem). Em modo after_all isso é seguro — ads PAUSED
 * não gastam. Em immediate, ads ACTIVE continuam rodando até cancel manual
 * na Meta.
 *
 * TD-020 fixado: cancel route agora chama finalizeBatch (antes pulava,
 * deixando test_rounds em 'publishing' pendurado + sem step_events
 * batch-level).
 *
 * Spec: docs/staging-queue-v2.md §7.2 (interrupção entre steps).
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, dbAdmin } from "@/lib/db";
import { publicationBatches, publicationSteps } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { finalizeBatch } from "@/lib/staging-queue/worker";
import { and, eq, inArray, sql } from "drizzle-orm";

export const runtime = "nodejs";

const TERMINAL_STATUSES = [
  "succeeded",
  "partial_success",
  "failed",
  "cancelled",
];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    // 1. Valida ownership (RLS) + estado pré-cancel
    const precheck = await withWorkspace(auth.workspace_id, async (tx) => {
      const [batch] = await tx
        .select({ id: publicationBatches.id, status: publicationBatches.status })
        .from(publicationBatches)
        .where(eq(publicationBatches.id, id))
        .limit(1);

      if (!batch) return { error: "not_found" as const };
      if (TERMINAL_STATUSES.includes(batch.status)) {
        return { error: "terminal" as const, status: batch.status };
      }
      return { error: null as null, status: batch.status };
    });

    if (precheck.error === "not_found") {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }
    if (precheck.error === "terminal") {
      return NextResponse.json(
        {
          error: `Batch already in terminal status '${precheck.status}' — cannot cancel`,
        },
        { status: 409 },
      );
    }

    // 2. Cascata: pending/ready → cancelled. Usa dbAdmin (BYPASSRLS) porque
    // é write cross-step no batch — mesmo pattern do worker. O RLS check
    // já aconteceu no pre-check acima.
    await dbAdmin
      .update(publicationSteps)
      .set({ status: "cancelled", completedAt: sql`NOW()` })
      .where(
        and(
          eq(publicationSteps.batchId, id),
          inArray(publicationSteps.status, ["pending", "ready"]),
        ),
      );

    // 3. finalizeBatch('cancelled') — encerra batch + propaga
    // test_rounds.status='reviewing' + emite step_event batch-level
    // com reason='cancelled_by_user'. Integração com Fase 2D.
    await finalizeBatch(id, "cancelled");

    return NextResponse.json({
      batch_id: id,
      status: "cancelled",
      message:
        "Batch cancellation requested. Running step (if any) completes naturally; subsequent steps aborted. test_round reverted to 'reviewing'.",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to cancel batch";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
