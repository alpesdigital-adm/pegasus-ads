/**
 * /api/insights/demographics  — Tarefa 2.3: Breakdowns demográficos
 *
 * POST — Coleta insights com breakdown age × gender e faz upsert em metrics_demographics
 * GET  — Lê métricas demográficas agregadas por criativo
 */

import { NextRequest, NextResponse } from "next/server";
import { getCampaignAdsInsights } from "@/lib/meta";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { v4 as uuid } from "uuid";

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

  const db = getDb();

  interface Body {
    campaign_id?: string;
    date_from?: string;
    date_to?: string;
  }

  let body: Body = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      body = await req.json();
    }
  } catch { /* ok */ }

  const defaultRange = getDateRange(7);
  const dateFrom = body.date_from || defaultRange.from;
  const dateTo   = body.date_to   || defaultRange.to;
  const campaignId = body.campaign_id || KNOWN_CAMPAIGNS["T7_0003_RAT"].metaCampaignId;

  const insights = await getCampaignAdsInsights(campaignId, dateFrom, dateTo, auth.workspace_id, "age,gender");

  if (insights.length === 0) {
    return NextResponse.json({ collected: 0, upserted: 0, errors: [] });
  }

  // Mapa meta_ad_id → creative_id
  const adIds = [...new Set(insights.map((r) => r.meta_ad_id).filter(Boolean))];
  const adMapRows = await db.execute({
    sql: `SELECT meta_ad_id, creative_id FROM published_ads WHERE meta_ad_id = ANY(ARRAY[${adIds.map(() => "?").join(",")}]::text[]) AND workspace_id = ?`,
    args: [...adIds, auth.workspace_id],
  });
  const adMap = new Map<string, string>();
  for (const row of adMapRows.rows) {
    adMap.set(row.meta_ad_id as string, row.creative_id as string);
  }

  const errors: string[] = [];
  let upserted = 0;
  let skipped = 0;

  for (const insight of insights) {
    const creativeId = adMap.get(insight.meta_ad_id);
    if (!creativeId) { skipped++; continue; }

    const age    = insight.age    ?? "unknown";
    const gender = insight.gender ?? "unknown";

    try {
      await db.execute({
        sql: `INSERT INTO metrics_demographics
                (id, creative_id, date, age, gender,
                 spend, impressions, cpm, ctr, clicks, cpc, leads, cpl, meta_ad_id, workspace_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (creative_id, date, age, gender) DO UPDATE SET
                spend       = EXCLUDED.spend,
                impressions = EXCLUDED.impressions,
                cpm         = EXCLUDED.cpm,
                ctr         = EXCLUDED.ctr,
                clicks      = EXCLUDED.clicks,
                cpc         = EXCLUDED.cpc,
                leads       = EXCLUDED.leads,
                cpl         = EXCLUDED.cpl,
                meta_ad_id  = COALESCE(EXCLUDED.meta_ad_id, metrics_demographics.meta_ad_id)`,
        args: [
          uuid(), creativeId, insight.date_start, age, gender,
          insight.spend, insight.impressions, insight.cpm,
          insight.ctr, insight.clicks, insight.cpc,
          insight.leads, insight.cpl, insight.meta_ad_id,
          auth.workspace_id,
        ],
      });
      upserted++;
    } catch (err) {
      errors.push(`ad ${insight.meta_ad_id} (${age}/${gender}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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

  const db = getDb();
  const { searchParams } = req.nextUrl;
  const creativeId = searchParams.get("creative_id");
  const dateFrom   = searchParams.get("date_from");
  const dateTo     = searchParams.get("date_to");

  const conditions: string[] = ["md.workspace_id = ?"];
  const args: unknown[] = [auth.workspace_id];

  if (creativeId) {
    conditions.push(`md.creative_id = ?`);
    args.push(creativeId);
  }
  if (dateFrom) {
    conditions.push(`md.date >= ?`);
    args.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`md.date <= ?`);
    args.push(dateTo);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const result = await db.execute({
    sql: `
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
      ${whereClause}
      GROUP BY md.creative_id, c.name, md.age, md.gender
      ORDER BY md.creative_id, md.age, md.gender
    `,
    args,
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

  for (const row of result.rows) {
    const cid = row.creative_id as string;
    if (!byCreative[cid]) {
      byCreative[cid] = { name: row.creative_name as string, rows: [] };
    }
    byCreative[cid].rows.push({
      creative_id:   cid,
      creative_name: row.creative_name as string,
      age:           row.age as string,
      gender:        row.gender as string,
      spend:         Number(row.spend),
      impressions:   Number(row.impressions),
      leads:         Number(row.leads),
      cpl:           row.cpl !== null ? Number(row.cpl) : null,
      avg_ctr:       Number(row.avg_ctr),
      days:          Number(row.days),
    });
  }

  return NextResponse.json({
    creatives: Object.entries(byCreative).map(([id, data]) => ({
      creative_id:   id,
      creative_name: data.name,
      demographics:  data.rows,
    })),
    total_records: result.rows.length,
  });
}
