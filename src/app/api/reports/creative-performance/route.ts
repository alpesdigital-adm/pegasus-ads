/**
 * GET /api/reports/creative-performance?days=7&offer=&concept=&launch=&format=&campaign=&adset=
 *
 * Relatório hierárquico de performance de criativos.
 * Retorna dados em 3 níveis: Conceito → Ângulo → Ad (com breakdown diário).
 *
 * MIGRADO NA FASE 1C (Wave 5):
 *  - getDb() → withWorkspace (RLS escopa ad_creatives/classified_insights/crm_leads)
 *  - 4 queries em sql`` com filtros dinâmicos via fragments
 *  - Filtros workspace_id manuais removidos (RLS cobre)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const sp = req.nextUrl.searchParams;
  const days = parseInt(sp.get("days") || "7", 10);
  const fOffer = sp.get("offer") || "";
  const fConcept = sp.get("concept") || "";
  const fLaunch = sp.get("launch") || "";
  const fFormat = sp.get("format") || "";
  const fCampaign = sp.get("campaign") || "";
  const fAdset = sp.get("adset") || "";

  try {
    const filters = [
      fOffer ? sql`AND o.key = ${fOffer}` : sql``,
      fConcept ? sql`AND con.code = ${fConcept}` : sql``,
      fLaunch ? sql`AND l.key = ${fLaunch}` : sql``,
      fFormat ? sql`AND ac.format = ${fFormat}` : sql``,
      fCampaign ? sql`AND ci.campaign_name = ${fCampaign}` : sql``,
      fAdset ? sql`AND ci.adset_name = ${fAdset}` : sql``,
    ];

    const { filtersRows, campaignRows, mainRows, crmRows } = await withWorkspace(
      auth.workspace_id,
      async (tx) => {
        // ── Filter options ──
        const f = await tx.execute(sql`
          SELECT
            DISTINCT o.key AS offer_key, o.name AS offer_name,
            con.code AS concept_code, con.name AS concept_name,
            l.key AS launch_key, l.name AS launch_name,
            ac.format
          FROM ad_creatives ac
          JOIN offers o ON ac.offer_id = o.id
          JOIN launches l ON ac.launch_id = l.id
          LEFT JOIN angles ang ON ac.angle_id = ang.id
          LEFT JOIN concepts con ON ang.concept_id = con.id
        `);

        const c = await tx.execute(sql`
          SELECT DISTINCT ci.campaign_name, ci.adset_name
          FROM classified_insights ci
          INNER JOIN ad_creatives ac ON ci.ad_name = ac.ad_name
          WHERE ci.date >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')
          ORDER BY ci.campaign_name, ci.adset_name
        `);

        // ── Main hierarchical ──
        const m = await tx.execute(sql`
          SELECT
            o.key AS offer_key,
            o.name AS offer_name,
            COALESCE(con.code, 'PRE') AS concept_code,
            COALESCE(con.name, ac.concept_label, 'Pre-Conceito') AS concept_name,
            COALESCE(ang.code, '-') AS angle_code,
            COALESCE(ang.name, '-') AS angle_name,
            COALESCE(ac.motor, ang.motor, '-') AS motor,
            ac.ad_name,
            ac.format,
            ac.hook,
            ac.status AS ad_status,
            CAST(ci.date AS TEXT) AS date,
            ci.campaign_name,
            ci.adset_name,
            CAST(ci.spend AS FLOAT) AS spend,
            ci.impressions,
            ci.link_clicks AS clicks,
            ci.landing_page_views AS lpv,
            ci.leads AS leads_meta
          FROM ad_creatives ac
          JOIN offers o ON ac.offer_id = o.id
          JOIN launches l ON ac.launch_id = l.id
          LEFT JOIN angles ang ON ac.angle_id = ang.id
          LEFT JOIN concepts con ON ang.concept_id = con.id
          INNER JOIN classified_insights ci ON ci.ad_name = ac.ad_name
          WHERE ci.date >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')
            ${filters[0]} ${filters[1]} ${filters[2]}
            ${filters[3]} ${filters[4]} ${filters[5]}
          ORDER BY o.key, concept_code, angle_code, ac.ad_name, ci.date
        `);

        // ── CRM leads ──
        const crm = await tx.execute(sql`
          SELECT
            cl.utm_content AS ad_name,
            cl.utm_campaign AS campaign_name,
            cl.utm_term AS adset_name,
            COUNT(*) AS leads_crm,
            SUM(CASE WHEN cl.is_qualified THEN 1 ELSE 0 END) AS leads_qualified,
            CAST(CAST(cl.subscribed_at AS DATE) AS TEXT) AS dt
          FROM crm_leads cl
          INNER JOIN ad_creatives ac ON cl.utm_content = ac.ad_name
          WHERE cl.subscribed_at >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')
          GROUP BY cl.utm_content, cl.utm_campaign, cl.utm_term, CAST(cl.subscribed_at AS DATE)
        `);

        return {
          filtersRows: f as unknown as Array<Record<string, unknown>>,
          campaignRows: c as unknown as Array<Record<string, unknown>>,
          mainRows: m as unknown as Array<Record<string, unknown>>,
          crmRows: crm as unknown as Array<Record<string, unknown>>,
        };
      },
    );

    // ── Filter options ──
    const offers = [...new Map(
      filtersRows.map((r) => [r.offer_key as string, { key: r.offer_key, name: r.offer_name }]),
    ).values()];
    const concepts = [...new Map(
      filtersRows.filter((r) => r.concept_code).map((r) => [
        r.concept_code as string,
        { code: r.concept_code, name: r.concept_name },
      ]),
    ).values()];
    const launches = [...new Map(
      filtersRows.map((r) => [r.launch_key as string, { key: r.launch_key, name: r.launch_name }]),
    ).values()];
    const formats = [...new Set(filtersRows.map((r) => r.format as string))].filter(Boolean).sort();
    const campaigns = [...new Set(campaignRows.map((r) => r.campaign_name as string))].sort();
    const adsets = [...new Set(campaignRows.map((r) => r.adset_name as string))].sort();

    // ── Index CRM ──
    const crmIndex: Record<string, { leads_crm: number; leads_qualified: number }> = {};
    for (const r of crmRows) {
      const key = `${r.ad_name}|${r.campaign_name}|${r.adset_name}|${r.dt}`;
      crmIndex[key] = {
        leads_crm: Number(r.leads_crm),
        leads_qualified: Number(r.leads_qualified),
      };
    }

    // ── Build hierarchical structure ──
    interface DayRow {
      date: string;
      campaign: string;
      adset: string;
      spend: number;
      impressions: number;
      clicks: number;
      lpv: number;
      leads_meta: number;
      leads_crm: number;
      leads_qualified: number;
    }
    interface AdNode {
      ad_name: string;
      format: string;
      hook: string;
      motor: string;
      status: string;
      spend: number;
      impressions: number;
      clicks: number;
      lpv: number;
      leads_meta: number;
      leads_crm: number;
      leads_qualified: number;
      days: DayRow[];
    }
    interface AngleNode {
      code: string;
      name: string;
      motor: string;
      spend: number;
      impressions: number;
      clicks: number;
      lpv: number;
      leads_meta: number;
      leads_crm: number;
      leads_qualified: number;
      ads: AdNode[];
    }
    interface ConceptNode {
      code: string;
      name: string;
      offer_key: string;
      offer_name: string;
      spend: number;
      impressions: number;
      clicks: number;
      lpv: number;
      leads_meta: number;
      leads_crm: number;
      leads_qualified: number;
      angles: AngleNode[];
    }

    const conceptsMap = new Map<string, ConceptNode>();
    for (const row of mainRows) {
      const cKey = `${row.offer_key}|${row.concept_code}`;
      const crmKey = `${row.ad_name}|${row.campaign_name}|${row.adset_name}|${row.date}`;
      const crm = crmIndex[crmKey] || { leads_crm: 0, leads_qualified: 0 };

      if (!conceptsMap.has(cKey)) {
        conceptsMap.set(cKey, {
          code: row.concept_code as string,
          name: row.concept_name as string,
          offer_key: row.offer_key as string,
          offer_name: row.offer_name as string,
          spend: 0, impressions: 0, clicks: 0, lpv: 0, leads_meta: 0, leads_crm: 0, leads_qualified: 0,
          angles: [],
        });
      }
      const concept = conceptsMap.get(cKey)!;

      let angle = concept.angles.find((a) => a.code === row.angle_code);
      if (!angle) {
        angle = {
          code: row.angle_code as string,
          name: row.angle_name as string,
          motor: row.motor as string,
          spend: 0, impressions: 0, clicks: 0, lpv: 0, leads_meta: 0, leads_crm: 0, leads_qualified: 0,
          ads: [],
        };
        concept.angles.push(angle);
      }

      let ad = angle.ads.find((a) => a.ad_name === row.ad_name);
      if (!ad) {
        ad = {
          ad_name: row.ad_name as string,
          format: row.format as string,
          hook: (row.hook as string) || "",
          motor: row.motor as string,
          status: row.ad_status as string,
          spend: 0, impressions: 0, clicks: 0, lpv: 0, leads_meta: 0, leads_crm: 0, leads_qualified: 0,
          days: [],
        };
        angle.ads.push(ad);
      }

      const spend = Number(row.spend) || 0;
      const impressions = Number(row.impressions) || 0;
      const clicks = Number(row.clicks) || 0;
      const lpv = Number(row.lpv) || 0;
      const leads_meta = Number(row.leads_meta) || 0;

      ad.days.push({
        date: row.date as string,
        campaign: row.campaign_name as string,
        adset: row.adset_name as string,
        spend, impressions, clicks, lpv, leads_meta,
        leads_crm: crm.leads_crm,
        leads_qualified: crm.leads_qualified,
      });

      ad.spend += spend;
      ad.impressions += impressions;
      ad.clicks += clicks;
      ad.lpv += lpv;
      ad.leads_meta += leads_meta;
      ad.leads_crm += crm.leads_crm;
      ad.leads_qualified += crm.leads_qualified;

      angle.spend += spend;
      angle.impressions += impressions;
      angle.clicks += clicks;
      angle.lpv += lpv;
      angle.leads_meta += leads_meta;
      angle.leads_crm += crm.leads_crm;
      angle.leads_qualified += crm.leads_qualified;

      concept.spend += spend;
      concept.impressions += impressions;
      concept.clicks += clicks;
      concept.lpv += lpv;
      concept.leads_meta += leads_meta;
      concept.leads_crm += crm.leads_crm;
      concept.leads_qualified += crm.leads_qualified;
    }

    const conceptsList = [...conceptsMap.values()].sort((a, b) => b.spend - a.spend);
    for (const c of conceptsList) {
      c.angles.sort((a, b) => b.spend - a.spend);
      for (const a of c.angles) {
        a.ads.sort((x, y) => y.spend - x.spend);
        for (const ad of a.ads) {
          ad.days.sort((x, y) => String(y.date).localeCompare(String(x.date)));
        }
      }
    }

    const totals = {
      spend: conceptsList.reduce((s, c) => s + c.spend, 0),
      impressions: conceptsList.reduce((s, c) => s + c.impressions, 0),
      clicks: conceptsList.reduce((s, c) => s + c.clicks, 0),
      lpv: conceptsList.reduce((s, c) => s + c.lpv, 0),
      leads_meta: conceptsList.reduce((s, c) => s + c.leads_meta, 0),
      leads_crm: conceptsList.reduce((s, c) => s + c.leads_crm, 0),
      leads_qualified: conceptsList.reduce((s, c) => s + c.leads_qualified, 0),
      total_concepts: conceptsList.length,
      total_angles: conceptsList.reduce((s, c) => s + c.angles.length, 0),
      total_ads: conceptsList.reduce(
        (s, c) => s + c.angles.reduce((sa, a) => sa + a.ads.length, 0),
        0,
      ),
    };

    return NextResponse.json({
      filters: { offers, concepts, launches, formats, campaigns, adsets },
      totals,
      concepts: conceptsList,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Creative performance report error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
