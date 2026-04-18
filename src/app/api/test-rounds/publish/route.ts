/**
 * POST /api/test-rounds/publish — Executa o pipeline de publicação para um test round.
 *
 * Body: { test_round_id: string }
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (RLS)
 *  - 1 SELECT test_round em Drizzle
 *  - Pipeline legacy (runPublishPipeline em lib/pipelines/publish.ts)
 *    continua — migração separada quando lib/pipelines for tocada
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { testRounds } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { runPublishPipeline } from "@/lib/pipelines/publish";
import { eq } from "drizzle-orm";

export const maxDuration = 60;

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

    if (!["reviewing", "generating", "failed"].includes(round.status as string)) {
      return NextResponse.json(
        {
          error: `Test round status is '${round.status}', expected 'reviewing', 'generating', or 'failed'`,
        },
        { status: 400 },
      );
    }

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
