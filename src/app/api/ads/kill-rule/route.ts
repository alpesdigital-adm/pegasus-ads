/**
 * GET /api/ads/kill-rule?campaign_id=XXX[&window=lifetime|7d|5d|4d|3d|2d|today]
 *
 * Avalia L0-L5 para todos os ads de uma campanha.
 * Janelas disponíveis: lifetime (default), 7d, 5d, 4d, 3d, 2d, today.
 *
 * Fonte de leads (prioridade):
 * 1. CRM (crm_leads) — quando existem registros importados para a campanha
 * 2. Meta Ads pixel — fallback quando CRM não disponível
 *
 * Lookup CRM usa chave COMPOSTA: (utm_content, utm_term) = (ad name, adset name)
 * garantindo que o mesmo criativo em adsets diferentes tenha leads separados.
 * Fallback: (ad_id, adset_id) quando UTMs resolvidos na importação.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 120;

const META_API = "https://graph.facebook.com/v25.0";
const CPL_META = 32.77;

type Window = "lifetime" | "7d" | "5d" | "4d" | "3d" | "2d" | "today";

interface WindowMetrics {
  spend: number;
  leads: number;
  qualified_leads: number;
  cpl: number;
  source: "crm" | "meta";
}

interface AdInsight {
  ad_id: string;
  ad_name: string;
  adset_id: string;
  adset_name: string;
  status: string;
  effective_status: string;
  adset_status: string;
  // Lifetime
  spend: number;
  leads: number;
  qualified_leads: number;
  cpl: number;
  cpm: number;
  impressions: number;
  ctr: number;
  clicks: number;
  leads_source: "crm" | "meta";
  // Windows
  today: WindowMetrics;
  w2d: WindowMetrics;
  w3d: WindowMetrics;
  w4d: WindowMetrics;
  w5d: WindowMetrics;
  w7d: WindowMetrics;
  // Kill rule
  kill_layer: string | null;
  kill_reason: string | null;
  kill_window: string;
}

/** Chave composta para lookup CRM */
function crmKey(adName: string, adsetName: string): string {
  return `${adName.toUpperCase()}||${adsetName.toUpperCase()}`;
}

/** Chave composta por IDs resolvidos */
function crmIdKey(adId: string, adsetId: string): string {
  return `${adId}||${adsetId}`;
}

async function fetchAllPages<T>(url: string): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | null = url;
  while (nextUrl) {
    const r = await fetch(nextUrl);
    const data: { data?: T[]; paging?: { next?: string } } = await r.json();
    if (data.data) results.push(...data.data);
    nextUrl = data.paging?.next || null;
  }
  return results;
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

function sinceDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

/** Monta mapa CRM com chave composta (adName||adsetName) e (adId||adsetId) */
function buildCrmMap(rows: Record<string, unknown>[]): Map<string, { total: number; qualified: number }> {
  const map = new Map<string, { total: number; qualified: number }>();
  for (const r of rows) {
    const entry = { total: Number(r.total_leads), qualified: Number(r.qualified_leads) };
    // Chave por IDs resolvidos (mais precisa)
    if (r.ad_id && r.adset_id) {
      map.set(crmIdKey(r.ad_id as string, r.adset_id as string), entry);
    }
    // Chave por nomes UTM (principal)
    if (r.utm_content && r.utm_term) {
      map.set(crmKey(r.utm_content as string, r.utm_term as string), entry);
    }
    // Fallbacks parciais (só utm_content sem adset — menor precisão)
    if (r.utm_content && !r.utm_term) {
      map.set(`${(r.utm_content as string).toUpperCase()}||__ANY__`, entry);
    }
    if (r.ad_id && !r.adset_id) {
      map.set(`${r.ad_id as string}||__ANY__`, entry);
    }
  }
  return map;
}

