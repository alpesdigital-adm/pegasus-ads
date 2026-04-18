/**
 * /api/alerts  — Tarefa 2.9: Alertas de anomalia
 *
 * GET  — Lista alertas não resolvidos (com contagem para o bell)
 * POST — Resolve um alerta por ID (ou todos via resolve_all)
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (RLS enforça workspace_id)
 *  - JOIN com creatives via leftJoin do Drizzle
 *  - Aggregate counts (COUNT FILTER WHERE) em sql`` — mais legível que
 *    tentar replicar conditional aggregates do Drizzle
 */

import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { alerts, creatives } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";

// ── GET: listar alertas ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = req.nextUrl;
  const includeResolved = searchParams.get("include_resolved") === "true";
  const limit = parseInt(searchParams.get("limit") || "50", 10);

  const { alertsList, counts } = await withWorkspace(auth.workspace_id, async (tx) => {
    const list = await tx
      .select({
        id: alerts.id,
        creative_id: alerts.creativeId,
        creative_name: creatives.name,
        campaign_key: alerts.campaignKey,
        date: alerts.date,
        level: alerts.level,
        rule_name: alerts.ruleName,
        message: alerts.message,
        spend: alerts.spend,
        cpl: alerts.cpl,
        cpl_target: alerts.cplTarget,
        resolved: alerts.resolved,
        created_at: alerts.createdAt,
      })
      .from(alerts)
      .leftJoin(creatives, eq(creatives.id, alerts.creativeId))
      .where(includeResolved ? undefined : eq(alerts.resolved, false))
      .orderBy(desc(alerts.createdAt))
      .limit(limit);

    // Aggregate counts — keep as sql`` (FILTER clauses são mais claras assim)
    // RLS continua filtrando workspace_id automaticamente no tx.
    const countsResult = await tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE NOT resolved)                                AS unresolved,
        COUNT(*) FILTER (WHERE NOT resolved AND level IN ('L0','L1','L2')) AS critical,
        COUNT(*) FILTER (WHERE NOT resolved AND level IN ('L3','L4'))      AS warnings,
        COUNT(*) FILTER (WHERE NOT resolved AND level = 'L5')              AS promotions
      FROM alerts
    `);
    const countsArray = countsResult as unknown as Array<Record<string, unknown>>;

    return {
      alertsList: list,
      counts: countsArray[0] ?? { unresolved: 0, critical: 0, warnings: 0, promotions: 0 },
    };
  });

  return NextResponse.json({
    alerts: alertsList,
    counts,
  });
}

// ── POST: resolver alerta ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  interface Body {
    alert_id?: string;
    resolve_all?: boolean;
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch { /* ok */ }

  if (body.resolve_all) {
    await withWorkspace(auth.workspace_id, async (tx) => {
      await tx
        .update(alerts)
        .set({ resolved: true })
        .where(eq(alerts.resolved, false));
    });
    return NextResponse.json({ ok: true, action: "resolve_all" });
  }

  if (!body.alert_id) {
    return NextResponse.json({ error: "alert_id required" }, { status: 400 });
  }

  await withWorkspace(auth.workspace_id, async (tx) => {
    await tx
      .update(alerts)
      .set({ resolved: true })
      .where(eq(alerts.id, body.alert_id as string));
  });

  return NextResponse.json({ ok: true, alert_id: body.alert_id });
}
