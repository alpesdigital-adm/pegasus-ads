/**
 * POST /api/test-rounds/publish — Executa o pipeline de publicação para um test round.
 *
 * Body:
 *  - test_round_id: string (required)
 *  - activation_mode?: 'after_all' | 'immediate' (só usado quando
 *    USE_STAGING_QUEUE=true; default 'after_all' pela spec)
 *  - name_prefix?: string (só usado quando USE_STAGING_QUEUE=true;
 *    prefixo aplicado em todos os nomes Meta criados — ad, adset,
 *    creative, labels. Default "". Útil pra smoke tests: "TEST__")
 *
 * Comportamento:
 *  - USE_STAGING_QUEUE=true (prod): cria batch via staging-queue factory,
 *    retorna 202 { batch_id, variant_pair_count, status } imediatamente.
 *    Worker processa async via cron. UI pode fazer polling em
 *    GET /api/batches/[id]/status (Fase 3B) ou subscribe Realtime
 *    (bloqueado por TD-015 até Fase 4).
 *  - USE_STAGING_QUEUE=false (default hoje): mantém pipeline legacy
 *    síncrono (runPublishPipeline). Retorno 200 com publishedAds[].
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (RLS)
 *  - 1 SELECT test_round em Drizzle
 *  - Pipeline legacy (runPublishPipeline em lib/pipelines/publish.ts)
 *    continua — migração separada quando lib/pipelines for tocada
 *
 * STAGING QUEUE v2 FASE 3 (TD-007):
 *  - Adicionado branch condicional via USE_STAGING_QUEUE
 *  - Factory createTestRoundBatch lida com validação (404/400) replicando
 *    a lógica pré-existente. Pipeline legacy fica como fallback seguro.
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { testRounds } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { runPublishPipeline } from "@/lib/pipelines/publish";
import { createTestRoundBatch } from "@/lib/staging-queue/factory";
import { eq } from "drizzle-orm";

export const maxDuration = 60;

function isStagingQueueEnabled(): boolean {
  return process.env.USE_STAGING_QUEUE === "true";
}

const VALID_STATUSES = ["reviewing", "generating", "failed"];

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();

    if (!body.test_round_id) {
      return NextResponse.json(
        { error: "test_round_id is required" },
        { status: 400 },
      );
    }

    // Validação do status do test_round — mesma pré-existente (vale pra
    // ambos os branches). Feita aqui pra garantir resposta 400 consistente
    // antes de despachar pro factory/pipeline.
    const rounds = await withWorkspace(auth.workspace_id, async (tx) => {
      return tx
        .select()
        .from(testRounds)
        .where(eq(testRounds.id, body.test_round_id))
        .limit(1);
    });

    if (rounds.length === 0) {
      return NextResponse.json(
        { error: "Test round not found" },
        { status: 404 },
      );
    }

    const round = rounds[0];
    if (!VALID_STATUSES.includes(round.status as string)) {
      return NextResponse.json(
        {
          error: `Test round status is '${round.status}', expected one of ${VALID_STATUSES.join("|")}`,
        },
        { status: 400 },
      );
    }

    // ── Branch Staging Queue ──
    if (isStagingQueueEnabled()) {
      const activationMode =
        body.activation_mode === "immediate" ? "immediate" : "after_all";
      const namePrefix =
        typeof body.name_prefix === "string" ? body.name_prefix : "";

      const result = await createTestRoundBatch({
        testRoundId: body.test_round_id,
        workspaceId: auth.workspace_id,
        activationMode,
        namePrefix,
      });

      return NextResponse.json(
        {
          batch_id: result.batchId,
          variant_pair_count: result.variantPairCount,
          activation_mode: activationMode,
          name_prefix: namePrefix || null,
          status: "pending",
          message:
            "Batch enfileirado. Poll em GET /api/batches/{batch_id}/status.",
        },
        { status: 202 },
      );
    }

    // ── Branch legacy (flag off) ──
    const result = await runPublishPipeline({
      testRoundId: body.test_round_id,
      workspaceId: auth.workspace_id,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Publish pipeline error:", error);
    const errorMessage = error instanceof Error ? error.message : "Pipeline failed";
    const errorStack = error instanceof Error ? error.stack : undefined;
    return NextResponse.json(
      { error: errorMessage, stack: errorStack },
      { status: 500 },
    );
  }
}