/** Resolve leads de um ad específico dentro de um adset */
function resolveLeads(
  adId: string,
  adName: string,
  adsetId: string,
  adsetName: string,
  crmMap: Map<string, { total: number; qualified: number }>,
  metaRow: Record<string, unknown> | undefined,
  useCrm: boolean
): { leads: number; qualified: number; source: "crm" | "meta" } {
  if (useCrm) {
    // Tentativa 1: (adName, adsetName) — principal
    const byName = crmMap.get(crmKey(adName, adsetName));
    if (byName) return { leads: byName.total, qualified: byName.qualified, source: "crm" };
    // Tentativa 2: (adId, adsetId) — IDs resolvidos
    if (adId && adsetId) {
      const byId = crmMap.get(crmIdKey(adId, adsetId));
      if (byId) return { leads: byId.total, qualified: byId.qualified, source: "crm" };
    }
    // Tentativa 3: fallback parcial (utm_content sem adset)
    const byNameOnly = crmMap.get(`${adName.toUpperCase()}||__ANY__`);
    if (byNameOnly) return { leads: byNameOnly.total, qualified: byNameOnly.qualified, source: "crm" };
    if (adId) {
      const byIdOnly = crmMap.get(`${adId}||__ANY__`);
      if (byIdOnly) return { leads: byIdOnly.total, qualified: byIdOnly.qualified, source: "crm" };
    }
    // Nenhum match CRM — retorna 0 (não cai no Meta, porque hasCrmData=true significa
    // que a campanha tem dados CRM; ausência de match = ad sem leads mesmo)
    return { leads: 0, qualified: 0, source: "crm" };
  }
  // Fallback Meta
  const leads = getLeads(metaRow?.actions as Array<Record<string, string>> | undefined);
  return { leads, qualified: 0, source: "meta" };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const campaignId = req.nextUrl.searchParams.get("campaign_id");
  if (!campaignId) return NextResponse.json({ error: "campaign_id required" }, { status: 400 });

  const windowParam = (req.nextUrl.searchParams.get("window") || "lifetime") as Window;
  const validWindows: Window[] = ["lifetime", "7d", "5d", "4d", "3d", "2d", "today"];
  if (!validWindows.includes(windowParam)) {
    return NextResponse.json({ error: `window inválido. Use: ${validWindows.join(", ")}` }, { status: 400 });
  }

  try {
    const token = await getTokenForWorkspace(auth.workspace_id);
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const since7d = sinceDate(7);
    const since5d = sinceDate(5);
    const since4d = sinceDate(4);
    const since3d = sinceDate(3);
    const since2d = sinceDate(2);

    // ── 1. Meta: All ads ──
    const adsUrl = `${META_API}/${campaignId}/ads?fields=id,name,status,effective_status,adset_id,adset{name,status,effective_status}&limit=200&access_token=${token}`;
    const allAds = await fetchAllPages<Record<string, unknown>>(adsUrl);
    console.log(`[KillRule] ${allAds.length} ads | campaign=${campaignId} | window=${windowParam}`);

    // ── 2. Meta: Lifetime insights ──
    const lifetimeUrl = `${META_API}/${campaignId}/insights?fields=ad_id,ad_name,adset_id,adset_name,spend,impressions,clicks,ctr,cpm,actions&level=ad&limit=500&time_range={"since":"2026-01-01","until":"${today}"}&access_token=${token}`;
    const lifetimeInsights = await fetchAllPages<Record<string, unknown>>(lifetimeUrl);

    // ── 3. Meta: Window insights (parallel) ──
    const windowRanges: Record<string, [string, string]> = {
      "7d": [since7d, today], "5d": [since5d, today], "4d": [since4d, today],
      "3d": [since3d, today], "2d": [since2d, today], "today": [today, today],
    };
    const windowFetches = Object.entries(windowRanges).map(([key, [since, until]]) => {
      const url = `${META_API}/${campaignId}/insights?fields=ad_id,spend,actions&level=ad&limit=500&time_range={"since":"${since}","until":"${until}"}&access_token=${token}`;
      return fetchAllPages<Record<string, unknown>>(url).then(rows => [key, rows] as [string, Record<string, unknown>[]]);
    });
    const windowResults = await Promise.all(windowFetches);

    // ── 4. Meta: Rolling 5d campaign-level benchmark ──
    const r5dResp = await fetch(`${META_API}/${campaignId}/insights?fields=spend,actions&time_range={"since":"${since5d}","until":"${today}"}&access_token=${token}`);
    const r5dData = await r5dResp.json();
    const r5dRow = r5dData.data?.[0];
    const r5dSpend = parseFloat(r5dRow?.spend || "0");
    const r5dLeads = getLeads(r5dRow?.actions);
    const rolling5dCpl = r5dLeads > 0 ? r5dSpend / r5dLeads : Infinity;

    // ── 5. CRM leads para esta campanha ──
    // Query agrupa por (utm_content, utm_term, ad_id, adset_id) para permitir
    // lookup por (criativo × adset) — essencial para kill rules por adset
    const crmGroupBy = `utm_content, utm_term, ad_id, adset_id`;
    const crmSelect = `SELECT utm_content, utm_term, ad_id, adset_id,
        COUNT(*) AS total_leads,
        SUM(CASE WHEN is_qualified THEN 1 ELSE 0 END) AS qualified_leads
      FROM crm_leads`;

    // ── Resolve campaign code for CRM lookup ──
    // 1. Tenta pelo meta_campaign_id exato (campaign_id resolvido no import)
    // 2. Tenta LIKE no ID numérico (primeiros 12 chars)
    // 3. Busca nome da campanha na Meta API e extrai código T-XX__XXXX
    // 4. Fallback: tabela campaigns local
    let crmCampaignWhere = `workspace_id = ? AND (campaign_id = ? OR utm_campaign LIKE ?)`;
    let crmCampaignArgs: unknown[] = [auth.workspace_id, campaignId, `%${campaignId.slice(0,12)}%`];

    // Tenta obter nome real da campanha na Meta API
    let metaCampaignCode: string | null = null;
    try {
      const metaCampResp = await fetch(`${META_API}/${campaignId}?fields=name&access_token=${token}`);
      const metaCampJson = await metaCampResp.json();
      const metaCampName: string = metaCampJson.name || "";
      // Usa o nome completo da campanha para match exato no utm_campaign
      // Ex: "T7__0006__CAP__LP__EB" → match exato evita colisões com nomes similares
      if (metaCampName) {
        metaCampaignCode = metaCampName; // nome completo
      }
    } catch (_) { /* ignora erro — usa fallback */ }

    // Se encontrou código, amplia o WHERE para incluir LIKE no utm_campaign
    if (metaCampaignCode) {
      crmCampaignWhere = `workspace_id = ? AND (campaign_id = ? OR utm_campaign LIKE ? OR utm_campaign LIKE ?)`;
      crmCampaignArgs = [
        auth.workspace_id,
        campaignId,
        `%${campaignId.slice(0,12)}%`,
        `%${metaCampaignCode}%`,
      ];
    } else {
      // Fallback: tabela campaigns local
      const campNameRes = await db.execute({
        sql: "SELECT name FROM campaigns WHERE workspace_id = ? AND meta_campaign_id = ?",
        args: [auth.workspace_id, campaignId],
      });
      const campName = campNameRes.rows[0]?.name as string | undefined;
      if (campName) {
        crmCampaignWhere = `workspace_id = ? AND (campaign_id = ? OR utm_campaign LIKE ? OR utm_campaign LIKE ?)`;
        crmCampaignArgs = [auth.workspace_id, campaignId, `%${campaignId.slice(0,12)}%`, `%${campName}%`];
      }
    }

    // Lifetime CRM
    const crmLifetimeRes = await db.execute({
      sql: `${crmSelect} WHERE ${crmCampaignWhere} GROUP BY ${crmGroupBy}`,
      args: crmCampaignArgs,
    });
    let crmAllRows = crmLifetimeRes.rows;

    const hasCrmData = crmAllRows.length > 0;
    const crmLifetimeMap = buildCrmMap(crmAllRows as Record<string, unknown>[]);

    // CRM windowed queries — só executa se há dados CRM
    const crmWindowMaps: Record<string, Map<string, { total: number; qualified: number }>> = {};
    if (hasCrmData) {
      const windowDays: Record<string, string> = {
        "today": today, "2d": since2d, "3d": since3d, "4d": since4d, "5d": since5d, "7d": since7d,
      };
      await Promise.all(Object.entries(windowDays).map(async ([key, since]) => {
        const isToday = key === "today";
        const res = await db.execute({
          sql: `${crmSelect}
            WHERE ${crmCampaignWhere}
              AND subscribed_at >= ?
              ${isToday ? "AND subscribed_at < ?" : ""}
            GROUP BY ${crmGroupBy}`,
          args: isToday
            ? [...crmCampaignArgs, since + "T00:00:00Z", since + "T23:59:59Z"]
            : [...crmCampaignArgs, since + "T00:00:00Z"],
        });
        crmWindowMaps[key] = buildCrmMap(res.rows as Record<string, unknown>[]);
      }));
    }

    // ── Build lookup maps (Meta) ──
    const lifetimeMap = new Map<string, Record<string, unknown>>();
    for (const row of lifetimeInsights) lifetimeMap.set(row.ad_id as string, row);

    const windowMaps: Record<string, Map<string, Record<string, unknown>>> = {};
    for (const [key, rows] of windowResults) {
      const map = new Map<string, Record<string, unknown>>();
      for (const row of rows) map.set(row.ad_id as string, row);
      windowMaps[key] = map;
    }

    // ── Benchmark ──
    let hasBenchmark = false;
    if (hasCrmData) {
      for (const ad of allAds) {
        const adId = ad.id as string;
        const adName = ad.name as string;
        const adsetObj = ad.adset as Record<string, unknown> | undefined;
        const adsetId = (ad.adset_id as string) || "";
        const adsetName = (adsetObj?.name as string) || "";
        const lt = lifetimeMap.get(adId);
        const spend = parseFloat((lt?.spend as string) || "0");
        const res = resolveLeads(adId, adName, adsetId, adsetName, crmLifetimeMap, lt, true);
        if (spend > 20 * CPL_META && res.leads > 0 && spend / res.leads <= CPL_META) {
          hasBenchmark = true; break;
        }
      }
    } else {
      for (const [, row] of lifetimeMap) {
        const spend = parseFloat((row.spend as string) || "0");
        const leads = getLeads(row.actions as Array<Record<string, string>> | undefined);
        if (spend > 20 * CPL_META && leads > 0 && spend / leads <= CPL_META) {
          hasBenchmark = true; break;
        }
      }
    }

    // ── Process each ad ──
    const results: AdInsight[] = [];

    for (const ad of allAds) {
      const adId = ad.id as string;
      const adName = ad.name as string;
      const adStatus = (ad.status as string) || "UNKNOWN";
      const adEffectiveStatus = (ad.effective_status as string) || adStatus;
      const adsetObj = ad.adset as Record<string, unknown> | undefined;
      const adsetId = (ad.adset_id as string) || "";
      const adsetName = (adsetObj?.name as string) || "";
      const adsetStatus = (adsetObj?.effective_status as string) || (adsetObj?.status as string) || "";

      const lt = lifetimeMap.get(adId);
      const ltSpend = parseFloat((lt?.spend as string) || "0");
      const ltImpressions = parseFloat((lt?.impressions as string) || "0");
      const ltClicks = parseFloat((lt?.clicks as string) || "0");
      const ltCtr = parseFloat((lt?.ctr as string) || "0");
      const ltCpm = parseFloat((lt?.cpm as string) || "0");

      // Lifetime leads com chave composta (adName × adsetName)
      const ltResolved = resolveLeads(adId, adName, adsetId, adsetName, crmLifetimeMap, lt, hasCrmData);
      const ltLeads = ltResolved.leads;
      const ltQual = ltResolved.qualified;
      const ltCpl = ltLeads > 0 ? ltSpend / ltLeads : ltSpend > 0 ? Infinity : -1;

      // Window metrics
      const calcWindow = (key: string): WindowMetrics => {
        const metaRow = windowMaps[key]?.get(adId);
        const metaSpend = parseFloat((metaRow?.spend as string) || "0");
        if (hasCrmData && crmWindowMaps[key]) {
          const crmRes = resolveLeads(adId, adName, adsetId, adsetName, crmWindowMaps[key], metaRow, true);
          const cpl = crmRes.leads > 0 ? metaSpend / crmRes.leads : metaSpend > 0 ? Infinity : -1;
          return {
            spend: metaSpend,
            leads: crmRes.leads,
            qualified_leads: crmRes.qualified,
            cpl: cpl === Infinity ? -1 : cpl,
            source: crmRes.source,
          };
        }
        const leads = getLeads(metaRow?.actions as Array<Record<string, string>> | undefined);
        const cpl = leads > 0 ? metaSpend / leads : metaSpend > 0 ? Infinity : -1;
        return { spend: metaSpend, leads, qualified_leads: 0, cpl: cpl === Infinity ? -1 : cpl, source: "meta" };
      };

      const wToday = calcWindow("today");
      const w2d = calcWindow("2d");
      const w3d = calcWindow("3d");
      const w4d = calcWindow("4d");
      const w5d = calcWindow("5d");
      const w7d = calcWindow("7d");

      const winMap: Record<Window, { spend: number; leads: number; cpl: number }> = {
        lifetime: { spend: ltSpend, leads: ltLeads, cpl: ltCpl === Infinity ? -1 : ltCpl },
        today: wToday, "2d": w2d, "3d": w3d, "4d": w4d, "5d": w5d, "7d": w7d,
      };
      const evalM = winMap[windowParam];

      // ── Kill rules ──
      let killLayer: string | null = null;
      let killReason: string | null = null;

      if (adEffectiveStatus === "ACTIVE" && ltSpend > 0) {
        const evalSpend = evalM.spend;
        const evalLeads = evalM.leads;
        const evalCpl = evalM.cpl;
        const src = hasCrmData ? "CRM" : "Meta";

        // L0: sem leads após gasto mínimo
        if (ltLeads === 0) {
          if (ltSpend >= CPL_META && ltCpm >= 60) {
            killLayer = "L0a";
            killReason = `spend R$${ltSpend.toFixed(2)} ≥ 1×CPL + 0 leads + CPM R$${ltCpm.toFixed(2)} ≥ 60 [${src}]`;
          } else if (ltSpend >= 1.5 * CPL_META) {
            killLayer = "L0b";
            killReason = `spend R$${ltSpend.toFixed(2)} ≥ 1.5×CPL + 0 leads [${src}]`;
          }
        // L1/L2: CPL alto na janela de avaliação
        } else if (evalSpend > 4 * CPL_META && evalCpl !== -1 && evalCpl > 1.5 * CPL_META) {
          killLayer = "L1";
          killReason = `[${windowParam}/${src}] spend R$${evalSpend.toFixed(2)} > 4×CPL + CPL R$${evalCpl.toFixed(2)} > 1.5×meta`;
        } else if (evalSpend > 6 * CPL_META && evalCpl !== -1 && evalCpl > 1.3 * CPL_META) {
          killLayer = "L2";
          killReason = `[${windowParam}/${src}] spend R$${evalSpend.toFixed(2)} > 6×CPL + CPL R$${evalCpl.toFixed(2)} > 1.3×meta`;
        // L3: performance 3d ruim com benchmark existente
        } else if (
          hasBenchmark && w3d.spend > 5 * CPL_META && w3d.cpl !== -1 && w3d.cpl > 1.7 * CPL_META
          && ltCpl !== -1 && ltCpl > CPL_META && rolling5dCpl > 1.15 * CPL_META
        ) {
          killLayer = "L3";
          killReason = `3d/${src}: spend R$${w3d.spend.toFixed(2)} > 5×CPL + CPL3d R$${w3d.cpl.toFixed(2)} > 1.7×meta`;
        // L4: performance 7d ruim com benchmark existente
        } else if (
          hasBenchmark && w7d.spend > 5 * CPL_META && w7d.cpl !== -1 && w7d.cpl > 1.7 * CPL_META
          && ltCpl !== -1 && ltCpl > CPL_META && rolling5dCpl > 1.15 * CPL_META
        ) {
          killLayer = "L4";
          killReason = `7d/${src}: spend R$${w7d.spend.toFixed(2)} > 5×CPL + CPL7d R$${w7d.cpl.toFixed(2)} > 1.7×meta`;
        // L5: lifetime ruim com benchmark existente
        } else if (
          hasBenchmark && ltSpend > 10 * CPL_META && ltCpl !== -1 && ltCpl > 1.15 * CPL_META
          && rolling5dCpl > 1.15 * CPL_META
        ) {
          killLayer = "L5";
          killReason = `spend R$${ltSpend.toFixed(2)} > 10×CPL + CPL R$${ltCpl.toFixed(2)} > 1.15×meta [${src}]`;
        }
      }

      results.push({
        ad_id: adId, ad_name: adName, adset_id: adsetId, adset_name: adsetName,
        status: adStatus, effective_status: adEffectiveStatus, adset_status: adsetStatus,
        spend: ltSpend, leads: ltLeads, qualified_leads: ltQual,
        cpl: ltCpl === Infinity ? -1 : ltCpl,
        cpm: ltCpm, impressions: ltImpressions, ctr: ltCtr, clicks: ltClicks,
        leads_source: ltResolved.source,
        today: wToday, w2d, w3d, w4d, w5d, w7d,
        kill_layer: killLayer, kill_reason: killReason, kill_window: windowParam,
      });
    }

    results.sort((a, b) => {
      if (a.kill_layer && !b.kill_layer) return -1;
      if (!a.kill_layer && b.kill_layer) return 1;
      return b.spend - a.spend;
    });

    const killCount = results.filter((r) => r.kill_layer).length;
    const activeCount = results.filter((r) => r.effective_status === "ACTIVE").length;
    const totalSpend = results.reduce((s, r) => s + r.spend, 0);
    const totalLeads = results.reduce((s, r) => s + r.leads, 0);
    const totalQual = results.reduce((s, r) => s + r.qualified_leads, 0);

    return NextResponse.json({
      campaign_id: campaignId,
      cpl_meta: CPL_META,
      window: windowParam,
      leads_source: hasCrmData ? "crm" : "meta",
      has_benchmark: hasBenchmark,
      rolling_5d_cpl: rolling5dCpl === Infinity ? -1 : Number(rolling5dCpl.toFixed(2)),
      total_ads: allAds.length,
      active_ads: activeCount,
      kill_candidates: killCount,
      total_spend: Number(totalSpend.toFixed(2)),
      total_leads: totalLeads,
      total_qualified_leads: totalQual,
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
