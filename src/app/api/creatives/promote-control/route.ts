/**
 * POST /api/creatives/promote-control  — Tarefa 3.2: Promoção automática de controle
 *
 * Quando um criativo atinge L5 (Winner Potencial: CPL < 80% do controle),
 * esta rota o promove a ser o novo controle da campanha.
 *
 * Body: { creative_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";

function getAdBaseName(creativeName: string): string {
  let name = creativeName.replace(/\.\w+$/, "");
  name = name.replace(/[FS]$/, "");
  return name;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const db = getDb();

  interface Body {
    creative_id?: string;
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch { /* ok */ }

  if (!body.creative_id) {
    return NextResponse.json({ error: "creative_id is required" }, { status: 400 });
  }

  // ── 1. Buscar o criativo alvo no workspace ──
  const targetRow = await db.execute({
    sql: `SELECT id, name, status, generation, is_control FROM creatives WHERE id = ? AND workspace_id = ?`,
    args: [body.creative_id, auth.workspace_id],
  });

  if (targetRow.rows.length === 0) {
    return NextResponse.json({ error: "Creative not found" }, { status: 404 });
  }

  const target = targetRow.rows[0];
  const baseName = getAdBaseName(target.name as string);

  // ── 2. Encontrar todos os criativos deste AD group no workspace ──
  const groupRows = await db.execute({
    sql: `SELECT id, name FROM creatives WHERE (name LIKE ? OR name LIKE ? OR name = ?) AND workspace_id = ?`,
    args: [`${baseName}F%`, `${baseName}S%`, baseName, auth.workspace_id],
  });

  const groupIds = groupRows.rows.map((r) => r.id as string);

  if (groupIds.length === 0) {
    return NextResponse.json({ error: "No creatives found for this AD group" }, { status: 404 });
  }

  // ── 3. Identificar o controle anterior no workspace ──
  const prevControlRow = await db.execute({
    sql: `
      SELECT id, name FROM creatives
      WHERE is_control = TRUE AND workspace_id = ?
      ORDER BY created_at ASC
      LIMIT 1
    `,
    args: [auth.workspace_id],
  });

  const previousControlId = prevControlRow.rows.length > 0
    ? (prevControlRow.rows[0].id as string)
    : null;

  // ── 4. Revogar is_control de todos no workspace; promover o AD group alvo ──
  await db.execute({
    sql: `UPDATE creatives SET is_control = FALSE WHERE workspace_id = ?`,
    args: [auth.workspace_id],
  });

  for (const id of groupIds) {
    await db.execute({
      sql: `UPDATE creatives SET is_control = TRUE, status = 'winner' WHERE id = ? AND workspace_id = ?`,
      args: [id, auth.workspace_id],
    });
  }

  // ── 5. Criar edge 'promoted' do antigo controle → novo controle ──
  let edgeId: string | null = null;
  if (previousControlId && previousControlId !== body.creative_id) {
    edgeId = uuid();
    try {
      await db.execute({
        sql: `INSERT INTO creative_edges (id, source_id, target_id, relationship, variable_isolated)
              VALUES (?, ?, ?, 'iteration', 'promoted_to_control')`,
        args: [edgeId, previousControlId, body.creative_id],
      });
    } catch {
      edgeId = null;
    }
  }

  // ── 6. Resolver alertas L5 do criativo promovido ──
  await db.execute({
    sql: `UPDATE alerts SET resolved = TRUE WHERE creative_id = ? AND level = 'L5' AND resolved = FALSE AND workspace_id = ?`,
    args: [body.creative_id, auth.workspace_id],
  });

  console.log(`[PromoteControl] AD group '${baseName}' promovido a controle. IDs: ${groupIds.join(", ")} | anterior: ${previousControlId}`);

  return NextResponse.json({
    ok: true,
    promoted_ad: baseName,
    promoted_ids: groupIds,
    previous_control_id: previousControlId,
    edge_created: edgeId !== null,
  });
}

// GET — retorna o controle atual
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const db = getDb();

  const result = await db.execute({
    sql: `
      SELECT c.id, c.name, c.generation, c.is_control, c.status,
        SUM(m.spend)  AS total_spend,
        SUM(m.leads)  AS total_leads,
        CASE WHEN SUM(m.leads) > 0 THEN SUM(m.spend) / SUM(m.leads) ELSE NULL END AS cpl
      FROM creatives c
      LEFT JOIN metrics m ON m.creative_id = c.id
      WHERE (c.is_control = TRUE OR c.generation = 0) AND c.workspace_id = ?
      GROUP BY c.id, c.name, c.generation, c.is_control, c.status
      ORDER BY c.is_control DESC, c.created_at ASC
      LIMIT 4
    `,
    args: [auth.workspace_id],
  });

  return NextResponse.json({ controls: result.rows });
}
