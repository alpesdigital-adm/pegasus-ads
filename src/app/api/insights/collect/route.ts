/**
 * POST /api/insights/collect
 *
 * Tarefa 2.1 — Coleta de insights via API
 *
 * Busca insights de todos os ads de uma campanha via Meta API e faz
 * upsert na tabela metrics do DB. Vincula cada ad ao creative_id
 * correspondente via tabela published_ads.
 *
 * Body JSON:
 * {
 *   campaign_id?:  string   // Meta campaign ID (padrão: T7_0003_RAT)
 *   account_id?:   string   // Meta account ID (alternativa ao campaign_id)
 *   date_from?:    string   // YYYY-MM-DD (padrão: 7 dias atrás)
 *   date_to?:      string   // YYYY-MM-DD (padrão: hoje)
 *   breakdown?:    string   // ex: "publisher_platform,platform_position"
 * }
 *
 * Resposta:
 * {
 *   collected: number       // registros buscados da Meta API
 *   upserted:  number       // registros salvos no DB
 *   skipped:   number       // ads sem creative_id vinculado
 *   errors:    string[]     // erros parciais (não interrompem a coleta)
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { getCampaignAdsInsights, getAccountAdsInsights } from "@/lib/meta";
import { getDb } from "@/lib/db";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";
export const maxDuration = 120; // coleta pode ser lenta para muitos ads

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
  const db = getDb();

  interface CollectBody {
    campaign_id?: string;
    account_id?: string;
    date_from?: string;
    date_to?: string;
    breakdown?: string;
  }
  const body: CollectBody = req.headers.get("content-type")?.includes("application/json")
    ? await req.json()
    : {};

  // Determinar período
  const defaultRange = getDateRange(7);
  const dateFrom = body.date_from || defaultRange.from;
  const dateTo = body.date_to || defaultRange.to;

  // Determinar campaign/account
  let campaignId = body.campaign_id;
  let accountId = body.account_id;

  if (!campaignId && !accountId) {
    // Padrão: campanha T7_0003_RAT
    const defaults = KNOWN_CAMPAIGNS["T7_0003_RAT"];
    campaignId = defaults.metaCampaignId;
    accountId = defaults.metaAccountId;
  }

  const errors: string[] = [];
  let collected = 0;
  let upserted = 0;
  let skipped = 0;

  try {
    // ── 1. Buscar insights da Meta API ──
    let insights;
    if (campaignId) {
      insights = await getCampaignAdsInsights(campaignId, dateFrom, dateTo, body.breakdown);
    } else {
      insights = await getAccountAdsInsights(accountId!, dateFrom, dateTo);
    }

    collected = insights.length;
    console.log(`[InsightsCollect] ${collected} registros recebidos da Meta API`);

    if (collected === 0) {
      return NextResponse.json({
        collected: 0,
        upserted: 0,
        skipped: 0,
        errors: [],
        note: `Nenhum dado retornado pela Meta API para o período ${dateFrom} → ${dateTo}.`,
      });
    }

    // ── 2. Mapear meta_ad_id → creative_id via published_ads ──
    // Buscar todos os published_ads de uma vez para evitar N+1
    const adIds = [...new Set(insights.map((r) => r.meta_ad_id).filter(Boolean))];

    const publishedRows = await db.execute({
      sql: `SELECT meta_ad_id, creative_id FROM published_ads WHERE meta_ad_id = ANY(ARRAY[${adIds.map(() => "?").join(",")}]::text[])`,
      args: adIds,
    });

    const adIdToCreativeId = new Map<string, string>();
    for (const row of publishedRows.rows) {
      adIdToCreativeId.set(row.meta_ad_id as string, row.creative_id as string);
    }

    console.log(`[InsightsCollect] ${adIdToCreativeId.size} ads vinculados a criativos`);

    // ── 3. Upsert na tabela metrics ──
    for (const insight of insights) {
      const creativeId = adIdToCreativeId.get(insight.meta_ad_id);

      if (!creativeId) {
        skipped++;
        continue;
      }

      try {
        const metricsId = uuid();
        await db.execute({
          sql: `INSERT INTO metrics (id, creative_id, date, spend, impressions, cpm, ctr, clicks, cpc, leads, cpl, meta_ad_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (creative_id, date) DO UPDATE SET
                  spend       = EXCLUDED.spend,
                  impressions = EXCLUDED.impressions,
                  cpm         = EXCLUDED.cpm,
                  ctr         = EXCLUDED.ctr,
                  clicks      = EXCLUDED.clicks,
                  cpc         = EXCLUDED.cpc,
                  leads       = EXCLUDED.leads,
                  cpl         = EXCLUDED.cpl,
                  meta_ad_id  = COALESCE(EXCLUDED.meta_ad_id, metrics.meta_ad_id)`,
          args: [
            metricsId,
            creativeId,
            insight.date_start,
            insight.spend,
            insight.impressions,
            insight.cpm,
            insight.ctr,
            insight.clicks,
            insight.cpc,
            insight.leads,
            insight.cpl,
            insight.meta_ad_id,
          ],
        });

        // Promover status do criativo para 'testing' se ainda 'generated'
        await db.execute({
          sql: `UPDATE creatives SET status = 'testing' WHERE id = ? AND status = 'generated'`,
          args: [creativeId],
        });

        upserted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`ad ${insight.meta_ad_id} (${insight.date_start}): ${msg}`);
      }
    }

    // ── 4. Log de resumo ──
    console.log(`[InsightsCollect] Concluído: collected=${collected} upserted=${upserted} skipped=${skipped} errors=${errors.length}`);

    return NextResponse.json({
      collected,
      upserted,
      skipped,
      errors: errors.slice(0, 20), // limitar erros na resposta
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

// GET: status rápido — quantos registros de métricas existem no DB
export async function GET() {
  const db = getDb();

  const result = await db.execute(`
    SELECT
      COUNT(*)                                       AS total_records,
      COUNT(DISTINCT creative_id)                    AS creatives_with_metrics,
      MIN(date)                                      AS oldest_date,
      MAX(date)                                      AS newest_date,
      SUM(spend)                                     AS total_spend,
      SUM(leads)                                     AS total_leads,
      ROUND(SUM(spend)::numeric / NULLIF(SUM(leads),0), 2) AS overall_cpl
    FROM metrics
  `);

  return NextResponse.json({ summary: result.rows[0] });
}
