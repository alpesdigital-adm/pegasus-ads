/**
 * GET /api/cron/collect  — Cron de coleta diária (Tarefa 2.6)
 *
 * Chamado pelo crond do container todos os dias (cron/crontab). Protegido
 * por CRON_SECRET no header Authorization: Bearer <secret>.
 *
 * Fluxo:
 * 1. Coleta insights padrão + breakdown para T7_0003_RAT (últimos 7 dias)
 * 2. Avalia kill rules para todos os criativos em teste
 * 3. Gera alertas de anomalia (kill triggers + CPL spike)
 * 4. Retorna sumário { collected, upserted, kills_triggered, alerts_created }
 *
 * MIGRADO NA FASE 1C (Wave 1):
 *  - getDb().execute() → dbAdmin (cross-workspace cron)
 *  - 6 queries CRUD em Drizzle typed query builder
 *  - 2 queries agregadas (testing creatives, control CPL) em sql``
 *    — JOIN + GROUP BY + HAVING complexos ficam mais legíveis como SQL
 *  - uuid() manual removido — schemas usam defaultRandom()
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getCampaignAdsInsights,
} from "@/lib/meta";
import { dbAdmin, sql } from "@/lib/db";
import {
  workspaceMetaAccounts,
  publishedAds,
  metrics,
  metricsBreakdowns,
  creatives,
  alerts,
} from "@/lib/db/schema";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { evaluateKillRules } from "@/config/kill-rules";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "/api/cron/collect" });

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

  const campaign = KNOWN_CAMPAIGNS["T7_0003_RAT"];
  const { from: dateFrom, to: dateTo } = getDateRange(7);
  const todayStr = today();

  // Resolve workspace_id from meta account linked to this campaign
  const wmaRow = await dbAdmin
    .select({ workspaceId: workspaceMetaAccounts.workspaceId })
    .from(workspaceMetaAccounts)
    .where(eq(workspaceMetaAccounts.metaAccountId, campaign.metaAccountId))
    .limit(1);

  if (wmaRow.length === 0) {
    return NextResponse.json(
      { error: "No workspace linked to campaign meta account" },
      { status: 500 },
    );
  }
  const workspaceId = wmaRow[0].workspaceId as string;

  const errors: string[] = [];
  let collected = 0;
  let upserted = 0;
  let skipped = 0;
  let breakdownUpserted = 0;
  let killsTriggered = 0;
  let alertsCreated = 0;

  // ── Mapa: meta_ad_id → creative_id ──
  async function buildAdMap(adIds: string[]): Promise<Map<string, string>> {
    if (adIds.length === 0) return new Map();
    const rows = await dbAdmin
      .select({
        metaAdId: publishedAds.metaAdId,
        creativeId: publishedAds.creativeId,
      })
      .from(publishedAds)
      .where(inArray(publishedAds.metaAdId, adIds));

    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.metaAdId && row.creativeId) {
        map.set(row.metaAdId, row.creativeId);
      }
    }
    return map;
  }

  try {
    // ════════════════════════════════════════════════════════════════
    // PASSO 1 — Coleta padrão de insights
    // ════════════════════════════════════════════════════════════════
    const insights = await getCampaignAdsInsights(
      campaign.metaCampaignId, dateFrom, dateTo, workspaceId,
    );
    collected = insights.length;
    log.info({ collected, dateFrom, dateTo }, "standard records collected");

    if (collected > 0) {
      const adIds = [...new Set(insights.map((r) => r.meta_ad_id).filter(Boolean) as string[])];
      const adMap = await buildAdMap(adIds);

      for (const insight of insights) {
        const creativeId = adMap.get(insight.meta_ad_id);
        if (!creativeId) { skipped++; continue; }

        try {
          await dbAdmin
            .insert(metrics)
            .values({
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

          // Promover creative de 'generated' → 'testing' ao começar a receber métricas
          await dbAdmin
            .update(creatives)
            .set({ status: "testing" })
            .where(
              and(
                eq(creatives.id, creativeId),
                eq(creatives.status, "generated"),
              ),
            );

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
        "publisher_platform,platform_position",
      );

      if (bkInsights.length > 0) {
        const adIds = [...new Set(bkInsights.map((r) => r.meta_ad_id).filter(Boolean) as string[])];
        const adMap = await buildAdMap(adIds);

        for (const insight of bkInsights) {
          const creativeId = adMap.get(insight.meta_ad_id);
          if (!creativeId) continue;

          const pubPlatform = insight.publisher_platform ?? "";
          const platPosition = insight.platform_position ?? "";

          try {
            await dbAdmin
              .insert(metricsBreakdowns)
              .values({
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
      // Aggregate query: todos os criativos em teste com métricas acumuladas.
      // JOIN + GROUP BY + HAVING — fica mais limpo como raw SQL.
      const testingCreativesResult = await dbAdmin.execute(sql`
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
      const testingCreatives = testingCreativesResult as unknown as Array<Record<string, unknown>>;

      // CPL do controle (generation=0) para comparação
      const controlRowResult = await dbAdmin.execute(sql`
        SELECT
          SUM(m.spend) / NULLIF(SUM(m.leads), 0) AS control_cpl
        FROM creatives c
        JOIN metrics m ON m.creative_id = c.id
        WHERE c.generation = 0
        GROUP BY c.id
        HAVING SUM(m.leads) > 0
        LIMIT 1
      `);
      const controlRow = controlRowResult as unknown as Array<Record<string, unknown>>;
      const controlCpl = controlRow[0]
        ? (Number(controlRow[0].control_cpl) || null)
        : null;

      const cplTarget = campaign.cplTarget;

      for (const row of testingCreatives) {
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
        const existing = await dbAdmin
          .select({ id: alerts.id })
          .from(alerts)
          .where(
            and(
              eq(alerts.creativeId, row.creative_id as string),
              eq(alerts.level, triggered.level),
              eq(alerts.date, todayStr),
              eq(alerts.resolved, false),
            ),
          )
          .limit(1);
        if (existing.length > 0) continue; // já existe, não duplicar

        const cplStr = metricsInput.cpl !== null
          ? `CPL atual: R$${metricsInput.cpl.toFixed(2)} (target: R$${cplTarget})`
          : `Spend: R$${metricsInput.spend.toFixed(2)} sem leads`;

        const message = `[${triggered.level}] ${triggered.name} — ${row.creative_name} — ${cplStr}`;

        await dbAdmin.insert(alerts).values({
          creativeId: row.creative_id as string,
          campaignKey: "T7_0003_RAT",
          date: todayStr,
          level: triggered.level,
          ruleName: triggered.name,
          message,
          spend: metricsInput.spend,
          cpl: metricsInput.cpl,
          cplTarget,
          resolved: false,
        });
        alertsCreated++;
      }
    } catch (err) {
      errors.push(`[kill-rules] ${err instanceof Error ? err.message : String(err)}`);
    }

    log.info(
      {
        collected,
        upserted,
        skipped,
        breakdown_upserted: breakdownUpserted,
        kills_triggered: killsTriggered,
        alerts_created: alertsCreated,
        errors: errors.length,
      },
      "cron run complete",
    );

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
    log.error({ err: message }, "fatal");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
