/**
 * GET /api/campaigns/[id]/drill?window=3d
 *
 * Kill rules drill-down usando classified_insights (local, sem Meta API).
 * Agrupa por adset → ads com métricas por janela.
 * CRM leads cruzados via (utm_content, utm_term).
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - classified_insights é global (sem workspace_id) → dbAdmin (BYPASSRLS)
 *  - crm_leads é workspace-scoped → withWorkspace (RLS)
 *  - 4 queries em classified_insights paralelas via Promise.all — as 3 derivadas
 *    (main + 3d + 7d) viravam sequenciais no legado; ganha latência aqui.
 *  - Queries em sql`` — CAST/CASE/GROUP BY são mais legíveis que Drizzle ORM
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { dbAdmin, withWorkspace, sql } from "@/lib/db";
import { evaluateKillRules, type KillRuleMetrics } from "@/config/kill-rules";

export const runtime = "nodejs";

type Window = "today" | "2d" | "3d" | "5d" | "7d";

function windowToDays(w: Window): number {
  switch (w) {
    case "today": return 0;
    case "2d": return 2;
    case "3d": return 3;
    case "5d": return 5;
    case "7d": return 7;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { id: campaignId } = await params;
  const windowParam = (req.nextUrl.searchParams.get("window") || "3d") as Window;
  const validWindows: Window[] = ["today", "2d", "3d", "5d", "7d"];
  if (!validWindows.includes(windowParam)) {
    return NextResponse.json({ error: `window invalido. Use: ${validWindows.join(", ")}` }, { status: 400 });
  }

  try {
    const daysBack = windowToDays(windowParam);

    // Date filters — usamos fragmentos sql`` para compor ternário
    const mainDateFilter = daysBack === 0
      ? sql`date = CURRENT_DATE`
      : sql`date >= CURRENT_DATE - (${daysBack}::INTEGER * INTERVAL '1 day')`;

    // ── classified_insights queries (GLOBAL → dbAdmin, em paralelo) ──
    const [adsRes, benchRes, w3dRes, w7dRes] = await Promise.all([
      // 1. Ads with metrics
      dbAdmin.execute(sql`
        SELECT
          ad_id,
          ad_name,
          adset_id,
          adset_name,
          campaign_name,
          MAX(effective_status) AS effective_status,
          SUM(CAST(spend AS FLOAT)) AS spend,
          SUM(impressions) AS impressions,
          SUM(link_clicks) AS clicks,
          SUM(landing_page_views) AS lpv,
          SUM(leads) AS leads_meta,
          CASE WHEN SUM(impressions) > 0 THEN (CAST(SUM(link_clicks) AS FLOAT) / SUM(impressions) * 100) ELSE 0 END AS ctr,
          CASE WHEN SUM(impressions) > 0 THEN (SUM(CAST(spend AS FLOAT)) / SUM(impressions) * 1000) ELSE 0 END AS cpm,
          COUNT(DISTINCT date) AS days_count
        FROM classified_insights
        WHERE campaign_id = ${campaignId}
          AND ${mainDateFilter}
        GROUP BY ad_id, ad_name, adset_id, adset_name, campaign_name
        ORDER BY SUM(CAST(spend AS FLOAT)) DESC
      `),
      // 5. Campaign-level rolling 5d CPL for benchmark
      dbAdmin.execute(sql`
        SELECT
          SUM(CAST(spend AS FLOAT)) AS total_spend,
          SUM(leads) AS total_leads
        FROM classified_insights
        WHERE campaign_id = ${campaignId}
          AND date >= CURRENT_DATE - INTERVAL '5 days'
      `),
      // 6a. Per-ad 3d window
      dbAdmin.execute(sql`
        SELECT ad_id, adset_id, SUM(CAST(spend AS FLOAT)) AS spend, SUM(leads) AS leads
        FROM classified_insights
        WHERE campaign_id = ${campaignId}
          AND date >= CURRENT_DATE - INTERVAL '3 days'
        GROUP BY ad_id, adset_id
      `),
      // 6b. Per-ad 7d window
      dbAdmin.execute(sql`
        SELECT ad_id, adset_id, SUM(CAST(spend AS FLOAT)) AS spend, SUM(leads) AS leads
        FROM classified_insights
        WHERE campaign_id = ${campaignId}
          AND date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY ad_id, adset_id
      `),
    ]);

    const adsRows = adsRes as unknown as Array<Record<string, unknown>>;
    const benchRows = benchRes as unknown as Array<Record<string, unknown>>;
    const w3dRows = w3dRes as unknown as Array<Record<string, unknown>>;
    const w7dRows = w7dRes as unknown as Array<Record<string, unknown>>;

    // Campaign name for CRM lookup
    let campaignName = "";
    if (adsRows.length > 0) {
      campaignName = (adsRows[0].campaign_name as string) || "";
    }

    // ── CRM leads (workspace-scoped → withWorkspace) ──
    const crmRows = await withWorkspace(auth.workspace_id, async (tx) => {
      const crmDateClause = daysBack === 0
        ? sql`AND subscribed_at >= CURRENT_DATE`
        : sql`AND subscribed_at >= CURRENT_DATE - (${daysBack}::INTEGER * INTERVAL '1 day')`;

      const res = await tx.execute(sql`
        SELECT
          utm_content,
          utm_term,
          ad_id AS resolved_ad_id,
          adset_id AS resolved_adset_id,
          COUNT(*) AS total_leads,
          SUM(CASE WHEN is_qualified THEN 1 ELSE 0 END) AS qualified_leads
        FROM crm_leads
        WHERE (utm_campaign LIKE ${"%" + campaignName + "%"} OR campaign_id = ${campaignId})
          ${crmDateClause}
        GROUP BY utm_content, utm_term, ad_id, adset_id
      `);
      return res as unknown as Array<Record<string, unknown>>;
    });

    // Build CRM map — strict matching only (no __ANY__ fallback to prevent cross-campaign leaks)
    const crmMap = new Map<string, { total: number; qualified: number }>();
    for (const r of crmRows) {
      const entry = { total: Number(r.total_leads || 0), qualified: Number(r.qualified_leads || 0) };
      // By names: (adName, adsetName) — primary key
      if (r.utm_content && r.utm_term) {
        crmMap.set(`${String(r.utm_content).toUpperCase()}||${String(r.utm_term).toUpperCase()}`, entry);
      }
      // By IDs: (adId, adsetId) — fallback when UTMs not resolved
      if (r.resolved_ad_id && r.resolved_adset_id) {
        crmMap.set(`ID:${r.resolved_ad_id}||${r.resolved_adset_id}`, entry);
      }
    }

    const hasCrmData = crmRows.length > 0;

    function resolveLeads(adName: string, adId: string, adsetName: string, adsetId: string) {
      if (!hasCrmData) return { leads: 0, qualified: 0, source: "meta" as const };
      const byName = crmMap.get(`${adName.toUpperCase()}||${adsetName.toUpperCase()}`);
      if (byName) return { leads: byName.total, qualified: byName.qualified, source: "crm" as const };
      const byId = crmMap.get(`ID:${adId}||${adsetId}`);
      if (byId) return { leads: byId.total, qualified: byId.qualified, source: "crm" as const };
      return { leads: 0, qualified: 0, source: "crm" as const };
    }

    // Benchmark
    const benchSpend = Number(benchRows[0]?.total_spend || 0);
    const benchLeads = Number(benchRows[0]?.total_leads || 0);
    const rolling5dCpl = benchLeads > 0 ? benchSpend / benchLeads : 0;

    const CPL_TARGET = 32.77; // CPL meta do planejamento (cenário realista)

    // Build window maps
    const w3dMap = new Map<string, { spend: number; leads: number }>();
    for (const r of w3dRows) {
      w3dMap.set(`${r.ad_id}||${r.adset_id}`, { spend: Number(r.spend || 0), leads: Number(r.leads || 0) });
    }
    const w7dMap = new Map<string, { spend: number; leads: number }>();
    for (const r of w7dRows) {
      w7dMap.set(`${r.ad_id}||${r.adset_id}`, { spend: Number(r.spend || 0), leads: Number(r.leads || 0) });
    }

    // Benchmark: exists ad with spend > 20× CPL meta & CPL ≤ CPL meta?
    let benchmarkExists = false;
    for (const row of adsRows) {
      const spend = Number(row.spend || 0);
      const crm = resolveLeads(
        row.ad_name as string, row.ad_id as string,
        row.adset_name as string, row.adset_id as string
      );
      const leads = hasCrmData ? crm.leads : Number(row.leads_meta || 0);
      if (leads > 0 && spend > CPL_TARGET * 20) {
        const cpl = spend / leads;
        if (cpl <= CPL_TARGET) {
          benchmarkExists = true;
          break;
        }
      }
    }

    // Build ads with kill rules
    const ads = [];
    let killCount = 0;
    let totalSpend = 0;
    let totalLeadsMeta = 0;
    let totalLeadsCrm = 0;
    let totalQualified = 0;
    let activeCount = 0;

    for (const row of adsRows) {
      const spend = Number(row.spend || 0);
      const impressions = Number(row.impressions || 0);
      const clicks = Number(row.clicks || 0);
      const ctr = Number(row.ctr || 0);
      const leadsMeta = Number(row.leads_meta || 0);
      const daysRunning = Number(row.days_count || 0);
      const effectiveStatus = (row.effective_status as string) || "UNKNOWN";
      const isActive = effectiveStatus === "ACTIVE";

      const crm = resolveLeads(
        row.ad_name as string, row.ad_id as string,
        row.adset_name as string, row.adset_id as string
      );

      const leadsForRules = hasCrmData ? crm.leads : leadsMeta;
      const cpl = leadsForRules > 0 ? spend / leadsForRules : null;
      const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;

      const cplQualified = crm.qualified > 0 ? spend / crm.qualified : null;
      const qualificationRate = crm.leads > 0 ? (crm.qualified / crm.leads) * 100 : null;

      const adKey = `${row.ad_id}||${row.adset_id}`;
      const w3d = w3dMap.get(adKey) || { spend: 0, leads: 0 };
      const w7d = w7dMap.get(adKey) || { spend: 0, leads: 0 };
      const leads3d = hasCrmData ? crm.leads : w3d.leads;
      const leads7d = hasCrmData ? crm.leads : w7d.leads;
      const cpl3d = leads3d > 0 ? w3d.spend / leads3d : null;
      const cpl7d = leads7d > 0 ? w7d.spend / leads7d : null;

      const killMetrics: KillRuleMetrics = {
        spend,
        leads: leadsForRules,
        cpl,
        impressions,
        ctr,
        cpm,
        daysRunning,
        cplTarget: CPL_TARGET,
        benchmarkExists,
        rolling5dCpl: rolling5dCpl > 0 ? rolling5dCpl : null,
        spend3d: w3d.spend,
        leads3d,
        cpl3d,
        spend7d: w7d.spend,
        leads7d,
        cpl7d,
      };
      const triggered = evaluateKillRules(killMetrics);

      if (triggered) killCount++;
      if (isActive) activeCount++;
      totalSpend += spend;
      totalLeadsMeta += leadsMeta;
      totalLeadsCrm += crm.leads;
      totalQualified += crm.qualified;

      ads.push({
        ad_id: row.ad_id,
        ad_name: row.ad_name,
        adset_id: row.adset_id,
        adset_name: row.adset_name,
        status: effectiveStatus,
        effective_status: effectiveStatus,
        spend: Math.round(spend * 100) / 100,
        impressions,
        clicks,
        ctr: Math.round(ctr * 100) / 100,
        cpm: Math.round(Number(row.cpm || 0) * 100) / 100,
        leads: leadsMeta,
        leads_crm: crm.leads,
        qualified_leads: crm.qualified,
        cpl: cpl ? Math.round(cpl * 100) / 100 : 0,
        cpl_qualified: cplQualified ? Math.round(cplQualified * 100) / 100 : null,
        cpl_meta: leadsMeta > 0 ? Math.round(spend / leadsMeta * 100) / 100 : null,
        qualification_rate: qualificationRate ? Math.round(qualificationRate * 100) / 100 : null,
        leads_source: hasCrmData ? "crm" : "meta",
        kill_rule: triggered ? { level: triggered.level, name: triggered.name, action: triggered.action, recoveryPotential: triggered.recoveryPotential || null } : null,
      });
    }

    const totalCplQualified = totalQualified > 0 ? totalSpend / totalQualified : null;
    const totalQualificationRate = totalLeadsCrm > 0 ? (totalQualified / totalLeadsCrm) * 100 : null;

    return NextResponse.json({
      campaign_id: campaignId,
      campaign_name: campaignName,
      window: windowParam,
      cpl_target: CPL_TARGET,
      benchmark_exists: benchmarkExists,
      leads_source: hasCrmData ? "crm" : "meta",
      rolling_5d_cpl: Math.round(rolling5dCpl * 100) / 100,
      total_ads: adsRows.length,
      active_ads: activeCount,
      kill_candidates: killCount,
      total_spend: Math.round(totalSpend * 100) / 100,
      total_leads: totalLeadsMeta,
      total_leads_crm: totalLeadsCrm,
      total_qualified_leads: totalQualified,
      total_cpl_qualified: totalCplQualified ? Math.round(totalCplQualified * 100) / 100 : null,
      total_qualification_rate: totalQualificationRate ? Math.round(totalQualificationRate * 100) / 100 : null,
      ads,
    });
  } catch (error) {
    console.error("[campaign/drill]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
