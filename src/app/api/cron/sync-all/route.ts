/**
 * GET /api/cron/sync-all — Sync all T7 campaign insights + kill rules
 *
 * Called by crond every hour. Protegido por CRON_SECRET.
 *
 * Fluxo:
 * 1. Busca insights da conta inteira (filtro T7%) dos últimos 7 dias
 * 2. Upsert em classified_insights
 * 3. Avalia kill rules para ads ativos
 * 4. Gera alertas
 *
 * MIGRADO NA FASE 1C (POC — primeira rota raw SQL → Drizzle):
 *  - getDb().execute() → dbAdmin (BYPASSRLS, cross-workspace por design)
 *  - 6 queries CRUD usam Drizzle typed query builder
 *  - 1 query agregada (kill rules) mantém sql`` tagged template — JOIN/CASE/
 *    GROUP BY complexos ficam mais legíveis como SQL puro
 *  - uuid() manual removido — schemas usam defaultRandom()
 *
 * NOTE sobre cron + dbAdmin:
 *   Este route é um cron que observa TODAS as workspaces (hoje só RAT, mas
 *   por design). Usa dbAdmin (role pegasus_ads_admin, BYPASSRLS). Routes
 *   user-facing usam withWorkspace() + db (role pegasus_ads_app) e o RLS
 *   filtra por workspace automático.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccountAdsInsights } from "@/lib/meta";
import { dbAdmin, sql } from "@/lib/db";
import {
  workspaceMetaAccounts,
  classifiedInsights,
  publishedAds,
  metrics,
  alerts,
} from "@/lib/db/schema";
import { evaluateKillRules } from "@/config/kill-rules";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "/api/cron/sync-all" });

export const runtime = "nodejs";
export const maxDuration = 300;

const ACCOUNT_ID = "act_3601611403432716";
// NOTA: account_id/insight_id em classified_insights viraram UUID nullable
// na Fase 1B/migration 0003. Route passa NULL (coerência com sentinela
// legada de "sem ref") até Fase 2 substituir sync-all por fluxo com
// UPSERT em ad_insights primeiro.
const CPL_TARGET = 30;

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${cronSecret}`;
}

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

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { from: dateFrom, to: dateTo } = getDateRange(7);
  const todayStr = today();
  const errors: string[] = [];

  // Resolve workspace_id from meta account
  const wmaRow = await dbAdmin
    .select({ workspaceId: workspaceMetaAccounts.workspaceId })
    .from(workspaceMetaAccounts)
    .where(eq(workspaceMetaAccounts.metaAccountId, ACCOUNT_ID))
    .limit(1);

  if (wmaRow.length === 0) {
    return NextResponse.json({ error: "No workspace linked to account" }, { status: 500 });
  }
  const workspaceId = wmaRow[0].workspaceId as string;

  let totalFetched = 0;
  let upserted = 0;
  let killsTriggered = 0;
  let alertsCreated = 0;

  try {
    // ── 1. Fetch ALL insights from the account (all campaigns) ──
    const insights = await getAccountAdsInsights(
      ACCOUNT_ID,
      dateFrom,
      dateTo,
      workspaceId
    );
    totalFetched = insights.length;

    // Cast to any — getAccountAdsInsights returns extra fields not in AdInsightRecord type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t7Insights = (insights as any[]).filter((r) =>
      (r.campaign_name || "").startsWith("T7")
    );
    log.info(
      {
        totalFetched,
        t7: t7Insights.length,
        dateFrom,
        dateTo,
      },
      "fetched",
    );

    // ── 2. Upsert into classified_insights ──
    for (const row of t7Insights) {
      try {
        await dbAdmin
          .insert(classifiedInsights)
          .values({
            insightId: null,
            accountId: null,
            date: row.date_start,
            campaignId: row.meta_campaign_id || row.campaign_id || "",
            campaignName: row.campaign_name || "",
            adsetId: row.meta_adset_id || row.adset_id || "",
            adsetName: row.adset_name || "",
            adId: row.meta_ad_id || row.ad_id || "",
            adName: row.ad_name || "",
            spend: String(row.spend || 0),
            impressions: row.impressions || 0,
            linkClicks: row.inline_link_clicks || row.clicks || 0,
            landingPageViews: row.landing_page_views || 0,
            leads: row.leads || 0,
            effectiveStatus: row.effective_status || "ACTIVE",
          })
          .onConflictDoUpdate({
            target: [classifiedInsights.date, classifiedInsights.adId],
            set: {
              spend: sql`EXCLUDED.spend`,
              impressions: sql`EXCLUDED.impressions`,
              linkClicks: sql`EXCLUDED.link_clicks`,
              landingPageViews: sql`EXCLUDED.landing_page_views`,
              leads: sql`EXCLUDED.leads`,
              effectiveStatus: sql`EXCLUDED.effective_status`,
              campaignName: sql`EXCLUDED.campaign_name`,
              adsetName: sql`EXCLUDED.adset_name`,
              adName: sql`EXCLUDED.ad_name`,
            },
          });
        upserted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate")) {
          errors.push(`[upsert] ${row.ad_id}: ${msg}`);
        }
      }
    }

    // ── 3. Also upsert into metrics for mapped creatives ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adIds = [...new Set(t7Insights.map((r: any) => r.meta_ad_id || r.ad_id).filter(Boolean) as string[])];
    if (adIds.length > 0) {
      const pubAds = await dbAdmin
        .select({
          metaAdId: publishedAds.metaAdId,
          creativeId: publishedAds.creativeId,
        })
        .from(publishedAds)
        .where(inArray(publishedAds.metaAdId, adIds));

      const adMap = new Map<string, string>();
      for (const r of pubAds) {
        if (r.metaAdId && r.creativeId) {
          adMap.set(r.metaAdId, r.creativeId);
        }
      }

      for (const row of t7Insights) {
        const adId = (row.ad_id || row.meta_ad_id) as string;
        const creativeId = adMap.get(adId);
        if (!creativeId) continue;

        try {
          await dbAdmin
            .insert(metrics)
            .values({
              creativeId,
              date: row.date_start,
              spend: row.spend || 0,
              impressions: row.impressions || 0,
              cpm: row.cpm || 0,
              ctr: row.ctr || 0,
              clicks: row.clicks || 0,
              cpc: row.cpc || 0,
              leads: row.leads || 0,
              cpl: row.cpl ?? null,
              landingPageViews: row.landing_page_views || 0,
              metaAdId: adId,
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
              },
            });
        } catch { /* skip */ }
      }
    }

    // ── 4. Kill rules on active T7 ads ──
    // Aggregate query com CASE/SUM/GROUP BY fica mais legível como raw SQL.
    // Uso sql`` tagged template (auto-escaping, type-safe) em vez de
    // dbAdmin.execute(string) pra preservar segurança.
    try {
      const activeAdsResult = await dbAdmin.execute(sql`
        SELECT
          ad_id, ad_name, campaign_name, adset_name,
          SUM(CAST(spend AS FLOAT)) AS total_spend,
          SUM(impressions) AS total_impressions,
          SUM(link_clicks) AS total_clicks,
          SUM(leads) AS total_leads,
          CASE WHEN SUM(impressions) > 0
               THEN (CAST(SUM(link_clicks) AS FLOAT) / SUM(impressions) * 100)
               ELSE 0 END AS ctr,
          COUNT(DISTINCT date) AS days_count,
          CASE WHEN SUM(leads) > 0
               THEN (SUM(CAST(spend AS FLOAT)) / SUM(leads))
               ELSE NULL END AS cpl
        FROM classified_insights
        WHERE campaign_name LIKE 'T7%'
          AND effective_status = 'ACTIVE'
          AND date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY ad_id, ad_name, campaign_name, adset_name
      `);

      // postgres-js retorna array-like direto do .execute()
      const activeAds = activeAdsResult as unknown as Array<Record<string, unknown>>;

      // Find control CPL (menor CPL entre ads com >=5 leads)
      let controlCpl: number | null = null;
      for (const r of activeAds) {
        if (Number(r.total_leads) >= 5) {
          const cpl = Number(r.total_spend) / Number(r.total_leads);
          if (controlCpl === null || cpl < controlCpl) controlCpl = cpl;
        }
      }

      for (const row of activeAds) {
        const spend = Number(row.total_spend || 0);
        const leads = Number(row.total_leads || 0);
        const cpl = leads > 0 ? spend / leads : null;
        const impressions = Number(row.total_impressions || 0);
        const ctr = Number(row.ctr || 0);
        const daysRunning = Number(row.days_count || 0);

        const triggered = evaluateKillRules({
          spend, leads, cpl, impressions, ctr,
          cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
          daysRunning,
          cplTarget: CPL_TARGET,
          benchmarkExists: false,
          rolling5dCpl: null,
          spend3d: 0, leads3d: 0, cpl3d: null,
          spend7d: 0, leads7d: 0, cpl7d: null,
        });
        if (!triggered) continue;
        killsTriggered++;

        const campaignKey = `${row.campaign_name}::${row.ad_id}`;

        // Check existing alert — não recriar alerta do mesmo rule no mesmo dia
        const existing = await dbAdmin
          .select({ id: alerts.id })
          .from(alerts)
          .where(
            and(
              eq(alerts.campaignKey, campaignKey),
              eq(alerts.level, triggered.level),
              eq(alerts.date, todayStr),
              eq(alerts.resolved, false),
            ),
          )
          .limit(1);
        if (existing.length > 0) continue;

        const cplStr = cpl !== null
          ? `CPL: R$${cpl.toFixed(2)} (target: R$${CPL_TARGET})`
          : `Spend: R$${spend.toFixed(2)} sem leads`;
        const message = `[${triggered.level}] ${triggered.name} — ${row.ad_name} — ${cplStr}`;

        await dbAdmin.insert(alerts).values({
          campaignKey,
          date: todayStr,
          level: triggered.level,
          ruleName: triggered.name,
          message,
          spend,
          cpl,
          cplTarget: CPL_TARGET,
          resolved: false,
        });
        alertsCreated++;
      }
    } catch (err) {
      errors.push(`[kill-rules] ${err instanceof Error ? err.message : String(err)}`);
    }

    log.info(
      {
        fetched: totalFetched,
        upserted,
        kills: killsTriggered,
        alerts: alertsCreated,
        errors: errors.length,
      },
      "done",
    );

    return NextResponse.json({
      ok: true,
      fetched: totalFetched,
      t7_insights: t7Insights.length,
      upserted,
      kills_triggered: killsTriggered,
      alerts_created: alertsCreated,
      errors: errors.slice(0, 10),
      period: { from: dateFrom, to: dateTo },
      ran_at: new Date().toISOString(),
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error({ err: message }, "fatal");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
