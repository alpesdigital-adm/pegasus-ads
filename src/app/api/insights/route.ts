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
 * MIGRADO NA FASE 1C (Wave 3):
 *  - getDb() → withWorkspace (RLS)
 *  - 3 aggregates em sql`` (ad-level, campaign-level, adset-level)
 *  - Filtros manuais workspace_id removidos (5 instâncias no legado)
 */

import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "/api/insights" });

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

  const { searchParams } = req.nextUrl;
  const level = searchParams.get("level") || "ad";
  const defaultRange = getDefaultRange();
  const dateFrom = searchParams.get("date_from") || defaultRange.from;
  const dateTo = searchParams.get("date_to") || defaultRange.to;
  const creativeId = searchParams.get("creative_id");

  try {
    if (level === "ad" || level === "creative") {
      const rows = await withWorkspace(auth.workspace_id, async (tx) => {
        const result = await tx.execute(sql`
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
          WHERE m.date >= ${dateFrom}
            AND m.date <= ${dateTo}
            ${creativeId ? sql`AND m.creative_id = ${creativeId}` : sql``}
          GROUP BY c.id, c.name, c.status, m.meta_ad_id
          ORDER BY total_spend DESC
        `);
        return result as unknown as Array<Record<string, unknown>>;
      });

      return NextResponse.json({
        level: "ad",
        period: { from: dateFrom, to: dateTo },
        count: rows.length,
        data: rows,
      });
    }

    if (level === "campaign") {
      const rows = await withWorkspace(auth.workspace_id, async (tx) => {
        const result = await tx.execute(sql`
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
          WHERE date >= ${dateFrom} AND date <= ${dateTo}
        `);
        return result as unknown as Array<Record<string, unknown>>;
      });

      return NextResponse.json({
        level: "campaign",
        period: { from: dateFrom, to: dateTo },
        data: rows[0],
      });
    }

    // ── Nível ad set — agrupado por published_ads ──
    const rows = await withWorkspace(auth.workspace_id, async (tx) => {
      const result = await tx.execute(sql`
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
        WHERE m.date >= ${dateFrom} AND m.date <= ${dateTo}
        GROUP BY pa.meta_adset_id, pa.adset_name
        ORDER BY total_spend DESC
      `);
      return result as unknown as Array<Record<string, unknown>>;
    });

    return NextResponse.json({
      level: "adset",
      period: { from: dateFrom, to: dateTo },
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro interno";
    log.error({ err: message }, "handler error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
