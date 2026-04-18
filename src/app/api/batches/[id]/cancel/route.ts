/**
 * POST /api/batches/[id]/cancel — Cancela um batch em andamento.
 *
 * Comportamento:
 *  - Batch em status terminal (succeeded/partial_success/failed/cancelled)
 *    retorna 409 Conflict.
 *  - Caso contrário: seta batch.status='cancelled' + completed_at=NOW().
 *    Worker detecta interrupção entre steps e aborta (processQueueTick
 *    verifica status a cada iteração).
 *  - Steps em pending/ready viram cancelled também (zero-spend promise).
 *  - Steps em running completam naturalmente (não interrompemos chamada
 *    Meta API em voo — segurança > UX).
 *
 * NÃO reverte efeitos colaterais já escritos na Meta (creatives criados,
 * ads PAUSED ainda existem). Em modo after_all isso é seguro — ads PAUSED
 * não gastam. Em immediate, ads ACTIVE continuam rodando até cancel manual
 * na Meta.
 *
 * Spec: docs/staging-queue-v2.md §7.2 (interrupção entre steps).
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { publicationBatches, publicationSteps } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
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
    const result = await withWorkspace(auth.workspace_id, async (tx) => {
      const [batch] = await tx
        .select({ id: publicationBatches.id, status: publicationBatches.status })
        .from(publicationBatches)
        .where(eq(publicationBatches.id, id))
        .limit(1);

      if (!batch) return { error: "not_found" as const };
      if (TERMINAL_STATUSES.includes(batch.status)) {
        return { error: "terminal" as const, status: batch.status };
      }

      // Cancela batch
      await tx
        .update(publicationBatches)
        .set({
          status: "cancelled",
          completedAt: sql`NOW()`,
          lockedBy: null,
          lockedAt: null,
        })
        .where(eq(publicationBatches.id, id));

      // Steps em pending/ready → cancelled. Running não é interrompido
      // (call Meta em voo finaliza; próximo step detecta batch cancelled
      // via processQueueTick e aborta).
      await tx
        .update(publicationSteps)
        .set({ status: "cancelled", completedAt: sql`NOW()` })
        .where(
          and(
            eq(publicationSteps.batchId, id),
            inArray(publicationSteps.status, ["pending", "ready"]),
          ),
        );

      return { error: null as null, status: "cancelled" as const };
    });

    if (result.error === "not_found") {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }
    if (result.error === "terminal") {
      return NextResponse.json(
        {
          error: `Batch already in terminal status '${result.status}' — cannot cancel`,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      batch_id: id,
      status: "cancelled",
      message: "Batch cancellation requested. Running step (if any) completes naturally; subsequent steps are aborted.",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to cancel batch";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
