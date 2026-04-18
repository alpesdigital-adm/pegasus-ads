/**
 * POST /api/test-rounds/generate — Executa o pipeline de geração para um test round.
 *
 * Body: { test_round_id: string, num_variants?: number }
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (RLS)
 *  - 1 SELECT test_round em Drizzle
 *  - Pipeline legacy (runGeneratePipeline em lib/pipelines/generate.ts)
 *    continua — migração separada quando lib/pipelines for tocada
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { testRounds } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { runGeneratePipeline } from "@/lib/pipelines/generate";
import { eq } from "drizzle-orm";

export const maxDuration = 300;

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

    if (round.status !== "draft") {
      return NextResponse.json(
        { error: `Test round status is '${round.status}', expected 'draft'` },
        { status: 400 },
      );
    }

    const result = await runGeneratePipeline({
      testRoundId: body.test_round_id,
      campaignId: round.campaignId as string,
      controlCreativeId: round.controlCreativeId as string,
      variableType: round.variableType as string,
      variableValue: round.variableValue ?? undefined,
      numVariants: body.num_variants || 1,
      workspaceId: auth.workspace_id,
      controlTexts: body.control_texts || undefined,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Generate pipeline error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Pipeline failed" },
      { status: 500 },
    );
  }
}
