import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { runGeneratePipeline } from "@/lib/pipelines/generate";

export const maxDuration = 60;

/**
 * POST /api/test-rounds/generate — Executa o pipeline de geração para um test round.
 *
 * Body: { test_round_id: string, num_variants?: number }
 */
export async function POST(request: NextRequest) {
  try {
    const db = await initDb();
    const body = await request.json();

    if (!body.test_round_id) {
      return NextResponse.json(
        { error: "test_round_id is required" },
        { status: 400 }
      );
    }

    // Buscar test round
    const roundRow = await db.execute({
      sql: "SELECT * FROM test_rounds WHERE id = ?",
      args: [body.test_round_id],
    });

    if (roundRow.rows.length === 0) {
      return NextResponse.json(
        { error: "Test round not found" },
        { status: 404 }
      );
    }

    const round = roundRow.rows[0];

    if (round.status !== "draft") {
      return NextResponse.json(
        { error: `Test round status is '${round.status}', expected 'draft'` },
        { status: 400 }
      );
    }

    // Executar pipeline
    const result = await runGeneratePipeline({
      testRoundId: body.test_round_id,
      campaignId: round.campaign_id as string,
      controlCreativeId: round.control_creative_id as string,
      variableType: round.variable_type as string,
      variableValue: round.variable_value as string | undefined,
      numVariants: body.num_variants || 1,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Generate pipeline error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Pipeline failed" },
      { status: 500 }
    );
  }
}
