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
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccountAdsInsights } from "@/lib/meta";
import { getDb } from "@/lib/db";
import { evaluateKillRules } from "@/config/kill-rules";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";
export const maxDuration = 300;

const ACCOUNT_ID = "act_3601611403432716";
// NOTA: account_id/insight_id em classified_insights viraram UUID nullable
// na Fase 1B/migration 0003. Route passa NULL (coerência com sentinela
// legada de "sem ref") até Fase 1C refatorar para Drizzle + UPSERT em
// ad_insights primeiro.
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

  const db = getDb();
  const { from: dateFrom, to: dateTo } = getDateRange(7);
  const todayStr = today();
  const errors: string[] = [];

  // Resolve workspace_id from meta account
  const wmaRow = await db.execute({
    sql: `SELECT workspace_id FROM workspace_meta_accounts WHERE meta_account_id = ? LIMIT 1`,
    args: [ACCOUNT_ID],
  });
  if (wmaRow.rows.length === 0) {
    return NextResponse.json({ error: "No workspace linked to account" }, { status: 500 });
  }
  const workspaceId = wmaRow.rows[0].workspace_id as string;

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
    const t7Insights = (insights as any[]).filter((r) =>
      (r.campaign_name || "").startsWith("T7")
    );
    console.log(`[SyncAll] Fetched ${totalFetched} total, ${t7Insights.length} T7 insights (${dateFrom} → ${dateTo})`);

    // ── 2. Upsert into classified_insights ──
    for (const row of t7Insights) {
      try {
        await db.execute({
          sql: `INSERT INTO classified_insights (
                  insight_id, account_id, date, campaign_id, campaign_name, adset_id, adset_name,
                  ad_id, ad_name, spend, impressions, link_clicks, landing_page_views,
                  leads, effective_status
                ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (date, ad_id) DO UPDATE SET
                  spend = EXCLUDED.spend,
                  impressions = EXCLUDED.impressions,
                  link_clicks = EXCLUDED.link_clicks,
                  landing_page_views = EXCLUDED.landing_page_views,
                  leads = EXCLUDED.leads,
                  effective_status = EXCLUDED.effective_status,
                  campaign_name = EXCLUDED.campaign_name,
                  adset_name = EXCLUDED.adset_name,
                  ad_name = EXCLUDED.ad_name`,
          args: [
            row.date_start,
            row.meta_campaign_id || row.campaign_id || "",
            row.campaign_name || "",
            row.meta_adset_id || row.adset_id || "",
            row.adset_name || "",
            row.meta_ad_id || row.ad_id || "",
            row.ad_name || "",
            row.spend || 0,
            row.impressions || 0,
            row.inline_link_clicks || row.clicks || 0,
            row.landing_page_views || 0,
            row.leads || 0,
            row.effective_status || "ACTIVE",
          ],
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
    const adIds = [...new Set(t7Insights.map((r: any) => r.meta_ad_id || r.ad_id).filter(Boolean))];
    if (adIds.length > 0) {
      // Build ad->creative map
      const placeholders = adIds.map(() => "?").join(",");
      const pubAds = await db.execute({
        sql: `SELECT meta_ad_id, creative_id FROM published_ads WHERE meta_ad_id = ANY(ARRAY[${placeholders}]::text[])`,
        args: adIds,
      });
      const adMap = new Map<string, string>();
      for (const r of pubAds.rows) {
        adMap.set(r.meta_ad_id as string, r.creative_id as string);
      }

      for (const row of t7Insights) {
        const adId = row.ad_id || row.meta_ad_id;
        const creativeId = adMap.get(adId);
        if (!creativeId) continue;

        try {
          await db.execute({
            sql: `INSERT INTO metrics (id, creative_id, date, spend, impressions, cpm, ctr, clicks, cpc, leads, cpl, landing_page_views, meta_ad_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (creative_id, date) DO UPDATE SET
                    spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
                    cpm = EXCLUDED.cpm, ctr = EXCLUDED.ctr, clicks = EXCLUDED.clicks,
                    cpc = EXCLUDED.cpc, leads = EXCLUDED.leads, cpl = EXCLUDED.cpl,
                    landing_page_views = EXCLUDED.landing_page_views`,
            args: [
              uuid(), creativeId, row.date_start,
              row.spend || 0, row.impressions || 0, row.cpm || 0,
              row.ctr || 0, row.clicks || 0, row.cpc || 0,
              row.leads || 0, row.cpl || null,
              row.landing_page_views || 0, adId,
            ],
          });
        } catch { /* skip */ }
      }
    }

    // ── 4. Kill rules on active T7 ads ──
    try {
      const activeAds = await db.execute(`
        SELECT
          ad_id, ad_name, campaign_name, adset_name,
          SUM(CAST(spend AS FLOAT)) AS total_spend,
          SUM(impressions) AS total_impressions,
          SUM(link_clicks) AS total_clicks,
          SUM(leads) AS total_leads,
          CASE WHEN SUM(impressions) > 0 THEN (CAST(SUM(link_clicks) AS FLOAT) / SUM(impressions) * 100) ELSE 0 END AS ctr,
          COUNT(DISTINCT date) AS days_count,
          CASE WHEN SUM(leads) > 0 THEN (SUM(CAST(spend AS FLOAT)) / SUM(leads)) ELSE NULL END AS cpl
        FROM classified_insights
        WHERE campaign_name LIKE 'T7%'
          AND effective_status = 'ACTIVE'
          AND date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY ad_id, ad_name, campaign_name, adset_name
      `);

      // Find control CPL
      let controlCpl: number | null = null;
      for (const r of activeAds.rows) {
        if (Number(r.total_leads) >= 5) {
          const cpl = Number(r.total_spend) / Number(r.total_leads);
          if (controlCpl === null || cpl < controlCpl) controlCpl = cpl;
        }
      }

      for (const row of activeAds.rows) {
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
          benchmarkExists: false,  // Simplified: sync-all only checks L0-L2
          rolling5dCpl: null,
          spend3d: 0, leads3d: 0, cpl3d: null,
          spend7d: 0, leads7d: 0, cpl7d: null,
        });
        if (!triggered) continue;
        killsTriggered++;

        // Check existing alert
        const campaignKey = `${row.campaign_name}::${row.ad_id}`;
        const existing = await db.execute({
          sql: `SELECT id FROM alerts WHERE campaign_key = ? AND level = ? AND date = ? AND resolved = false LIMIT 1`,
          args: [campaignKey, triggered.level, todayStr],
        });
        if (existing.rows.length > 0) continue;

        const cplStr = cpl !== null
          ? `CPL: R$${cpl.toFixed(2)} (target: R$${CPL_TARGET})`
          : `Spend: R$${spend.toFixed(2)} sem leads`;
        const message = `[${triggered.level}] ${triggered.name} — ${row.ad_name} — ${cplStr}`;

        await db.execute({
          sql: `INSERT INTO alerts (id, campaign_key, date, level, rule_name, message, spend, cpl, cpl_target, resolved)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, false)`,
          args: [
            uuid(), `${row.campaign_name}::${row.ad_id}`, todayStr,
            triggered.level, triggered.name, message, spend, cpl, CPL_TARGET,
          ],
        });
        alertsCreated++;
      }
    } catch (err) {
      errors.push(`[kill-rules] ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`[SyncAll] Done: fetched=${totalFetched} upserted=${upserted} kills=${killsTriggered} alerts=${alertsCreated} errors=${errors.length}`);

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
    console.error("[SyncAll] Fatal:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
