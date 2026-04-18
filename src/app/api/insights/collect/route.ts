/**
 * POST /api/insights/collect
 *
 * Tarefas 2.1 + 2.2 — Coleta de insights + Breakdowns por posicionamento
 *
 * Busca insights de todos os ads de uma campanha via Meta API e faz
 * upsert nas tabelas de métricas do DB.
 *
 * Fluxo:
 * 1. Coleta padrão → upsert em `metrics` (uma linha por creative × date)
 * 2. Se breakdown solicitado (ou auto_breakdown=true) → upsert em
 *    `metrics_breakdowns` (uma linha por creative × date × publisher_platform
 *    × platform_position)
 *
 * Body JSON:
 * {
 *   campaign_id?:     string
 *   account_id?:      string
 *   date_from?:       string   (default: 7 dias atrás)
 *   date_to?:         string   (default: hoje)
 *   breakdown?:       string
 *   auto_breakdown?:  boolean  (default: true)
 * }
 *
 * MIGRADO NA FASE 1C (Wave 4):
 *  - getDb()/initDb() → withWorkspace/dbAdmin (RLS escopa metrics + breakdowns
 *    + published_ads via workspace_id)
 *  - Queries tipadas via Drizzle + onConflictDoUpdate
 *  - uuid() manual removido (defaultRandom no schema)
 *  - GET usa dbAdmin (sumário cross-workspace legado — mantido p/ compat)
 */

import { NextRequest, NextResponse } from "next/server";
import { getCampaignAdsInsights, getAccountAdsInsights } from "@/lib/meta";
import { withWorkspace, dbAdmin } from "@/lib/db";
import { metrics, metricsBreakdowns, publishedAds, creatives } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { and, eq, inArray, sql } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 120;

