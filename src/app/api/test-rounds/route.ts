/**
 * GET  /api/test-rounds — Lista test rounds do workspace (filtro campaign_id opcional)
 * POST /api/test-rounds — Cria novo test round (draft)
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (RLS scoped)
 *  - JOIN campaigns + creatives via innerJoin
 *  - uuid() manual removido (.defaultRandom() cobre)
 *  - round_number via MAX()+1 em sql`` para preservar atomicidade lógica
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { testRounds, testRoundVariants, campaigns, creatives } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { and, desc, eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const campaignId = req.nextUrl.searchParams.get("campaign_id");

    const rows = await withWorkspace(auth.workspace_id, async (tx) => {
      const conditions = campaignId
        ? [eq(testRounds.campaignId, campaignId)]
        : [];

      return tx
        .select({
          id: testRounds.id,
          campaign_id: testRounds.campaignId,
          control_creative_id: testRounds.controlCreativeId,
          variable_type: testRounds.variableType,
          variable_value: testRounds.variableValue,
          round_number: testRounds.roundNumber,
          status: testRounds.status,
          ai_prompt_used: testRounds.aiPromptUsed,
          ai_verification: testRounds.aiVerification,
          decided_at: testRounds.decidedAt,
          decision: testRounds.decision,
          decision_reason: testRounds.decisionReason,
          workspace_id: testRounds.workspaceId,
          created_at: testRounds.createdAt,
          updated_at: testRounds.updatedAt,
          campaign_name: campaigns.name,
          meta_campaign_id: campaigns.metaCampaignId,
          control_name: creatives.name,
          control_blob_url: creatives.blobUrl,
        })
        .from(testRounds)
        .innerJoin(campaigns, eq(testRounds.campaignId, campaigns.id))
        .innerJoin(creatives, eq(testRounds.controlCreativeId, creatives.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(testRounds.createdAt));
    });

    return NextResponse.json({ test_rounds: rows });
  } catch (error) {
    console.error("List test rounds error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list test rounds" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();

    if (!body.campaign_id || !body.control_creative_id || !body.variable_type) {
      return NextResponse.json(
        { error: "campaign_id, control_creative_id, and variable_type are required" },
        { status: 400 },
      );
    }

    const round = await withWorkspace(auth.workspace_id, async (tx) => {
      // Buscar último round_number desta campanha (RLS escopa workspace_id)
      const maxResult = await tx.execute(sql`
        SELECT COALESCE(MAX(round_number), 0) AS max_round
        FROM test_rounds
        WHERE campaign_id = ${body.campaign_id}
      `);
      const rows = maxResult as unknown as Array<Record<string, unknown>>;
      const roundNumber = Number(rows[0]?.max_round ?? 0) + 1;

      // Insert test_round com defaultRandom id
      const inserted = await tx
        .insert(testRounds)
        .values({
          workspaceId: auth.workspace_id,
          campaignId: body.campaign_id,
          controlCreativeId: body.control_creative_id,
          variableType: body.variable_type,
          variableValue: body.variable_value ?? null,
          roundNumber,
          status: "draft",
        })
        .returning({ id: testRounds.id });

      const testRoundId = inserted[0].id as string;

      // Registrar o controle como variant role='control'
      await tx.insert(testRoundVariants).values({
        testRoundId,
        creativeId: body.control_creative_id,
        role: "control",
        placement: "both",
        status: "published",
      });

      return {
        id: testRoundId,
        campaign_id: body.campaign_id,
        control_creative_id: body.control_creative_id,
        variable_type: body.variable_type,
        variable_value: body.variable_value ?? null,
        round_number: roundNumber,
        status: "draft",
      };
    });

    return NextResponse.json(round, { status: 201 });
  } catch (error) {
    console.error("Create test round error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create test round" },
      { status: 500 },
    );
  }
}
