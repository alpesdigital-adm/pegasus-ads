/**
 * GET /api/reports/creative-performance?days=7&offer=&concept=&launch=&format=&campaign=&adset=
 *
 * Relatório hierárquico de performance de criativos.
 * Retorna dados em 3 níveis: Conceito → Ângulo → Ad (com breakdown diário).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const sp = req.nextUrl.searchParams;
  const days = parseInt(sp.get("days") || "7", 10);
  const filterOffer = sp.get("offer") || "";
  const filterConcept = sp.get("concept") || "";
  const filterLaunch = sp.get("launch") || "";
  const filterFormat = sp.get("format") || "";
  const filterCampaign = sp.get("campaign") || "";
  const filterAdset = sp.get("adset") || "";

  try {
    const db = getDb();

    // ── 1. Filter options (for dropdowns) ──
    const filtersResult = await db.execute({
      sql: `
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
        WHERE ac.workspace_id = ?
      `,
      args: [auth.workspace_id],
    });

    // Unique filter values
    const offers = [...new Map(filtersResult.rows.map((r: any) => [r.offer_key, { key: r.offer_key, name: r.offer_name }])).values()];
    const concepts = [...new Map(filtersResult.rows.filter((r: any) => r.concept_code).map((r: any) => [r.concept_code, { code: r.concept_code, name: r.concept_name }])).values()];
    const launches = [...new Map(filtersResult.rows.map((r: any) => [r.launch_key, { key: r.launch_key, name: r.launch_name }])).values()];
    const formats = [...new Set(filtersResult.rows.map((r: any) => r.format))].filter(Boolean).sort();

    // Campaign + adset options from classified_insights
    const campaignResult = await db.execute({
      sql: `
        SELECT DISTINCT ci.campaign_name, ci.adset_name
        FROM classified_insights ci
        INNER JOIN ad_creatives ac ON ci.ad_name = ac.ad_name
        WHERE ac.workspace_id = ?
          AND ci.date >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'
        ORDER BY ci.campaign_name, ci.adset_name
      `,
      args: [auth.workspace_id, days],
    });
    const campaigns = [...new Set(campaignResult.rows.map((r: any) => r.campaign_name))].sort();
    const adsets = [...new Set(campaignResult.rows.map((r: any) => r.adset_name))].sort();

    // ── 2. Build WHERE clauses ──
    const wheres: string[] = ["ac.workspace_id = ?", "ci.date >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'"];
    const args: any[] = [auth.workspace_id, days];

    if (filterOffer) {
      wheres.push("o.key = ?");
      args.push(filterOffer);
    }
    if (filterConcept) {
      wheres.push("con.code = ?");
      args.push(filterConcept);
    }
    if (filterLaunch) {
      wheres.push("l.key = ?");
      args.push(filterLaunch);
    }
    if (filterFormat) {
      wheres.push("ac.format = ?");
      args.push(filterFormat);
    }
    if (filterCampaign) {
      wheres.push("ci.campaign_name = ?");
      args.push(filterCampaign);
    }
    if (filterAdset) {
      wheres.push("ci.adset_name = ?");
      args.push(filterAdset);
    }

    const whereClause = wheres.join(" AND ");

    // ── 3. Main hierarchical query ──
    const result = await db.execute({
      sql: `
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
        WHERE ${whereClause}
        ORDER BY o.key, concept_code, angle_code, ac.ad_name, ci.date
      `,
      args,
    });

    // ── 4. CRM leads (trio UTM) ──
    const crmResult = await db.execute({
      sql: `
        SELECT
          cl.utm_content AS ad_name,
          cl.utm_campaign AS campaign_name,
          cl.utm_term AS adset_name,
          COUNT(*) AS leads_crm,
          SUM(CASE WHEN cl.is_qualified THEN 1 ELSE 0 END) AS leads_qualified,
          CAST(CAST(cl.subscribed_at AS DATE) AS TEXT) AS dt
        FROM crm_leads cl
        INNER JOIN ad_creatives ac ON cl.utm_content = ac.ad_name AND ac.workspace_id = cl.workspace_id
        WHERE cl.workspace_id = ?
          AND cl.subscribed_at >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'
        GROUP BY cl.utm_content, cl.utm_campaign, cl.utm_term, CAST(cl.subscribed_at AS DATE)
      `,
      args: [auth.workspace_id, days],
    });

    // Index CRM data by ad_name|campaign|adset|date
    const crmIndex: Record<string, { leads_crm: number; leads_qualified: number }> = {};
    for (const r of crmResult.rows as any[]) {
      const key = `${r.ad_name}|${r.campaign_name}|${r.adset_name}|${r.dt}`;
      crmIndex[key] = { leads_crm: Number(r.leads_crm), leads_qualified: Number(r.leads_qualified) };
    }

    // ── 5. Build hierarchical structure ──
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

    for (const row of result.rows as any[]) {
      const cKey = `${row.offer_key}|${row.concept_code}`;
      const aKey = `${cKey}|${row.angle_code}`;
      const adKey = row.ad_name;

      const crmKey = `${row.ad_name}|${row.campaign_name}|${row.adset_name}|${row.date}`;
      const crm = crmIndex[crmKey] || { leads_crm: 0, leads_qualified: 0 };

      // Concept node
      if (!conceptsMap.has(cKey)) {
        conceptsMap.set(cKey, {
          code: row.concept_code,
          name: row.concept_name,
          offer_key: row.offer_key,
          offer_name: row.offer_name,
          spend: 0, impressions: 0, clicks: 0, lpv: 0, leads_meta: 0, leads_crm: 0, leads_qualified: 0,
          angles: [],
        });
      }
      const concept = conceptsMap.get(cKey)!;

      // Angle node
      let angle = concept.angles.find(a => a.code === row.angle_code);
      if (!angle) {
        angle = {
          code: row.angle_code,
          name: row.angle_name,
          motor: row.motor,
          spend: 0, impressions: 0, clicks: 0, lpv: 0, leads_meta: 0, leads_crm: 0, leads_qualified: 0,
          ads: [],
        };
        concept.angles.push(angle);
      }

      // Ad node
      let ad = angle.ads.find(a => a.ad_name === adKey);
      if (!ad) {
        ad = {
          ad_name: row.ad_name,
          format: row.format,
          hook: row.hook || "",
          motor: row.motor,
          status: row.ad_status,
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

      // Day row
      ad.days.push({
        date: row.date,
        campaign: row.campaign_name,
        adset: row.adset_name,
        spend, impressions, clicks, lpv, leads_meta,
        leads_crm: crm.leads_crm,
        leads_qualified: crm.leads_qualified,
      });

      // Aggregate up
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

    // Sort each level by spend desc
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

    // ── 6. Totals ──
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
      total_ads: conceptsList.reduce((s, c) => s + c.angles.reduce((sa, a) => sa + a.ads.length, 0), 0),
    };

    return NextResponse.json({
      filters: { offers, concepts, launches, formats, campaigns, adsets },
      totals,
      concepts: conceptsList,
    });

  } catch (err: any) {
    console.error("Creative performance report error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
