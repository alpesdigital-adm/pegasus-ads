/**
 * GET /api/creative-intel/performance?days=7&offer=&concept=&angle=&format=&campaign=&adset=&launch=
 *
 * Aggregated performance by concept + angle, with filters.
 *
 * MIGRADO NA FASE 1C (Wave 3 creative-intel):
 *  - getDb() → withWorkspace (RLS escopa ad_creatives + crm_leads + ci)
 *  - 3 queries em sql`` (main aggregate + CRM + ad→angle map)
 *  - Filtros dinâmicos via sql`` fragments compostos
 *  - 5 filtros workspace_id manuais removidos
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { withWorkspace, sql } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const sp = req.nextUrl.searchParams;
  const days = parseInt(sp.get("days") || "7", 10);
  const fOffer = sp.get("offer") || "";
  const fConcept = sp.get("concept") || "";
  const fAngle = sp.get("angle") || "";
  const fFormat = sp.get("format") || "";
  const fCampaign = sp.get("campaign") || "";
  const fAdset = sp.get("adset") || "";
  const fLaunch = sp.get("launch") || "";

  try {
    // Filtros dinâmicos como sql`` fragments — concatenados via sql`` template
    const filters = [
      days < 9999 ? sql`AND ci.date >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')` : sql``,
      fOffer ? sql`AND o.key = ${fOffer}` : sql``,
      fConcept ? sql`AND COALESCE(con.code, 'PRE') = ${fConcept}` : sql``,
      fAngle ? sql`AND COALESCE(ang.code, '-') = ${fAngle}` : sql``,
      fFormat ? sql`AND ac.format = ${fFormat}` : sql``,
      fCampaign ? sql`AND ci.campaign_name = ${fCampaign}` : sql``,
      fAdset ? sql`AND ci.adset_name = ${fAdset}` : sql``,
      fLaunch ? sql`AND l.key = ${fLaunch}` : sql``,
    ];
    const crmDateFilter = days < 9999
      ? sql`AND cl.subscribed_at >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')`
      : sql``;

    const { mainRows, crmRows, adAngleRows } = await withWorkspace(
      auth.workspace_id,
      async (tx) => {
        const main = await tx.execute(sql`
          SELECT
            o.key AS offer_key,
            COALESCE(con.code, 'PRE') AS concept_code,
            COALESCE(con.name, ac.concept_label, 'Pre-Conceito') AS concept_name,
            COALESCE(ang.code, '-') AS angle_code,
            COALESCE(ang.name, '-') AS angle_name,
            COALESCE(ac.motor, ang.motor, '-') AS motor,
            COUNT(DISTINCT ac.ad_name) AS ad_count,
            CAST(COALESCE(SUM(CAST(ci.spend AS FLOAT)), 0) AS FLOAT) AS spend,
            COALESCE(SUM(ci.impressions), 0) AS impressions,
            COALESCE(SUM(ci.link_clicks), 0) AS clicks,
            COALESCE(SUM(ci.leads), 0) AS leads_meta
          FROM ad_creatives ac
          JOIN offers o ON ac.offer_id = o.id
          JOIN launches l ON ac.launch_id = l.id
          LEFT JOIN angles ang ON ac.angle_id = ang.id
          LEFT JOIN concepts con ON ang.concept_id = con.id
          INNER JOIN classified_insights ci ON ci.ad_name = ac.ad_name
          WHERE 1=1
            ${filters[0]} ${filters[1]} ${filters[2]} ${filters[3]}
            ${filters[4]} ${filters[5]} ${filters[6]} ${filters[7]}
          GROUP BY o.key, con.code, con.name, ac.concept_label,
                   ang.code, ang.name, ac.motor, ang.motor
          ORDER BY SUM(CAST(ci.spend AS FLOAT)) DESC
        `);

        const crm = await tx.execute(sql`
          SELECT
            cl.utm_content AS ad_name,
            COUNT(*) AS leads_crm,
            SUM(CASE WHEN cl.is_qualified THEN 1 ELSE 0 END) AS leads_qualified
          FROM crm_leads cl
          INNER JOIN ad_creatives ac ON cl.utm_content = ac.ad_name
          WHERE 1=1 ${crmDateFilter}
          GROUP BY cl.utm_content
        `);

        const adAngle = await tx.execute(sql`
          SELECT ac.ad_name,
                 o.key AS offer_key,
                 COALESCE(con.code, 'PRE') AS concept_code,
                 COALESCE(ang.code, '-') AS angle_code
          FROM ad_creatives ac
          JOIN offers o ON ac.offer_id = o.id
          LEFT JOIN angles ang ON ac.angle_id = ang.id
          LEFT JOIN concepts con ON ang.concept_id = con.id
        `);

        return {
          mainRows: main as unknown as Array<Record<string, unknown>>,
          crmRows: crm as unknown as Array<Record<string, unknown>>,
          adAngleRows: adAngle as unknown as Array<Record<string, unknown>>,
        };
      },
    );

    const crmMap: Record<string, { crm: number; qual: number }> = {};
    for (const r of crmRows) {
      crmMap[r.ad_name as string] = {
        crm: Number(r.leads_crm),
        qual: Number(r.leads_qualified),
      };
    }

    const angleCrm: Record<string, { crm: number; qual: number }> = {};
    for (const r of adAngleRows) {
      const key = `${r.offer_key}|${r.concept_code}|${r.angle_code}`;
      const adCrm = crmMap[r.ad_name as string] || { crm: 0, qual: 0 };
      if (!angleCrm[key]) angleCrm[key] = { crm: 0, qual: 0 };
      angleCrm[key].crm += adCrm.crm;
      angleCrm[key].qual += adCrm.qual;
    }

    const data = mainRows.map((row) => {
      const key = `${row.offer_key}|${row.concept_code}|${row.angle_code}`;
      const crm = angleCrm[key] || { crm: 0, qual: 0 };
      const spend = Number(row.spend);
      const impressions = Number(row.impressions);
      const clicks = Number(row.clicks);
      return {
        offer_key: row.offer_key,
        concept_code: row.concept_code,
        concept_name: row.concept_name,
        angle_code: row.angle_code,
        angle_name: row.angle_name,
        motor: row.motor,
        ad_count: Number(row.ad_count),
        spend,
        impressions,
        clicks,
        ctr: impressions > 0 ? Math.round((clicks / impressions * 100) * 100) / 100 : 0,
        cpm: impressions > 0 ? Math.round((spend / impressions * 1000) * 100) / 100 : 0,
        leads_meta: Number(row.leads_meta),
        leads_crm: crm.crm,
        leads_qualified: crm.qual,
        cpl_meta: Number(row.leads_meta) > 0 ? Math.round((spend / Number(row.leads_meta)) * 100) / 100 : 0,
        cpl_crm: crm.crm > 0 ? Math.round((spend / crm.crm) * 100) / 100 : 0,
      };
    });

    return NextResponse.json({ data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("GET /api/creative-intel/performance error:", message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
