/**
 * /api/insights/demographics  — Tarefa 2.3: Breakdowns demográficos
 *
 * POST — Coleta insights com breakdown age × gender e upsert em metrics_demographics
 * GET  — Lê métricas demográficas agregadas por criativo
 *
 * MIGRADO NA FASE 1C (Wave 3):
 *  - getDb() → withWorkspace (RLS)
 *  - 3 queries tipadas em Drizzle (published_ads lookup, upsert, aggregate)
 *  - uuid() manual removido (defaultRandom cobre)
 */

import { NextRequest, NextResponse } from "next/server";
import { getCampaignAdsInsights } from "@/lib/meta";
import { withWorkspace, sql } from "@/lib/db";
import { publishedAds, metricsDemographics } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { inArray } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 120;

function getDateRange(daysBack = 7): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { from: fmt(from), to: fmt(to) };
}

// ── POST: Coleta demographics ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  interface Body { campaign_id?: string; date_from?: string; date_to?: string }
  let body: Body = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      body = await req.json();
    }
  } catch { /* ok */ }

  const defaultRange = getDateRange(7);
  const dateFrom = body.date_from || defaultRange.from;
  const dateTo = body.date_to || defaultRange.to;
  const campaignId = body.campaign_id || KNOWN_CAMPAIGNS["T7_0003_RAT"].metaCampaignId;

  const insights = await getCampaignAdsInsights(
    campaignId, dateFrom, dateTo, auth.workspace_id, "age,gender",
  );

  if (insights.length === 0) {
    return NextResponse.json({ collected: 0, upserted: 0, errors: [] });
  }

  const adIds = [...new Set(insights.map((r) => r.meta_ad_id).filter(Boolean) as string[])];

  const { upserted, skipped, errors } = await withWorkspace(
    auth.workspace_id,
    async (tx) => {
      // Mapa meta_ad_id → creative_id
      const adMapRows = await tx
        .select({
          metaAdId: publishedAds.metaAdId,
          creativeId: publishedAds.creativeId,
        })
        .from(publishedAds)
        .where(inArray(publishedAds.metaAdId, adIds));

      const adMap = new Map<string, string>();
      for (const row of adMapRows) {
        if (row.metaAdId && row.creativeId) {
          adMap.set(row.metaAdId, row.creativeId);
        }
      }

      const errs: string[] = [];
      let up = 0;
      let sk = 0;

      for (const insight of insights) {
        const creativeId = adMap.get(insight.meta_ad_id);
        if (!creativeId) { sk++; continue; }

        const age = insight.age ?? "unknown";
        const gender = insight.gender ?? "unknown";

        try {
          await tx
            .insert(metricsDemographics)
            .values({
              workspaceId: auth.workspace_id,
              creativeId,
              date: insight.date_start,
              age,
              gender,
              spend: insight.spend,
              impressions: insight.impressions,
              cpm: insight.cpm,
              ctr: insight.ctr,
              clicks: insight.clicks,
              cpc: insight.cpc,
              leads: insight.leads,
              cpl: insight.cpl,
              metaAdId: insight.meta_ad_id,
            })
            .onConflictDoUpdate({
              target: [
                metricsDemographics.creativeId,
                metricsDemographics.date,
                metricsDemographics.age,
                metricsDemographics.gender,
              ],
              set: {
                spend: sql`EXCLUDED.spend`,
                impressions: sql`EXCLUDED.impressions`,
                cpm: sql`EXCLUDED.cpm`,
                ctr: sql`EXCLUDED.ctr`,
                clicks: sql`EXCLUDED.clicks`,
                cpc: sql`EXCLUDED.cpc`,
                leads: sql`EXCLUDED.leads`,
                cpl: sql`EXCLUDED.cpl`,
                metaAdId: sql`COALESCE(EXCLUDED.meta_ad_id, metrics_demographics.meta_ad_id)`,
              },
            });
          up++;
        } catch (err) {
          errs.push(`ad ${insight.meta_ad_id} (${age}/${gender}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return { upserted: up, skipped: sk, errors: errs };
    },
  );

  return NextResponse.json({
    collected: insights.length,
    upserted,
    skipped,
    errors: errors.slice(0, 20),
    period: { from: dateFrom, to: dateTo },
  });
}

// ── GET: Lê métricas demográficas ────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = req.nextUrl;
  const creativeId = searchParams.get("creative_id");
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");

  const rows = await withWorkspace(auth.workspace_id, async (tx) => {
    // Filtros opcionais compostos como sql`` fragments
    const filters = [
      creativeId ? sql`AND md.creative_id = ${creativeId}` : sql``,
      dateFrom ? sql`AND md.date >= ${dateFrom}` : sql``,
      dateTo ? sql`AND md.date <= ${dateTo}` : sql``,
    ];

    const result = await tx.execute(sql`
      SELECT
        md.creative_id,
        c.name                                      AS creative_name,
        md.age,
        md.gender,
        SUM(md.spend)                               AS spend,
        SUM(md.impressions)                         AS impressions,
        SUM(md.leads)                               AS leads,
        CASE WHEN SUM(md.leads) > 0
          THEN ROUND((SUM(md.spend) / SUM(md.leads))::numeric, 2)
          ELSE NULL
        END                                         AS cpl,
        ROUND(AVG(md.ctr)::numeric, 3)              AS avg_ctr,
        COUNT(DISTINCT md.date)                     AS days
      FROM metrics_demographics md
      JOIN creatives c ON c.id = md.creative_id
      WHERE 1=1
        ${filters[0]}
        ${filters[1]}
        ${filters[2]}
      GROUP BY md.creative_id, c.name, md.age, md.gender
      ORDER BY md.creative_id, md.age, md.gender
    `);
    return result as unknown as Array<Record<string, unknown>>;
  });

  type DemoRow = {
    creative_id: string;
    creative_name: string;
    age: string;
    gender: string;
    spend: number;
    impressions: number;
    leads: number;
    cpl: number | null;
    avg_ctr: number;
    days: number;
  };

  const byCreative: Record<string, { name: string; rows: DemoRow[] }> = {};

  for (const row of rows) {
    const cid = row.creative_id as string;
    if (!byCreative[cid]) {
      byCreative[cid] = { name: row.creative_name as string, rows: [] };
    }
    byCreative[cid].rows.push({
      creative_id: cid,
      creative_name: row.creative_name as string,
      age: row.age as string,
      gender: row.gender as string,
      spend: Number(row.spend),
      impressions: Number(row.impressions),
      leads: Number(row.leads),
      cpl: row.cpl !== null ? Number(row.cpl) : null,
      avg_ctr: Number(row.avg_ctr),
      days: Number(row.days),
    });
  }

  return NextResponse.json({
    creatives: Object.entries(byCreative).map(([id, data]) => ({
      creative_id: id,
      creative_name: data.name,
      demographics: data.rows,
    })),
    total_records: rows.length,
  });
}
