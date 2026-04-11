/**
 * GET /api/campaigns/metrics?days=7
 *
 * Lista todas as campanhas T7 ativas com métricas agregadas do classified_insights.
 * Não depende da tabela campaigns — puxa direto dos dados reais da Meta.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const days = parseInt(req.nextUrl.searchParams.get("days") || "7", 10);

  try {
    const db = getDb();

    // Campaigns with aggregated metrics
    const result = await db.execute({
      sql: `
        SELECT
          campaign_id,
          campaign_name,
          COUNT(DISTINCT ad_id) AS total_ads,
          COUNT(DISTINCT CASE WHEN effective_status = 'ACTIVE' THEN ad_id END) AS active_ads,
          SUM(CAST(spend AS FLOAT)) AS total_spend,
          SUM(impressions) AS total_impressions,
          SUM(link_clicks) AS total_clicks,
          SUM(landing_page_views) AS total_lpv,
          SUM(leads) AS total_leads,
          CASE WHEN SUM(leads) > 0 THEN SUM(CAST(spend AS FLOAT)) / SUM(leads) ELSE NULL END AS cpl,
          CASE WHEN SUM(impressions) > 0 THEN (CAST(SUM(link_clicks) AS FLOAT) / SUM(impressions) * 100) ELSE 0 END AS ctr,
          CASE WHEN SUM(impressions) > 0 THEN (SUM(CAST(spend AS FLOAT)) / SUM(impressions) * 1000) ELSE 0 END AS cpm,
          CASE WHEN SUM(link_clicks) > 0 THEN (CAST(SUM(landing_page_views) AS FLOAT) / SUM(link_clicks) * 100) ELSE 0 END AS connect_rate,
          MIN(date) AS first_date,
          MAX(date) AS last_date,
          COUNT(DISTINCT date) AS days_active
        FROM classified_insights
        WHERE campaign_name LIKE 'T7%'
          AND date >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'
        GROUP BY campaign_id, campaign_name
        ORDER BY SUM(CAST(spend AS FLOAT)) DESC
      `,
      args: [days],
    });

    // CRM leads per campaign
    const crmResult = await db.execute({
      sql: `
        SELECT
          utm_campaign,
          COUNT(*) AS crm_leads,
          SUM(CASE WHEN is_qualified THEN 1 ELSE 0 END) AS crm_qualified
        FROM crm_leads
        WHERE workspace_id = ?
          AND subscribed_at >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'
        GROUP BY utm_campaign
      `,
      args: [auth.workspace_id, days],
    });

    // Build CRM map
    const crmMap = new Map<string, { leads: number; qualified: number }>();
    for (const r of crmResult.rows) {
      const key = (r.utm_campaign as string) || "";
      crmMap.set(key, {
        leads: Number(r.crm_leads || 0),
        qualified: Number(r.crm_qualified || 0),
      });
    }

    // Merge
    const campaigns = result.rows.map((row) => {
      const campName = (row.campaign_name as string) || "";
      const crm = crmMap.get(campName) || { leads: 0, qualified: 0 };
      const spend = Number(row.total_spend || 0);
      const crmCpl = crm.leads > 0 ? spend / crm.leads : null;

      return {
        campaign_id: row.campaign_id,
        campaign_name: campName,
        total_ads: Number(row.total_ads || 0),
        active_ads: Number(row.active_ads || 0),
        spend: Math.round(spend * 100) / 100,
        impressions: Number(row.total_impressions || 0),
        clicks: Number(row.total_clicks || 0),
        lpv: Number(row.total_lpv || 0),
        leads_meta: Number(row.total_leads || 0),
        leads_crm: crm.leads,
        leads_qualified: crm.qualified,
        cpl_meta: row.cpl ? Math.round(Number(row.cpl) * 100) / 100 : null,
        cpl_crm: crmCpl ? Math.round(crmCpl * 100) / 100 : null,
        ctr: Math.round(Number(row.ctr || 0) * 100) / 100,
        cpm: Math.round(Number(row.cpm || 0) * 100) / 100,
        connect_rate: Math.round(Number(row.connect_rate || 0) * 100) / 100,
        first_date: row.first_date,
        last_date: row.last_date,
        days_active: Number(row.days_active || 0),
      };
    });

    // Totals
    const totals = {
      spend: campaigns.reduce((s, c) => s + c.spend, 0),
      impressions: campaigns.reduce((s, c) => s + c.impressions, 0),
      clicks: campaigns.reduce((s, c) => s + c.clicks, 0),
      leads_meta: campaigns.reduce((s, c) => s + c.leads_meta, 0),
      leads_crm: campaigns.reduce((s, c) => s + c.leads_crm, 0),
      leads_qualified: campaigns.reduce((s, c) => s + c.leads_qualified, 0),
      total_ads: campaigns.reduce((s, c) => s + c.total_ads, 0),
      active_ads: campaigns.reduce((s, c) => s + c.active_ads, 0),
    };
    const totalCplMeta = totals.leads_meta > 0 ? Math.round(totals.spend / totals.leads_meta * 100) / 100 : null;
    const totalCplCrm = totals.leads_crm > 0 ? Math.round(totals.spend / totals.leads_crm * 100) / 100 : null;

    return NextResponse.json({
      days,
      campaigns,
      totals: { ...totals, cpl_meta: totalCplMeta, cpl_crm: totalCplCrm },
    });
  } catch (error) {
    console.error("[campaigns/metrics]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