function getDateRange(daysBack = 7): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { from: fmt(from), to: fmt(to) };
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  interface CollectBody {
    campaign_id?: string;
    account_id?: string;
    date_from?: string;
    date_to?: string;
    breakdown?: string;
    auto_breakdown?: boolean;
  }

  let body: CollectBody = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      body = await req.json();
    }
  } catch { /* ok */ }

  const defaultRange = getDateRange(7);
  const dateFrom = body.date_from || defaultRange.from;
  const dateTo = body.date_to || defaultRange.to;

  let campaignId = body.campaign_id;
  let accountId = body.account_id;

  if (!campaignId && !accountId) {
    const defaults = KNOWN_CAMPAIGNS["T7_0003_RAT"];
    campaignId = defaults.metaCampaignId;
    accountId = defaults.metaAccountId;
  }

  const autoBreakdown = body.auto_breakdown !== false;
  const explicitBreakdown = body.breakdown;
  const collectStandard = !explicitBreakdown;
  const collectBreakdown = explicitBreakdown
    ? explicitBreakdown
    : autoBreakdown
    ? "publisher_platform,platform_position"
    : null;

  const errors: string[] = [];
  let collected = 0;
  let upserted = 0;
  let skipped = 0;
  let breakdownCollected = 0;
  let breakdownUpserted = 0;

  try {
    // ── 1. Coleta PADRÃO → metrics ────────────────────────────────────────
    if (collectStandard) {
      const insights = campaignId
        ? await getCampaignAdsInsights(campaignId, dateFrom, dateTo, auth.workspace_id)
        : await getAccountAdsInsights(accountId!, dateFrom, dateTo, auth.workspace_id);

      collected = insights.length;
      console.log(`[InsightsCollect] ${collected} registros Meta API (padrão)`);

      if (collected > 0) {
        const result = await withWorkspace(auth.workspace_id, async (tx) => {
          const adIds = [...new Set(insights.map((r) => r.meta_ad_id).filter(Boolean) as string[])];
          const adRows = await tx
            .select({ metaAdId: publishedAds.metaAdId, creativeId: publishedAds.creativeId })
            .from(publishedAds)
            .where(inArray(publishedAds.metaAdId, adIds));

          const adMap = new Map<string, string>();
          for (const row of adRows) {
            if (row.metaAdId && row.creativeId) adMap.set(row.metaAdId, row.creativeId);
          }
          console.log(`[InsightsCollect] ${adMap.size} ads vinculados a criativos`);

          let up = 0;
          let sk = 0;
          const errs: string[] = [];

          for (const insight of insights) {
            const creativeId = adMap.get(insight.meta_ad_id);
            if (!creativeId) { sk++; continue; }

            try {
              await tx
                .insert(metrics)
                .values({
                  workspaceId: auth.workspace_id,
                  creativeId,
                  date: insight.date_start,
                  spend: insight.spend,
                  impressions: insight.impressions,
                  cpm: insight.cpm,
                  ctr: insight.ctr,
                  clicks: insight.clicks,
                  cpc: insight.cpc,
                  leads: insight.leads,
                  cpl: insight.cpl,
                  landingPageViews: insight.landing_page_views ?? 0,
                  metaAdId: insight.meta_ad_id,
                })
                .onConflictDoUpdate({
                  target: [metrics.creativeId, metrics.date],
                  set: {
                    spend: sql`EXCLUDED.spend`,
                    impressions: sql`EXCLUDED.impressions`,
                    cpm: sql`EXCLUDED.cpm`,
                    ctr: sql`EXCLUDED.ctr`,
                    clicks: sql`EXCLUDED.clicks`,
                    cpc: sql`EXCLUDED.cpc`,
                    leads: sql`EXCLUDED.leads`,
                    cpl: sql`EXCLUDED.cpl`,
                    landingPageViews: sql`EXCLUDED.landing_page_views`,
                    metaAdId: sql`COALESCE(EXCLUDED.meta_ad_id, metrics.meta_ad_id)`,
                  },
                });

              // Promove creative generated → testing
              await tx
                .update(creatives)
                .set({ status: "testing" })
                .where(and(eq(creatives.id, creativeId), eq(creatives.status, "generated")));

              up++;
            } catch (err) {
              errs.push(`[padrão] ad ${insight.meta_ad_id} (${insight.date_start}): ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          return { up, sk, errs };
        });

        upserted = result.up;
        skipped = result.sk;
        errors.push(...result.errs);
      }
    }

    // ── 2. Coleta COM BREAKDOWN → metrics_breakdowns ──────────────────────
    if (collectBreakdown) {
      const breakdownInsights = campaignId
        ? await getCampaignAdsInsights(campaignId, dateFrom, dateTo, auth.workspace_id, collectBreakdown)
        : await getAccountAdsInsights(accountId!, dateFrom, dateTo, auth.workspace_id);

      breakdownCollected = breakdownInsights.length;
      console.log(`[InsightsCollect] ${breakdownCollected} registros Meta API (breakdown: ${collectBreakdown})`);

      if (breakdownCollected > 0) {
        const result = await withWorkspace(auth.workspace_id, async (tx) => {
          const adIds = [...new Set(breakdownInsights.map((r) => r.meta_ad_id).filter(Boolean) as string[])];
          const adRows = await tx
            .select({ metaAdId: publishedAds.metaAdId, creativeId: publishedAds.creativeId })
            .from(publishedAds)
            .where(inArray(publishedAds.metaAdId, adIds));

          const adMap = new Map<string, string>();
          for (const row of adRows) {
            if (row.metaAdId && row.creativeId) adMap.set(row.metaAdId, row.creativeId);
          }

          let bup = 0;
          const errs: string[] = [];

          for (const insight of breakdownInsights) {
            const creativeId = adMap.get(insight.meta_ad_id);
            if (!creativeId) continue; // contado como skipped na coleta padrão

            const pubPlatform = insight.publisher_platform ?? "";
            const platPosition = insight.platform_position ?? "";

            try {
              await tx
                .insert(metricsBreakdowns)
                .values({
                  workspaceId: auth.workspace_id,
                  creativeId,
                  date: insight.date_start,
                  publisherPlatform: pubPlatform,
                  platformPosition: platPosition,
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
                    metricsBreakdowns.creativeId,
                    metricsBreakdowns.date,
                    metricsBreakdowns.publisherPlatform,
                    metricsBreakdowns.platformPosition,
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
                    metaAdId: sql`COALESCE(EXCLUDED.meta_ad_id, metrics_breakdowns.meta_ad_id)`,
                  },
                });
              bup++;
            } catch (err) {
              errs.push(`[breakdown] ad ${insight.meta_ad_id} (${insight.date_start}, ${pubPlatform}/${platPosition}): ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          return { bup, errs };
        });

        breakdownUpserted = result.bup;
        errors.push(...result.errs);
      }
    }

    console.log(
      `[InsightsCollect] Concluído: upserted=${upserted} breakdown_upserted=${breakdownUpserted} skipped=${skipped} errors=${errors.length}`,
    );

    return NextResponse.json({
      collected,
      upserted,
      skipped,
      breakdown_collected: breakdownCollected,
      breakdown_upserted: breakdownUpserted,
      errors: errors.slice(0, 20),
      period: { from: dateFrom, to: dateTo },
      campaign_id: campaignId || null,
      account_id: accountId || null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[InsightsCollect] Erro fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── GET: sumário rápido das tabelas de métricas ─────────────────────────────
// Cross-workspace (legado de ops) — usa dbAdmin.
export async function GET() {
  const [standard, breakdowns] = await Promise.all([
    dbAdmin.execute(sql`
      SELECT
        COUNT(*)                                                    AS total_records,
        COUNT(DISTINCT creative_id)                                 AS creatives_with_metrics,
        MIN(date)                                                   AS oldest_date,
        MAX(date)                                                   AS newest_date,
        ROUND(SUM(spend)::numeric, 2)                              AS total_spend,
        SUM(leads)                                                  AS total_leads,
        ROUND(SUM(spend)::numeric / NULLIF(SUM(leads),0), 2)       AS overall_cpl
      FROM metrics
    `),
    dbAdmin.execute(sql`
      SELECT
        COUNT(*)                        AS total_records,
        COUNT(DISTINCT creative_id)     AS creatives_with_breakdowns,
        COUNT(DISTINCT publisher_platform) AS platforms,
        COUNT(DISTINCT platform_position)  AS positions,
        MIN(date)                       AS oldest_date,
        MAX(date)                       AS newest_date
      FROM metrics_breakdowns
    `),
  ]);

  const s = standard as unknown as Array<Record<string, unknown>>;
  const b = breakdowns as unknown as Array<Record<string, unknown>>;

  return NextResponse.json({
    metrics: s[0],
    breakdowns: b[0],
  });
}
