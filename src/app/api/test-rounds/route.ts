import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { v4 as uuid } from "uuid";

/**
 * GET /api/test-rounds — Lista test rounds do workspace (filtro por campaign_id opcional).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const campaignId = req.nextUrl.searchParams.get("campaign_id");

    let sql = `
      SELECT tr.*, c.name as campaign_name, c.meta_campaign_id,
             cr.name as control_name, cr.blob_url as control_blob_url
      FROM test_rounds tr
      JOIN campaigns c ON tr.campaign_id = c.id
      JOIN creatives cr ON tr.control_creative_id = cr.id
      WHERE tr.workspace_id = ?
    `;
    const args: unknown[] = [auth.workspace_id];

    if (campaignId) {
      sql += " AND tr.campaign_id = ?";
      args.push(campaignId);
    }

    sql += " ORDER BY tr.created_at DESC";

    const result = await db.execute({ sql, args });
    return NextResponse.json({ test_rounds: result.rows });
  } catch (error) {
    console.error("List test rounds error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list test rounds" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/test-rounds — Cria um novo test round (draft).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const body = await req.json();

    if (!body.campaign_id || !body.control_creative_id || !body.variable_type) {
      return NextResponse.json(
        { error: "campaign_id, control_creative_id, and variable_type are required" },
        { status: 400 }
      );
    }

    // Buscar último round_number desta campanha no workspace
    const lastRound = await db.execute({
      sql: "SELECT MAX(round_number) as max_round FROM test_rounds WHERE campaign_id = ? AND workspace_id = ?",
      args: [body.campaign_id, auth.workspace_id],
    });
    const roundNumber = ((lastRound.rows[0]?.max_round as number) || 0) + 1;

    const id = uuid();
    await db.execute({
      sql: `INSERT INTO test_rounds (id, campaign_id, control_creative_id, variable_type, variable_value, round_number, status, workspace_id)
            VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`,
      args: [
        id,
        body.campaign_id,
        body.control_creative_id,
        body.variable_type,
        body.variable_value || null,
        roundNumber,
        auth.workspace_id,
      ],
    });

    // Registrar controle como variant role='control'
    await db.execute({
      sql: `INSERT INTO test_round_variants (id, test_round_id, creative_id, role, placement, status)
            VALUES (?, ?, ?, 'control', 'both', 'published')`,
      args: [uuid(), id, body.control_creative_id],
    });

    return NextResponse.json({
      id,
      campaign_id: body.campaign_id,
      control_creative_id: body.control_creative_id,
      variable_type: body.variable_type,
      variable_value: body.variable_value,
      round_number: roundNumber,
      status: "draft",
    }, { status: 201 });
  } catch (error) {
    console.error("Create test round error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create test round" },
      { status: 500 }
    );
  }
}
