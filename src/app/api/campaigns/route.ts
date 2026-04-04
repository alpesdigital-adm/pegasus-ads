import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { v4 as uuid } from "uuid";

/**
 * GET /api/campaigns — Lista todas as campanhas do workspace.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const result = await db.execute({
      sql: "SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC",
      args: [auth.workspace_id],
    });
    return NextResponse.json({ campaigns: result.rows });
  } catch (error) {
    console.error("List campaigns error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list campaigns" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/campaigns — Cadastra uma nova campanha.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const body = await req.json();

    const id = uuid();
    await db.execute({
      sql: `INSERT INTO campaigns (id, name, meta_campaign_id, meta_account_id, pixel_id, page_id,
              instagram_user_id, objective, cpl_target, status, config, workspace_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        body.name,
        body.meta_campaign_id,
        body.meta_account_id,
        body.pixel_id || null,
        body.page_id || null,
        body.instagram_user_id || null,
        body.objective || "OUTCOME_LEADS",
        body.cpl_target || null,
        body.status || "active",
        JSON.stringify(body.config || {}),
        auth.workspace_id,
      ],
    });

    return NextResponse.json({ id, ...body }, { status: 201 });
  } catch (error) {
    console.error("Create campaign error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create campaign" },
      { status: 500 }
    );
  }
}
