import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { runPublishPipeline } from "@/lib/pipelines/publish";

export const maxDuration = 60;

/**
 * POST /api/test-rounds/publish — Executa o pipeline de publicação para um test round.
 *
 * Body: { test_round_id: string }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const body = await request.json();

    if (!body.test_round_id) {
      return NextResponse.json(
        { error: "test_round_id is required" },
        { status: 400 }
      );
    }

    // Buscar test round
    const roundRow = await db.execute({
      sql: "SELECT * FROM test_rounds WHERE id = ? AND workspace_id = ?",
      args: [body.test_round_id, auth.workspace_id],
    });

    if (roundRow.rows.length === 0) {
      return NextResponse.json(
        { error: "Test round not found" },
        { status: 404 }
      );
    }

    const round = roundRow.rows[0];

    if (!["reviewing", "generating", "failed"].includes(round.status as string)) {
      return NextResponse.json(
        { error: `Test round status is '${round.status}', expected 'reviewing', 'generating', or 'failed'` },
        { status: 400 }
      );
    }

    // Executar pipeline
    const result = await runPublishPipeline({
      testRoundId: body.test_round_id,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Publish pipeline error:", error);
    const errorMessage = error instanceof Error ? error.message : "Pipeline failed";
    const errorStack = error instanceof Error ? error.stack : undefined;
    return NextResponse.json(
      { error: errorMessage, stack: errorStack },
      { status: 500 }
    );
  }
}
