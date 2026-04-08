/**
 * GET /api/ads/kill-rule?campaign_id=XXX[&window=lifetime|3d|7d]
 *
 * Puxa TODOS os ads ativos de uma campanha com métricas (spend, leads, CPL, CPM,
 * impressions) e aplica as 6 camadas de kill rule automaticamente.
 *
 * O parâmetro `window` controla a janela temporal usada para decisão:
 *   - lifetime (default): usa dados acumulados desde o início
 *   - 3d: usa apenas dados dos últimos 3 dias
 *   - 7d: usa apenas dados dos últimos 7 dias
 *
 * Retorna lista de ads com veredito por camada.
 *
 * Protegido por x-api-key.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 120;

const META_API = "https://graph.facebook.com/v25.0";
const CPL_META = 32.77; // T7 cenário realista

interface AdInsight {
  ad_id: string;
  ad_name: string;
  adset_id: string;
  adset_name: string;
  status: string;
  effective_status: string;
  adset_status: string;
  spend: number;
  leads: number;
  cpl: number;
  cpm: number;
  impressions: number;
  ctr: number;
  clicks: number;
  // 3d and 7d windows
  spend_3d: number;
  leads_3d: number;
  cpl_3d: number;
  spend_7d: number;
  leads_7d: number;
  cpl_7d: number;
  // Kill rule result
  kill_layer: string | null;
  kill_reason: string | null;
}

async function fetchAllPages<T>(url: string): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const response: Response = await fetch(nextUrl);
    const data: { data?: T[]; paging?: { next?: string } } = await response.json();
    if (data.data) results.push(...data.data);
    nextUrl = data.paging?.next || null;
  }

  return results;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const campaignId = req.nextUrl.searchParams.get("campaign_id");
  if (!campaignId) {
    return NextResponse.json({ error: "campaign_id required" }, { status: 400 });
  }

  const windowParam = req.nextUrl.searchParams.get("window") || "lifetime";
  if (!["lifetime", "3d", "7d"].includes(windowParam)) {
    return NextResponse.json({ error: "window must be lifetime, 3d, or 7d" }, { status: 400 });
  }

  try {
    const token = await getTokenForWorkspace(auth.workspace_id);

    // 1. Get all ads from campaign (all statuses for context)
    // effective_status reflects ad + adset + campaign status combined
    const adsUrl = `${META_API}/${campaignId}/ads?fields=id,name,status,effective_status,adset_id,adset{name,status,effective_status}&limit=200&access_token=${token}`;
    const allAds = await fetchAllPages<Record<string, unknown>>(adsUrl);

    console.log(`[KillRule] Found ${allAds.length} total ads in campaign`);

    // 2. Get lifetime insights for all ads
    const insightsUrl = `${META_API}/${campaignId}/insights?fields=ad_id,ad_name,adset_id,adset_name,spend,impressions,clicks,ctr,cpm,actions&level=ad&limit=500&time_range={"since":"2026-01-01","until":"2026-12-31"}&access_token=${token}`;
    const lifetimeInsights = await fetchAllPages<Record<string, unknown>>(insightsUrl);

    // 3. Get 3-day insights
    const now = new Date();
    const d3 = new Date(now);
    d3.setDate(d3.getDate() - 3);
    const d7 = new Date(now);
    d7.setDate(d7.getDate() - 7);
    const today = now.toISOString().split("T")[0];
    const since3d = d3.toISOString().split("T")[0];
    const since7d = d7.toISOString().split("T")[0];

    const insights3dUrl = `${META_API}/${campaignId}/insights?fields=ad_id,spend,actions&level=ad&limit=500&time_range={"since":"${since3d}","until":"${today}"}&access_token=${token}`;
    const insights3d = await fetchAllPages<Record<string, unknown>>(insights3dUrl);

    // 4. Get 7-day insights
    const insights7dUrl = `${META_API}/${campaignId}/insights?fields=ad_id,spend,actions&level=ad&limit=500&time_range={"since":"${since7d}","until":"${today}"}&access_token=${token}`;
    const insights7d = await fetchAllPages<Record<string, unknown>>(insights7dUrl);

    // 5. Get 5-day rolling for campaign level (for benchmark)
    const d5 = new Date(now);
    d5.setDate(d5.getDate() - 5);
    const since5d = d5.toISOString().split("T")[0];
    const rolling5dUrl = `${META_API}/${campaignId}/insights?fields=spend,actions&time_range={"since":"${since5d}","until":"${today}"}&access_token=${token}`;
    const rolling5dResp = await fetch(rolling5dUrl);
    const rolling5dData = await rolling5dResp.json();
    const rolling5dRow = rolling5dData.data?.[0];
    const rolling5dSpend = parseFloat(rolling5dRow?.spend || "0");
    const rolling5dLeads = getLeads(rolling5dRow?.actions);
    const rolling5dCpl = rolling5dLeads > 0 ? rolling5dSpend / rolling5dLeads : Infinity;

    // Build lookup maps
    const lifetimeMap = new Map<string, Record<string, unknown>>();
    for (const row of lifetimeInsights) {
      lifetimeMap.set(row.ad_id as string, row);
    }
    const d3Map = new Map<string, Record<string, unknown>>();
    for (const row of insights3d) {
      d3Map.set(row.ad_id as string, row);
    }
    const d7Map = new Map<string, Record<string, unknown>>();
    for (const row of insights7d) {
      d7Map.set(row.ad_id as string, row);
    }

    // Check for benchmark ads (spend > 20× CPL meta & CPL ≤ CPL meta)
    let hasBenchmark = false;
    for (const [, row] of lifetimeMap) {
      const spend = parseFloat((row.spend as string) || "0");
      const leads = getLeads(row.actions as Array<Record<string, string>> | undefined);
      if (spend > 20 * CPL_META && leads > 0 && spend / leads <= CPL_META) {
        hasBenchmark = true;
        break;
      }
    }

    // Process each ad
    const results: AdInsight[] = [];

    for (const ad of allAds) {
      const adId = ad.id as string;
      const adName = ad.name as string;
      const adStatus = (ad.status as string) || "UNKNOWN";
      const adEffectiveStatus = (ad.effective_status as string) || adStatus;
      const adset = ad.adset as Record<string, unknown> | undefined;
      const adsetId = (ad.adset_id as string) || "";
      const adsetName = (adset?.name as string) || "";
      const adsetStatus = (adset?.effective_status as string) || (adset?.status as string) || "";

      const lt = lifetimeMap.get(adId);
      const spend = parseFloat((lt?.spend as string) || "0");
      const impressions = parseFloat((lt?.impressions as string) || "0");
      const clicks = parseFloat((lt?.clicks as string) || "0");
      const ctr = parseFloat((lt?.ctr as string) || "0");
      const cpm = parseFloat((lt?.cpm as string) || "0");
      const leads = getLeads(lt?.actions as Array<Record<string, string>> | undefined);
      const cpl = leads > 0 ? spend / leads : (spend > 0 ? Infinity : 0);

      const d3Row = d3Map.get(adId);
      const spend3d = parseFloat((d3Row?.spend as string) || "0");
      const leads3d = getLeads(d3Row?.actions as Array<Record<string, string>> | undefined);
      const cpl3d = leads3d > 0 ? spend3d / leads3d : (spend3d > 0 ? Infinity : 0);

      const d7Row = d7Map.get(adId);
      const spend7d = parseFloat((d7Row?.spend as string) || "0");
      const leads7d = getLeads(d7Row?.actions as Array<Record<string, string>> | undefined);
      const cpl7d = leads7d > 0 ? spend7d / leads7d : (spend7d > 0 ? Infinity : 0);

      // Apply kill rule (only for effectively ACTIVE ads)
      let killLayer: string | null = null;
      let killReason: string | null = null;

      if (adEffectiveStatus === "ACTIVE" && spend > 0) {
        // Select data window for kill rule evaluation
        const wSpend = windowParam === "3d" ? spend3d : windowParam === "7d" ? spend7d : spend;
        const wLeads = windowParam === "3d" ? leads3d : windowParam === "7d" ? leads7d : leads;
        const wCpl = wLeads > 0 ? wSpend / wLeads : (wSpend > 0 ? Infinity : 0);
        // CPM: estimate from window ratio if not lifetime
        const wCpm = windowParam === "lifetime" ? cpm : (
          (spend > 0 && impressions > 0) ? ((wSpend / spend) * impressions > 0 ? (wSpend / ((wSpend / spend) * impressions)) * 1000 : 0) : 0
        );
        const wLabel = windowParam === "lifetime" ? "" : `[${windowParam}] `;

        // L0 — No leads
        if (wLeads === 0 && wSpend > 0) {
          if (wSpend >= CPL_META && wCpm >= 60) {
            killLayer = "L0a";
            killReason = `${wLabel}spend R$${wSpend.toFixed(2)} ≥ 1×CPL_meta + 0 leads + CPM R$${wCpm.toFixed(2)} ≥ 60`;
          } else if (wSpend >= 1.5 * CPL_META) {
            killLayer = "L0b";
            killReason = `${wLabel}spend R$${wSpend.toFixed(2)} ≥ 1.5×CPL_meta + 0 leads`;
          }
        }
        // L1 — Clearly bad (with leads)
        else if (wSpend > 4 * CPL_META && wCpl > 1.5 * CPL_META) {
          killLayer = "L1";
          killReason = `${wLabel}spend R$${wSpend.toFixed(2)} > 4×CPL + CPL R$${wCpl.toFixed(2)} > 1.5×meta`;
        }
        // L2 — Above target with evidence
        else if (wSpend > 6 * CPL_META && wCpl > 1.3 * CPL_META) {
          killLayer = "L2";
          killReason = `${wLabel}spend R$${wSpend.toFixed(2)} > 6×CPL + CPL R$${wCpl.toFixed(2)} > 1.3×meta`;
        }
        // L3 — Acute 3d deterioration (always uses 3d data regardless of window)
        else if (
          hasBenchmark &&
          spend3d > 5 * CPL_META &&
          cpl3d > 1.7 * CPL_META &&
          cpl > CPL_META &&
          rolling5dCpl > 1.15 * CPL_META
        ) {
          killLayer = "L3";
          killReason = `3d: spend R$${spend3d.toFixed(2)} > 5×CPL + CPL3d R$${cpl3d.toFixed(2)} > 1.7×meta + CPL_acum > meta + rolling5d > 1.15×meta`;
        }
        // L4 — Slow 7d deterioration (always uses 7d data regardless of window)
        else if (
          hasBenchmark &&
          spend7d > 5 * CPL_META &&
          cpl7d > 1.7 * CPL_META &&
          cpl > CPL_META &&
          rolling5dCpl > 1.15 * CPL_META
        ) {
          killLayer = "L4";
          killReason = `7d: spend R$${spend7d.toFixed(2)} > 5×CPL + CPL7d R$${cpl7d.toFixed(2)} > 1.7×meta + CPL_acum > meta + rolling5d > 1.15×meta`;
        }
        // L5 — Persistent mediocrity (always uses lifetime)
        else if (
          hasBenchmark &&
          spend > 10 * CPL_META &&
          cpl > 1.15 * CPL_META &&
          rolling5dCpl > 1.15 * CPL_META
        ) {
          killLayer = "L5";
          killReason = `spend R$${spend.toFixed(2)} > 10×CPL + CPL R$${cpl.toFixed(2)} > 1.15×meta + rolling5d > 1.15×meta`;
        }
      }

      results.push({
        ad_id: adId,
        ad_name: adName,
        adset_id: adsetId,
        adset_name: adsetName,
        status: adStatus,
        effective_status: adEffectiveStatus,
        adset_status: adsetStatus,
        spend,
        leads,
        cpl: leads > 0 ? cpl : -1,
        cpm,
        impressions,
        ctr,
        clicks,
        spend_3d: spend3d,
        leads_3d: leads3d,
        cpl_3d: leads3d > 0 ? cpl3d : -1,
        spend_7d: spend7d,
        leads_7d: leads7d,
        cpl_7d: leads7d > 0 ? cpl7d : -1,
        kill_layer: killLayer,
        kill_reason: killReason,
      });
    }

    // Sort: kill candidates first, then by spend desc
    results.sort((a, b) => {
      if (a.kill_layer && !b.kill_layer) return -1;
      if (!a.kill_layer && b.kill_layer) return 1;
      return b.spend - a.spend;
    });

    const killCount = results.filter((r) => r.kill_layer).length;
    const activeCount = results.filter((r) => r.effective_status === "ACTIVE").length;
    const totalSpend = results.reduce((s, r) => s + r.spend, 0);
    const totalLeads = results.reduce((s, r) => s + r.leads, 0);

    return NextResponse.json({
      campaign_id: campaignId,
      window: windowParam,
      cpl_meta: CPL_META,
      has_benchmark: hasBenchmark,
      rolling_5d_cpl: rolling5dCpl === Infinity ? -1 : Number(rolling5dCpl.toFixed(2)),
      total_ads: allAds.length,
      active_ads: activeCount,
      kill_candidates: killCount,
      total_spend: Number(totalSpend.toFixed(2)),
      total_leads: totalLeads,
      campaign_cpl: totalLeads > 0 ? Number((totalSpend / totalLeads).toFixed(2)) : -1,
      ads: results,
    });
  } catch (err) {
    console.error("[KillRule]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

function getLeads(actions: Array<Record<string, string>> | undefined): number {
  if (!actions) return 0;
  for (const a of actions) {
    if (a.action_type === "lead" || a.action_type === "offsite_conversion.fb_pixel_lead") {
      return parseInt(a.value, 10) || 0;
    }
  }
  return 0;
}
