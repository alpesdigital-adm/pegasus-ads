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

/**
 * PATCH /api/campaigns
 * Body: { id: string, ...campos a atualizar }
 *
 * Atualiza uma campanha existente. Aceita os mesmos campos do POST.
 * Para `config`, faz merge superficial com o existente.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const body = await req.json();

    if (!body.id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    // Fetch current row to merge config
    const cur = await db.execute({
      sql: "SELECT * FROM campaigns WHERE id = ? AND workspace_id = ? LIMIT 1",
      args: [body.id, auth.workspace_id],
    });
    if (cur.rows.length === 0) {
      return NextResponse.json({ error: "campaign not found" }, { status: 404 });
    }

    const row = cur.rows[0] as Record<string, unknown>;
    let mergedConfig: Record<string, unknown> = {};
    try {
      mergedConfig = typeof row.config === "string" ? JSON.parse(row.config) : (row.config as Record<string, unknown>) || {};
    } catch {}

    if (body.config && typeof body.config === "object") {
      // Deep-ish merge: top-level keys overridden, nested objects shallow-merged
      for (const [k, v] of Object.entries(body.config)) {
        if (v && typeof v === "object" && !Array.isArray(v) && mergedConfig[k] && typeof mergedConfig[k] === "object") {
          mergedConfig[k] = { ...(mergedConfig[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
        } else {
          mergedConfig[k] = v;
        }
      }
    }

    const updates: string[] = [];
    const args: unknown[] = [];
    const allowed = ["name", "meta_campaign_id", "meta_account_id", "pixel_id", "page_id", "instagram_user_id", "objective", "cpl_target", "status"] as const;
    for (const f of allowed) {
      if (body[f] !== undefined) {
        updates.push(`${f} = ?`);
        args.push(body[f]);
      }
    }
    updates.push("config = ?");
    args.push(JSON.stringify(mergedConfig));
    updates.push("updated_at = CURRENT_TIMESTAMP");

    args.push(body.id, auth.workspace_id);

    await db.execute({
      sql: `UPDATE campaigns SET ${updates.join(", ")} WHERE id = ? AND workspace_id = ?`,
      args,
    });

    const after = await db.execute({
      sql: "SELECT * FROM campaigns WHERE id = ? AND workspace_id = ? LIMIT 1",
      args: [body.id, auth.workspace_id],
    });

    return NextResponse.json({ updated: true, campaign: after.rows[0] });
  } catch (error) {
    console.error("Update campaign error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update campaign" },
      { status: 500 }
    );
  }
}
