/**
 * GET /api/cron/collect  — Cron de coleta diária (Tarefa 2.6)
 *
 * Chamado automaticamente pela Vercel Cron todos os dias às 10h BRT (13:00 UTC).
 * Protegido por CRON_SECRET no header Authorization: Bearer <secret>.
 *
 * Fluxo:
 * 1. Coleta insights padrão + breakdown para T7_0003_RAT (últimos 7 dias)
 * 2. Avalia kill rules para todos os criativos em teste
 * 3. Gera alertas de anomalia (kill triggers + CPL spike)
 * 4. Retorna sumário { collected, upserted, kills_triggered, alerts_created }
 */

import { NextRequest, NextResponse } from "next/server";
import { getCampaignAdsInsights, extractLPVFromInsights, extractLeadsFromInsights, extractCPLFromInsights } from "@/lib/meta";
import { getDb } from "@/lib/db";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { evaluateKillRules } from "@/config/kill-rules";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 min — coleta + kill rules + alertas

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDateRange(daysBack = 7): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { from: fmt(from), to: fmt(to) };
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // sem secret configurado: permite (útil em dev)

  const auth = req.headers.get("authorization");
  return auth === `Bearer ${cronSecret}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const campaign = KNOWN_CAMPAIGNS["T7_0003_RAT"];
  const { from: dateFrom, to: dateTo } = getDateRange(7);
  const todayStr = today();

  // Resolve workspace_id from meta account linked to this campaign
  const wmaRow = await db.execute({
    sql: `SELECT workspace_id FROM workspace_meta_accounts WHERE meta_account_id = ? LIMIT 1`,
    args: [campaign.metaAccountId],
  });
  if (wmaRow.rows.length === 0) {
    return NextResponse.json({ error: "No workspace linked to campaign meta account" }, { status: 500 });
  }
  const workspaceId = wmaRow.rows[0].workspace_id as string;

  const errors: string[] = [];
  let collected = 0;
  let upserted = 0;
  let skipped = 0;
  let breakdownUpserted = 0;
  let killsTriggered = 0;
  let alertsCreated = 0;

  // ── 1. Mapa: meta_ad_id → creative_id ──
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
    // PASSO 1 — Coleta padrão de insights
    // ════════════════════════════════════════════════════════════════
    const insights = await getCampaignAdsInsights(campaign.metaCampaignId, dateFrom, dateTo, workspaceId);
    collected = insights.length;
    console.log(`[CronCollect] ${collected} registros padrão (${dateFrom} → ${dateTo})`);

    if (collected > 0) {
      const adIds = [...new Set(insights.map((r) => r.meta_ad_id).filter(Boolean))];
      const adMap = await buildAdMap(adIds);

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
          errors.push(`[padrão] ad ${insight.meta_ad_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════
    // PASSO 2 — Coleta com breakdown de posicionamento
    // ════════════════════════════════════════════════════════════════
    try {
      const bkInsights = await getCampaignAdsInsights(
        campaign.metaCampaignId, dateFrom, dateTo, workspaceId,
        "publisher_platform,platform_position"
      );

      if (bkInsights.length > 0) {
        const adIds = [...new Set(bkInsights.map((r) => r.meta_ad_id).filter(Boolean))];
        const adMap = await buildAdMap(adIds);

        for (const insight of bkInsights) {
          const creativeId = adMap.get(insight.meta_ad_id);
          if (!creativeId) continue;

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
            errors.push(`[breakdown] ad ${insight.meta_ad_id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      errors.push(`[breakdown-collect] ${err instanceof Error ? err.message : String(err)}`);
    }

    // ════════════════════════════════════════════════════════════════
    // PASSO 3 — Avaliar kill rules + gerar alertas
    // ════════════════════════════════════════════════════════════════
    try {
      // Buscar todos os criativos em teste com métricas acumuladas
      const testingCreatives = await db.execute(`
        SELECT
          c.id                                    AS creative_id,
          c.name                                  AS creative_name,
          SUM(m.spend)                            AS total_spend,
          SUM(m.leads)                            AS total_leads,
          SUM(m.impressions)                      AS total_impressions,
          AVG(m.ctr)                              AS avg_ctr,
          CASE WHEN SUM(m.leads) > 0
            THEN SUM(m.spend) / SUM(m.leads)
            ELSE NULL
          END                                     AS cpl,
          COUNT(DISTINCT m.date)                  AS days_running
        FROM creatives c
        JOIN metrics m ON m.creative_id = c.id
        WHERE c.status = 'testing'
        GROUP BY c.id, c.name
        HAVING SUM(m.spend) > 0
      `);

      // CPL do controle (generation=0) para comparação
      const controlRow = await db.execute(`
        SELECT
          SUM(m.spend) / NULLIF(SUM(m.leads), 0) AS control_cpl
        FROM creatives c
        JOIN metrics m ON m.creative_id = c.id
        WHERE c.generation = 0
        GROUP BY c.id
        HAVING SUM(m.leads) > 0
        LIMIT 1
      `);
      const controlCpl = controlRow.rows[0]
        ? (Number(controlRow.rows[0].control_cpl) || null)
        : null;

      const cplTarget = campaign.cplTarget;

      for (const row of testingCreatives.rows) {
        const metricsInput = {
          spend:       Number(row.total_spend),
          leads:       Number(row.total_leads),
          cpl:         row.cpl !== null ? Number(row.cpl) : null,
          impressions: Number(row.total_impressions),
          ctr:         Number(row.avg_ctr),
          cplTarget,
          controlCpl,
          daysRunning: Number(row.days_running),
        };

        const triggered = evaluateKillRules(metricsInput);
        if (!triggered) continue;

        killsTriggered++;

        // Verificar se já existe alerta não resolvido para esse creative + nível hoje
        const existing = await db.execute({
          sql: `SELECT id FROM alerts WHERE creative_id = ? AND level = ? AND date = ? AND resolved = false LIMIT 1`,
          args: [row.creative_id as string, triggered.level, todayStr],
        });
        if (existing.rows.length > 0) continue; // já existe, não duplicar

        const cplStr = metricsInput.cpl !== null
          ? `CPL atual: R$${metricsInput.cpl.toFixed(2)} (target: R$${cplTarget})`
          : `Spend: R$${metricsInput.spend.toFixed(2)} sem leads`;

        const message = `[${triggered.level}] ${triggered.name} — ${row.creative_name} — ${cplStr}`;

        await db.execute({
          sql: `INSERT INTO alerts (id, creative_id, campaign_key, date, level, rule_name, message, spend, cpl, cpl_target, resolved)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false)`,
          args: [
            uuid(),
            row.creative_id as string,
            "T7_0003_RAT",
            todayStr,
            triggered.level,
            triggered.name,
            message,
            metricsInput.spend,
            metricsInput.cpl,
            cplTarget,
          ],
        });
        alertsCreated++;
      }
    } catch (err) {
      errors.push(`[kill-rules] ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`[CronCollect] ✓ collected=${collected} upserted=${upserted} skipped=${skipped} breakdown_upserted=${breakdownUpserted} kills_triggered=${killsTriggered} alerts_created=${alertsCreated} errors=${errors.length}`);

    return NextResponse.json({
      ok: true,
      collected,
      upserted,
      skipped,
      breakdown_upserted: breakdownUpserted,
      kills_triggered: killsTriggered,
      alerts_created: alertsCreated,
      errors: errors.slice(0, 20),
      period: { from: dateFrom, to: dateTo },
      campaign: "T7_0003_RAT",
      ran_at: new Date().toISOString(),
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[CronCollect] Erro fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
