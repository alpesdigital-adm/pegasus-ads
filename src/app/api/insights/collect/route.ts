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
 * 2. Se breakdown solicitado (ou auto_breakdown=true) → upsert em `metrics_breakdowns`
 *    (uma linha por creative × date × publisher_platform × platform_position)
 *
 * Body JSON:
 * {
 *   campaign_id?:     string   // Meta campaign ID (padrão: T7_0003_RAT)
 *   account_id?:      string   // Meta account ID (alternativa ao campaign_id)
 *   date_from?:       string   // YYYY-MM-DD (padrão: 7 dias atrás)
 *   date_to?:         string   // YYYY-MM-DD (padrão: hoje)
 *   breakdown?:       string   // ex: "publisher_platform,platform_position"
 *   auto_breakdown?:  boolean  // Se true, também coleta breakdown de posicionamento
 *                              // automaticamente após a coleta padrão (padrão: true)
 * }
 *
 * Resposta:
 * {
 *   collected:            number       // registros buscados (coleta padrão)
 *   upserted:             number       // registros salvos em metrics
 *   skipped:              number       // ads sem creative_id vinculado
 *   breakdown_collected:  number       // registros buscados (com breakdown)
 *   breakdown_upserted:   number       // registros salvos em metrics_breakdowns
 *   errors:               string[]
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { getCampaignAdsInsights, getAccountAdsInsights } from "@/lib/meta";
import { getDb, initDb } from "@/lib/db";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";
export const maxDuration = 120;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDateRange(daysBack = 7): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { from: fmt(from), to: fmt(to) };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // initDb garante que metrics_breakdowns existe
  const db = await initDb();

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
  } catch {
    // body vazio é ok
  }

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

  // auto_breakdown padrão: true (coleta breakdown junto com padrão)
  const autoBreakdown = body.auto_breakdown !== false;
  // breakdown explícito: se informado, só coleta breakdown (não padrão)
  const explicitBreakdown = body.breakdown;
  // Se o usuário passou breakdown explícito, só coleta com breakdown
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

  // ── Mapa reutilizável: meta_ad_id → creative_id ──
  async function buildAdMap(adIds: string[]): Promise<Map<string, string>> {
    if (adIds.length === 0) return new Map();
    const rows = await db.execute({
      sql: `SELECT meta_ad_id, creative_id FROM published_ads WHERE meta_ad_id = ANY(ARRAY[${adIds.map(() => "?").join(",")}]::text[])`,
      args: adIds,
    });
    const map = new Map<string, string>();
    for (const row of rows.rows) {
      map.set(row.meta_ad_id as string, row.creative_id as string);
    }
    return map;
  }

  try {
    // ════════════════════════════════════════════════════════════════
    // 1. COLETA PADRÃO (sem breakdown) → tabela metrics
    // ════════════════════════════════════════════════════════════════
    if (collectStandard) {
      const insights = campaignId
        ? await getCampaignAdsInsights(campaignId, dateFrom, dateTo)
        : await getAccountAdsInsights(accountId!, dateFrom, dateTo);

      collected = insights.length;
      console.log(`[InsightsCollect] ${collected} registros da Meta API (padrão)`);

      if (collected > 0) {
        const adIds = [...new Set(insights.map((r) => r.meta_ad_id).filter(Boolean))];
        const adMap = await buildAdMap(adIds);
        console.log(`[InsightsCollect] ${adMap.size} ads vinculados a criativos`);

        for (const insight of insights) {
          const creativeId = adMap.get(insight.meta_ad_id);
          if (!creativeId) { skipped++; continue; }

          try {
            await db.execute({
              sql: `INSERT INTO metrics (id, creative_id, date, spend, impressions, cpm, ctr, clicks, cpc, leads, cpl, landing_page_views, meta_ad_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (creative_id, date) DO UPDATE SET
                      spend               = EXCLUDED.spend,
                      impressions         = EXCLUDED.impressions,
                      cpm                 = EXCLUDED.cpm,
                      ctr                 = EXCLUDED.ctr,
                      clicks              = EXCLUDED.clicks,
                      cpc                 = EXCLUDED.cpc,
                      leads               = EXCLUDED.leads,
                      cpl                 = EXCLUDED.cpl,
                      landing_page_views  = EXCLUDED.landing_page_views,
                      meta_ad_id          = COALESCE(EXCLUDED.meta_ad_id, metrics.meta_ad_id)`,
              args: [
                uuid(), creativeId, insight.date_start,
                insight.spend, insight.impressions, insight.cpm,
                insight.ctr, insight.clicks, insight.cpc,
                insight.leads, insight.cpl,
                insight.landing_page_views ?? 0,
                insight.meta_ad_id,
              ],
            });

            await db.execute({
              sql: `UPDATE creatives SET status = 'testing' WHERE id = ? AND status = 'generated'`,
              args: [creativeId],
            });

            upserted++;
          } catch (err) {
            errors.push(`[padrão] ad ${insight.meta_ad_id} (${insight.date_start}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════
    // 2. COLETA COM BREAKDOWN → tabela metrics_breakdowns
    // ════════════════════════════════════════════════════════════════
    if (collectBreakdown) {
      const breakdownInsights = campaignId
        ? await getCampaignAdsInsights(campaignId, dateFrom, dateTo, collectBreakdown)
        : await getAccountAdsInsights(accountId!, dateFrom, dateTo);

      breakdownCollected = breakdownInsights.length;
      console.log(`[InsightsCollect] ${breakdownCollected} registros da Meta API (breakdown: ${collectBreakdown})`);

      if (breakdownCollected > 0) {
        const adIds = [...new Set(breakdownInsights.map((r) => r.meta_ad_id).filter(Boolean))];
        const adMap = await buildAdMap(adIds);

        for (const insight of breakdownInsights) {
          const creativeId = adMap.get(insight.meta_ad_id);
          if (!creativeId) continue; // já contado como skipped no padrão

          const pubPlatform = insight.publisher_platform ?? "";
          const platPosition = insight.platform_position ?? "";

          try {
            await db.execute({
              sql: `INSERT INTO metrics_breakdowns
                      (id, creative_id, date, publisher_platform, platform_position,
                       spend, impressions, cpm, ctr, clicks, cpc, leads, cpl, meta_ad_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (creative_id, date, publisher_platform, platform_position) DO UPDATE SET
                      spend       = EXCLUDED.spend,
                      impressions = EXCLUDED.impressions,
                      cpm         = EXCLUDED.cpm,
                      ctr         = EXCLUDED.ctr,
                      clicks      = EXCLUDED.clicks,
                      cpc         = EXCLUDED.cpc,
                      leads       = EXCLUDED.leads,
                      cpl         = EXCLUDED.cpl,
                      meta_ad_id  = COALESCE(EXCLUDED.meta_ad_id, metrics_breakdowns.meta_ad_id)`,
              args: [
                uuid(), creativeId, insight.date_start,
                pubPlatform, platPosition,
                insight.spend, insight.impressions, insight.cpm,
                insight.ctr, insight.clicks, insight.cpc,
                insight.leads, insight.cpl, insight.meta_ad_id,
              ],
            });
            breakdownUpserted++;
          } catch (err) {
            errors.push(`[breakdown] ad ${insight.meta_ad_id} (${insight.date_start}, ${pubPlatform}/${platPosition}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    console.log(`[InsightsCollect] Concluído: upserted=${upserted} breakdown_upserted=${breakdownUpserted} skipped=${skipped} errors=${errors.length}`);

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

// GET: status rápido — sumário das tabelas de métricas
export async function GET() {
  const db = getDb();

  const [standard, breakdowns] = await Promise.all([
    db.execute(`
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
    db.execute(`
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

  return NextResponse.json({
    metrics: standard.rows[0],
    breakdowns: breakdowns.rows[0],
  });
}
