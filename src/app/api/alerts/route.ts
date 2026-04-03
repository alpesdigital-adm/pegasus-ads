/**
 * /api/alerts  — Tarefa 2.9: Alertas de anomalia
 *
 * GET  — Lista alertas não resolvidos (com contagem para o bell)
 * POST — Resolve um alerta por ID
 *        body: { alert_id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb, initDb } from "@/lib/db";

export const runtime = "nodejs";

// ── GET: listar alertas ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const db = getDb();
  const { searchParams } = req.nextUrl;
  const includeResolved = searchParams.get("include_resolved") === "true";
  const limit = parseInt(searchParams.get("limit") || "50", 10);

  const whereClause = includeResolved ? "" : "WHERE a.resolved = false";

  const result = await db.execute({
    sql: `
      SELECT
        a.id,
        a.creative_id,
        c.name    AS creative_name,
        a.campaign_key,
        a.date,
        a.level,
        a.rule_name,
        a.message,
        a.spend,
        a.cpl,
        a.cpl_target,
        a.resolved,
        a.created_at
      FROM alerts a
      LEFT JOIN creatives c ON c.id = a.creative_id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ?
    `,
    args: [limit],
  });

  // Contagem por severidade (para badge no bell)
  const counts = await db.execute(`
    SELECT
      COUNT(*) FILTER (WHERE NOT resolved)               AS unresolved,
      COUNT(*) FILTER (WHERE NOT resolved AND level IN ('L0','L1','L2')) AS critical,
      COUNT(*) FILTER (WHERE NOT resolved AND level IN ('L3','L4'))      AS warnings,
      COUNT(*) FILTER (WHERE NOT resolved AND level = 'L5')              AS promotions
    FROM alerts
  `);

  return NextResponse.json({
    alerts: result.rows,
    counts: counts.rows[0] || { unresolved: 0, critical: 0, warnings: 0, promotions: 0 },
  });
}

// ── POST: resolver alerta ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const db = await initDb();

  interface Body {
    alert_id?: string;
    resolve_all?: boolean;
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch { /* ok */ }

  if (body.resolve_all) {
    await db.execute(`UPDATE alerts SET resolved = true WHERE resolved = false`);
    return NextResponse.json({ ok: true, action: "resolve_all" });
  }

  if (!body.alert_id) {
    return NextResponse.json({ error: "alert_id required" }, { status: 400 });
  }

  await db.execute({
    sql: `UPDATE alerts SET resolved = true WHERE id = ?`,
    args: [body.alert_id],
  });

  return NextResponse.json({ ok: true, alert_id: body.alert_id });
}
