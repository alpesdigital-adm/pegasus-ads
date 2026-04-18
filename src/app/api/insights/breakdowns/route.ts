/**
 * GET /api/insights/breakdowns
 *
 * Tarefa 2.2 — Breakdowns por posicionamento
 *
 * Retorna análise de performance por publisher_platform × platform_position.
 * Permite comparar Instagram Feed vs Instagram Stories vs Facebook Feed, etc.
 *
 * Query params:
 *   creative_id?    - filtrar por criativo específico
 *   date_from?      - YYYY-MM-DD (padrão: 30 dias atrás)
 *   date_to?        - YYYY-MM-DD (padrão: hoje)
 *   group_by?       - "platform" | "position" | "both" (padrão: "both")
 *   cpl_target?     - número (padrão: 25)
 *
 * MIGRADO NA FASE 1C (Wave 3):
 *  - getDb() → withWorkspace (RLS)
 *  - 3 aggregates em sql`` (count + main breakdown + optional by_creative)
 *  - Filtros manuais workspace_id removidos
 *  - GROUP BY dinâmico preservado via sql.raw() pattern
 */

import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
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
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = req.nextUrl;

  const creativeId = searchParams.get("creative_id");
  const defaultRange = getDateRange(30);
  const dateFrom = searchParams.get("date_from") || defaultRange.from;
  const dateTo = searchParams.get("date_to") || defaultRange.to;
  const groupBy = searchParams.get("group_by") || "both";
  const cplTarget = parseFloat(searchParams.get("cpl_target") || String(DEFAULT_CPL_TARGET));

  // Filtro opcional por creative_id — reusado nas duas queries principais
  const creativeFilter = creativeId ? sql`AND creative_id = ${creativeId}` : sql``;

  // GROUP BY dinâmico: constantes identificadas via groupBy param
  // (sql.raw não existe — uso sql`` com strings literais controladas).
  const { selectCols, groupCols } = (() => {
    if (groupBy === "platform") {
      return {
        selectCols: sql`publisher_platform, '' AS platform_position`,
        groupCols: sql`publisher_platform`,
      };
    }
    if (groupBy === "position") {
      return {
        selectCols: sql`'' AS publisher_platform, platform_position`,
        groupCols: sql`platform_position`,
      };
    }
    return {
      selectCols: sql`publisher_platform, platform_position`,
      groupCols: sql`publisher_platform, platform_position`,
    };
  })();

  const { totalRecords, breakdownRows, byCreativeRows } = await withWorkspace(
    auth.workspace_id,
    async (tx) => {
      // ── 1. Verificar se há dados de breakdowns ──
      const countResult = await tx.execute(sql`
        SELECT COUNT(*) AS total FROM metrics_breakdowns
        WHERE date BETWEEN ${dateFrom} AND ${dateTo}
        ${creativeFilter}
      `);
      const countRows = countResult as unknown as Array<Record<string, unknown>>;
      const total = Number(countRows[0]?.total ?? 0);

      if (total === 0) {
        return { totalRecords: 0, breakdownRows: [], byCreativeRows: null };
      }

      // ── 2. Aggregação por plataforma/posição ──
      const breakdownResult = await tx.execute(sql`
        SELECT
          ${selectCols},
          SUM(spend)                  AS total_spend,
          SUM(impressions)            AS total_impressions,
          SUM(clicks)                 AS total_clicks,
          SUM(leads)                  AS total_leads,
          AVG(cpm)                    AS avg_cpm,
          AVG(ctr)                    AS avg_ctr,
          COUNT(DISTINCT creative_id) AS creative_count,
          COUNT(DISTINCT date)        AS days_count
        FROM metrics_breakdowns
        WHERE date BETWEEN ${dateFrom} AND ${dateTo}
        ${creativeFilter}
        GROUP BY ${groupCols}
        ORDER BY total_spend DESC
      `);

      // ── 3. Opcional: detalhamento por criativo ──
      let byCreativeResult:
        | Array<Record<string, unknown>>
        | null = null;
      if (creativeId) {
        const cRes = await tx.execute(sql`
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
          WHERE mb.creative_id = ${creativeId}
            AND mb.date BETWEEN ${dateFrom} AND ${dateTo}
          GROUP BY c.name, mb.publisher_platform, mb.platform_position
          ORDER BY total_spend DESC
        `);
        byCreativeResult = cRes as unknown as Array<Record<string, unknown>>;
      }

      return {
        totalRecords: total,
        breakdownRows: breakdownResult as unknown as Array<Record<string, unknown>>,
        byCreativeRows: byCreativeResult,
      };
    },
  );

  if (totalRecords === 0) {
    return NextResponse.json({
      period: { from: dateFrom, to: dateTo },
      total_records: 0,
      breakdowns: [],
      note: "Nenhum dado de breakdown disponível. Execute POST /api/insights/collect para coletar dados.",
    });
  }

  // ── 4. Calcular totais para shares ──
  const grandTotalSpend = breakdownRows.reduce(
    (acc, row) => acc + Number(row.total_spend ?? 0), 0,
  );
  const grandTotalLeads = breakdownRows.reduce(
    (acc, row) => acc + Number(row.total_leads ?? 0), 0,
  );

  const breakdowns = breakdownRows.map((row) => {
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

  const byCreative = byCreativeRows
    ? byCreativeRows.map((row) => {
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
      })
    : undefined;

  return NextResponse.json({
    period: { from: dateFrom, to: dateTo },
    cpl_target: cplTarget,
    total_records: totalRecords,
    group_by: groupBy,
    breakdowns,
    ...(byCreative ? { by_creative: byCreative } : {}),
  });
}
