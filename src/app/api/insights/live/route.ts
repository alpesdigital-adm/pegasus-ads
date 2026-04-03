/**
 * GET /api/insights/live?campaign_id=xxx&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 *
 * Chama a Meta API diretamente e retorna insights de todos os ads — sem
 * depender de vínculo com o DB do Pegasus. Útil para ads criados fora
 * do sistema ou antes do Pegasus existir.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const META_API = "https://graph.facebook.com/v25.0";
const DEFAULT_CAMPAIGN = "120242407847250521"; // T7__0003

function getToken(): string {
  const t = process.env.META_SYSTEM_USER_TOKEN;
  if (!t) throw new Error("META_SYSTEM_USER_TOKEN not set");
  return t;
}

interface MetaAction { action_type: string; value: string }
interface MetaInsight {
  spend?: string; impressions?: string; cpm?: string; ctr?: string;
  clicks?: string; cpc?: string; reach?: string; frequency?: string;
  actions?: MetaAction[]; cost_per_action_type?: MetaAction[];
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const campaignId = sp.get("campaign_id") || DEFAULT_CAMPAIGN;
  const dateFrom = sp.get("date_from") || "2026-03-01";
  const dateTo = sp.get("date_to") || new Date().toISOString().slice(0, 10);

  try {
    const token = getToken();

    // 1. Buscar todos os ads da campanha (via level=ad no insight da campanha)
    const fields = "ad_id,ad_name,adset_name,spend,impressions,cpm,ctr,clicks,cpc,reach,frequency,actions,cost_per_action_type";
    const timeRange = JSON.stringify({ since: dateFrom, until: dateTo });

    const url = `${META_API}/act_3601611403432716/insights?level=ad&campaign_ids=["${campaignId}"]&fields=${fields}&time_range=${timeRange}&limit=200&access_token=${token}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json();
      return NextResponse.json({ error: err }, { status: res.status });
    }

    const raw = (await res.json()) as { data?: MetaInsight[] };
    const rows = raw.data || [];

    // 2. Calcular métricas derivadas
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ads = rows.map((r: any) => {
      const spend = parseFloat((r.spend as string) || "0");
      const impressions = parseInt((r.impressions as string) || "0");
      const clicks = parseInt((r.clicks as string) || "0");

      const actions = (r.actions as MetaAction[]) || [];
      const costs = (r.cost_per_action_type as MetaAction[]) || [];

      const leads = parseInt(actions.find(a => a.action_type === "lead")?.value || "0");
      const linkClicks = parseInt(actions.find(a => a.action_type === "link_click")?.value || "0");
      const lpViews = parseInt(actions.find(a => a.action_type === "landing_page_view")?.value || "0");
      const cpl = leads > 0 ? Math.round((spend / leads) * 100) / 100 : null;
      const connectRate = linkClicks > 0 ? Math.round((lpViews / linkClicks) * 1000) / 10 : null;
      const convRate = lpViews > 0 ? Math.round((leads / lpViews) * 1000) / 10 : null;

      return {
        ad_name: r.ad_name as string,
        ad_id: r.ad_id as string,
        adset_name: r.adset_name as string,
        spend,
        impressions,
        clicks,
        link_clicks: linkClicks,
        lp_views: lpViews,
        leads,
        cpl,
        cpm: Math.round(parseFloat((r.cpm as string) || "0") * 100) / 100,
        ctr: Math.round(parseFloat((r.ctr as string) || "0") * 100) / 100,
        connect_rate: connectRate,
        conv_rate: convRate,
      };
    });

    // Ordenar por CPL (melhor primeiro)
    ads.sort((a, b) => {
      if (a.cpl === null && b.cpl === null) return (b.spend - a.spend);
      if (a.cpl === null) return 1;
      if (b.cpl === null) return -1;
      return a.cpl - b.cpl;
    });

    const totalSpend = Math.round(ads.reduce((s, a) => s + a.spend, 0) * 100) / 100;
    const totalLeads = ads.reduce((s, a) => s + a.leads, 0);

    return NextResponse.json({
      campaign_id: campaignId,
      period: { from: dateFrom, to: dateTo },
      total_ads: ads.length,
      total_spend: totalSpend,
      total_leads: totalLeads,
      avg_cpl: totalLeads > 0 ? Math.round((totalSpend / totalLeads) * 100) / 100 : null,
      ads,
    });
  } catch (err) {
    console.error("[InsightsLive]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
