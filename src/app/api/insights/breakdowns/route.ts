/**
 * GET /api/insights/breakdowns
 *
 * Tarefa 2.2 — Breakdowns por posicionamento
 *
 * Retorna análise de performance por publisher_platform × platform_position.
 * Permite comparar Instagram Feed vs Instagram Stories vs Facebook Feed, etc.
 *
 * Query params:
 *   creative_id?    - filtrar por criativo específico (ou AD base name)
 *   date_from?      - YYYY-MM-DD (padrão: 30 dias atrás)
 *   date_to?        - YYYY-MM-DD (padrão: hoje)
 *   group_by?       - "platform" | "position" | "both" (padrão: "both")
 *   cpl_target?     - número (padrão: 25)
 *
 * Resposta:
 * {
 *   period: { from, to }
 *   total_records: number
 *   breakdowns: [
 *     {
 *       publisher_platform: string       // ex: "instagram", "facebook"
 *       platform_position:  string       // ex: "feed", "reels", "story"
 *       total_spend:        number
 *       total_impressions:  number
 *       total_clicks:       number
 *       total_leads:        number
 *       avg_cpm:            number
 *       avg_ctr:            number
 *       cpl:                number | null
 *       spend_share:        number       // % do total gasto
 *       lead_share:         number       // % do total de leads
 *       cpl_vs_target:      number | null // CPL / cpl_target
 *     }
 *   ]
 *   by_creative?: [...]  // Se creative_id informado: detalhado por criativo
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";

const DEFAULT_CPL_TARGET = KNOWN_CAMPAIGNS["T7_0003_RAT"]?.cplTarget ?? 25;

function getDateRange(daysBack = 30): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { from: fmt(from), to: fmt(to) };
}

export async function GET(req: NextRequest) {
  const db = getDb();
  const { searchParams } = req.nextUrl;

  const creativeId = searchParams.get("creative_id");
  const defaultRange = getDateRange(30);
  const dateFrom = searchParams.get("date_from") || defaultRange.from;
  const dateTo = searchParams.get("date_to") || defaultRange.to;
  const groupBy = searchParams.get("group_by") || "both";
  const cplTarget = parseFloat(searchParams.get("cpl_target") || String(DEFAULT_CPL_TARGET));

  // ── 1. Verificar se há dados de breakdowns ──
  const countArgs: unknown[] = [dateFrom, dateTo];
  if (creativeId) countArgs.push(creativeId);

  const countRow = await db.execute({
    sql: `
      SELECT COUNT(*) AS total FROM metrics_breakdowns
      WHERE date BETWEEN ? AND ?
      ${creativeId ? "AND creative_id = ?" : ""}
    `,
    args: countArgs,
  });

  const totalRecords = Number((countRow.rows[0] as Record<string, unknown>)?.total ?? 0);

  if (totalRecords === 0) {
    return NextResponse.json({
      period: { from: dateFrom, to: dateTo },
      total_records: 0,
      breakdowns: [],
      note: "Nenhum dado de breakdown disponível. Execute POST /api/insights/collect para coletar dados.",
    });
  }

  // ── 2. Montar GROUP BY baseado em groupBy param ──
  let selectCols: string;
  let groupCols: string;

  if (groupBy === "platform") {
    selectCols = "publisher_platform, '' AS platform_position";
    groupCols = "publisher_platform";
  } else if (groupBy === "position") {
    selectCols = "'' AS publisher_platform, platform_position";
    groupCols = "platform_position";
  } else {
    // "both" (padrão)
    selectCols = "publisher_platform, platform_position";
    groupCols = "publisher_platform, platform_position";
  }

  const filterArgs: unknown[] = [dateFrom, dateTo];
  if (creativeId) filterArgs.push(creativeId);

  // ── 3. Aggregação por plataforma/posição ──
  const breakdownResult = await db.execute({
    sql: `
      SELECT
        ${selectCols},
        SUM(spend)                                                    AS total_spend,
        SUM(impressions)                                              AS total_impressions,
        SUM(clicks)                                                   AS total_clicks,
        SUM(leads)                                                    AS total_leads,
        AVG(cpm)                                                      AS avg_cpm,
        AVG(ctr)                                                      AS avg_ctr,
        COUNT(DISTINCT creative_id)                                   AS creative_count,
        COUNT(DISTINCT date)                                          AS days_count
      FROM metrics_breakdowns
      WHERE date BETWEEN ? AND ?
      ${creativeId ? "AND creative_id = ?" : ""}
      GROUP BY ${groupCols}
      ORDER BY total_spend DESC
    `,
    args: filterArgs,
  });

  // ── 4. Calcular totais para shares ──
  const grandTotalSpend = breakdownResult.rows.reduce(
    (acc, row) => acc + Number(row.total_spend ?? 0), 0
  );
  const grandTotalLeads = breakdownResult.rows.reduce(
    (acc, row) => acc + Number(row.total_leads ?? 0), 0
  );

  const breakdowns = breakdownResult.rows.map((row) => {
    const spend = Number(row.total_spend ?? 0);
    const leads = Number(row.total_leads ?? 0);
    const cpl = leads > 0 ? Math.round((spend / leads) * 100) / 100 : null;

    return {
      publisher_platform: (row.publisher_platform as string) || "(all)",
      platform_position: (row.platform_position as string) || "(all)",
      total_spend: Math.round(spend * 100) / 100,
      total_impressions: Number(row.total_impressions ?? 0),
      total_clicks: Number(row.total_clicks ?? 0),
      total_leads: leads,
      avg_cpm: Math.round(Number(row.avg_cpm ?? 0) * 100) / 100,
      avg_ctr: Math.round(Number(row.avg_ctr ?? 0) * 100) / 100,
      cpl,
      spend_share: grandTotalSpend > 0
        ? Math.round((spend / grandTotalSpend) * 10000) / 100
        : 0,
      lead_share: grandTotalLeads > 0
        ? Math.round((leads / grandTotalLeads) * 10000) / 100
        : 0,
      cpl_vs_target: cpl !== null
        ? Math.round((cpl / cplTarget) * 100) / 100
        : null,
      creative_count: Number(row.creative_count ?? 0),
      days_count: Number(row.days_count ?? 0),
    };
  });

  // ── 5. Opcional: detalhamento por criativo se creative_id específico ──
  let byCreative = undefined;
  if (creativeId) {
    const creativeResult = await db.execute({
      sql: `
        SELECT
          c.name AS creative_name,
          mb.publisher_platform,
          mb.platform_position,
          SUM(mb.spend)       AS total_spend,
          SUM(mb.impressions) AS total_impressions,
          SUM(mb.clicks)      AS total_clicks,
          SUM(mb.leads)       AS total_leads,
          AVG(mb.ctr)         AS avg_ctr
        FROM metrics_breakdowns mb
        JOIN creatives c ON c.id = mb.creative_id
        WHERE mb.creative_id = ?
          AND mb.date BETWEEN ? AND ?
        GROUP BY c.name, mb.publisher_platform, mb.platform_position
        ORDER BY total_spend DESC
      `,
      args: [creativeId, dateFrom, dateTo],
    });

    byCreative = creativeResult.rows.map((row) => {
      const spend = Number(row.total_spend ?? 0);
      const leads = Number(row.total_leads ?? 0);
      return {
        creative_name: row.creative_name,
        publisher_platform: row.publisher_platform,
        platform_position: row.platform_position,
        total_spend: Math.round(spend * 100) / 100,
        total_impressions: Number(row.total_impressions ?? 0),
        total_clicks: Number(row.total_clicks ?? 0),
        total_leads: leads,
        avg_ctr: Math.round(Number(row.avg_ctr ?? 0) * 100) / 100,
        cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
      };
    });
  }

  return NextResponse.json({
    period: { from: dateFrom, to: dateTo },
    cpl_target: cplTarget,
    total_records: totalRecords,
    group_by: groupBy,
    breakdowns,
    ...(byCreative ? { by_creative: byCreative } : {}),
  });
}
