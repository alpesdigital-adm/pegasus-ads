/**
 * POST /api/creatives/promote-control  — Tarefa 3.2: Promoção automática de controle
 *
 * Quando um criativo atinge L5 (Winner Potencial: CPL < 80% do controle),
 * esta rota o promove a ser o novo controle da campanha.
 *
 * Fluxo:
 * 1. Identifica o AD group do criativo alvo (baseName extraído do nome)
 * 2. Remove is_control de todos os criativos
 * 3. Marca os criativos do AD group (feed + stories) como is_control = true
 * 4. Atualiza status do novo controle para 'winner'
 * 5. Cria edge 'promoted' do antigo controle para o novo
 * 6. Retorna resumo da promoção
 *
 * Body: { creative_id: string }
 * Response: { ok, promoted_ad, previous_control_id, edge_created }
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb, initDb } from "@/lib/db";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";

function getAdBaseName(creativeName: string): string {
  let name = creativeName.replace(/\.\w+$/, "");
  name = name.replace(/[FS]$/, "");
  return name;
}

export async function POST(req: NextRequest) {
  const db = await initDb();

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

  // ── 1. Buscar o criativo alvo ──
  const targetRow = await db.execute({
    sql: `SELECT id, name, status, generation, is_control FROM creatives WHERE id = ?`,
    args: [body.creative_id],
  });

  if (targetRow.rows.length === 0) {
    return NextResponse.json({ error: "Creative not found" }, { status: 404 });
  }

  const target = targetRow.rows[0];
  const baseName = getAdBaseName(target.name as string);

  // ── 2. Encontrar todos os criativos deste AD group (feed + stories) ──
  // Usamos LIKE para capturar tanto T7EBMX-AD014F quanto T7EBMX-AD014S
  const groupRows = await db.execute({
    sql: `SELECT id, name FROM creatives WHERE name LIKE ? OR name LIKE ? OR name = ?`,
    args: [`${baseName}F%`, `${baseName}S%`, baseName],
  });

  const groupIds = groupRows.rows.map((r) => r.id as string);

  if (groupIds.length === 0) {
    return NextResponse.json({ error: "No creatives found for this AD group" }, { status: 404 });
  }

  // ── 3. Identificar o controle anterior ──
  const prevControlRow = await db.execute(`
    SELECT id, name FROM creatives
    WHERE is_control = TRUE
    ORDER BY created_at ASC
    LIMIT 1
  `);

  const previousControlId = prevControlRow.rows.length > 0
    ? (prevControlRow.rows[0].id as string)
    : null;

  // ── 4. Revogar is_control de todos; promover o AD group alvo ──
  await db.execute(`UPDATE creatives SET is_control = FALSE`);

  for (const id of groupIds) {
    await db.execute({
      sql: `UPDATE creatives SET is_control = TRUE, status = 'winner' WHERE id = ?`,
      args: [id],
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
      // edge pode já existir — não bloquear a promoção
      edgeId = null;
    }
  }

  // ── 6. Resolver alertas L5 do criativo promovido ──
  await db.execute({
    sql: `UPDATE alerts SET resolved = TRUE WHERE creative_id = ? AND level = 'L5' AND resolved = FALSE`,
    args: [body.creative_id],
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
export async function GET() {
  const db = getDb();

  const result = await db.execute(`
    SELECT c.id, c.name, c.generation, c.is_control, c.status,
      SUM(m.spend)  AS total_spend,
      SUM(m.leads)  AS total_leads,
      CASE WHEN SUM(m.leads) > 0 THEN SUM(m.spend) / SUM(m.leads) ELSE NULL END AS cpl
    FROM creatives c
    LEFT JOIN metrics m ON m.creative_id = c.id
    WHERE c.is_control = TRUE OR c.generation = 0
    GROUP BY c.id, c.name, c.generation, c.is_control, c.status
    ORDER BY c.is_control DESC, c.created_at ASC
    LIMIT 4
  `);

  return NextResponse.json({ controls: result.rows });
}
