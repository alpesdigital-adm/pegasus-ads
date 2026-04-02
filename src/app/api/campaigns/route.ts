import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { v4 as uuid } from "uuid";

/**
 * GET /api/campaigns — Lista todas as campanhas cadastradas.
 */
export async function GET() {
  try {
    const db = await initDb();
    const result = await db.execute({
      sql: "SELECT * FROM campaigns ORDER BY created_at DESC",
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
export async function POST(request: NextRequest) {
  try {
    const db = await initDb();
    const body = await request.json();

    const id = uuid();
    await db.execute({
      sql: `INSERT INTO campaigns (id, name, meta_campaign_id, meta_account_id, pixel_id, page_id,
              instagram_user_id, objective, cpl_target, status, config)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
