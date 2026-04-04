/**
 * GET /api/insights
 *
 * Tarefa 2.1 — Métricas agregadas por criativo / ad set / campanha.
 *
 * Query params:
 *   level         = "ad" | "adset" | "campaign"  (padrão: "ad")
 *   campaign_id   = Meta campaign ID (opcional)
 *   date_from     = YYYY-MM-DD (padrão: 7 dias atrás)
 *   date_to       = YYYY-MM-DD (padrão: hoje)
 *   creative_id   = filtrar por criativo específico (opcional)
 *
 * Retorna métricas agregadas do DB local (não chama a Meta API).
 * Para coletar dados novos, usar POST /api/insights/collect.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";

function getDefaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 7);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { from: fmt(from), to: fmt(to) };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const db = getDb();
  const { searchParams } = req.nextUrl;

  const level = searchParams.get("level") || "ad";
  const defaultRange = getDefaultRange();
  const dateFrom = searchParams.get("date_from") || defaultRange.from;
  const dateTo = searchParams.get("date_to") || defaultRange.to;
  const creativeId = searchParams.get("creative_id");

  try {
    if (level === "ad" || level === "creative") {
      const whereClause = [
        `m.date >= ?`,
        `m.date <= ?`,
        `m.workspace_id = ?`,
        creativeId ? `m.creative_id = ?` : null,
      ].filter(Boolean).join(" AND ");

      const args: unknown[] = [dateFrom, dateTo, auth.workspace_id];
      if (creativeId) args.push(creativeId);

      const result = await db.execute({
        sql: `
          SELECT
            c.id                                                  AS creative_id,
            c.name                                                AS creative_name,
            c.status                                              AS creative_status,
            m.meta_ad_id,
            SUM(m.spend)                                          AS total_spend,
            SUM(m.impressions)                                    AS total_impressions,
            AVG(m.cpm)                                            AS avg_cpm,
            AVG(m.ctr)                                            AS avg_ctr,
            SUM(m.clicks)                                         AS total_clicks,
            AVG(m.cpc)                                            AS avg_cpc,
            SUM(m.leads)                                          AS total_leads,
            ROUND(SUM(m.spend)::numeric / NULLIF(SUM(m.leads),0), 2) AS cpl,
            MIN(m.date)                                           AS date_from,
            MAX(m.date)                                           AS date_to
          FROM metrics m
          JOIN creatives c ON c.id = m.creative_id
          WHERE ${whereClause}
          GROUP BY c.id, c.name, c.status, m.meta_ad_id
          ORDER BY total_spend DESC
        `,
        args,
      });

      return NextResponse.json({
        level: "ad",
        period: { from: dateFrom, to: dateTo },
        count: result.rows.length,
        data: result.rows,
      });
    }

    if (level === "campaign") {
      const result = await db.execute({
        sql: `
          SELECT
            SUM(spend)                                                    AS total_spend,
            SUM(impressions)                                              AS total_impressions,
            AVG(cpm)                                                      AS avg_cpm,
            AVG(ctr)                                                      AS avg_ctr,
            SUM(clicks)                                                   AS total_clicks,
            AVG(cpc)                                                      AS avg_cpc,
            SUM(leads)                                                    AS total_leads,
            ROUND(SUM(spend)::numeric / NULLIF(SUM(leads),0), 2)         AS cpl,
            COUNT(DISTINCT creative_id)                                   AS active_creatives,
            MIN(date)                                                     AS date_from,
            MAX(date)                                                     AS date_to
          FROM metrics
          WHERE date >= ? AND date <= ? AND workspace_id = ?
        `,
        args: [dateFrom, dateTo, auth.workspace_id],
      });

      return NextResponse.json({
        level: "campaign",
        period: { from: dateFrom, to: dateTo },
        data: result.rows[0],
      });
    }

    // ── Nível ad set — agrupado por meta_ad_id prefixo (adset via published_ads) ──
    const result = await db.execute({
      sql: `
        SELECT
          pa.meta_adset_id,
          pa.adset_name,
          SUM(m.spend)                                              AS total_spend,
          SUM(m.impressions)                                        AS total_impressions,
          AVG(m.cpm)                                                AS avg_cpm,
          AVG(m.ctr)                                                AS avg_ctr,
          SUM(m.clicks)                                             AS total_clicks,
          AVG(m.cpc)                                                AS avg_cpc,
          SUM(m.leads)                                              AS total_leads,
          ROUND(SUM(m.spend)::numeric / NULLIF(SUM(m.leads),0), 2) AS cpl,
          COUNT(DISTINCT m.creative_id)                             AS ads_count
        FROM metrics m
        JOIN published_ads pa ON pa.meta_ad_id = m.meta_ad_id
        WHERE m.date >= ? AND m.date <= ? AND m.workspace_id = ?
        GROUP BY pa.meta_adset_id, pa.adset_name
        ORDER BY total_spend DESC
      `,
      args: [dateFrom, dateTo, auth.workspace_id],
    });

    return NextResponse.json({
      level: "adset",
      period: { from: dateFrom, to: dateTo },
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro interno";
    console.error("[InsightsRoute]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
