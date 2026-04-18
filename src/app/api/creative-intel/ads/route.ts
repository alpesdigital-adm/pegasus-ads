/**
 * GET /api/creative-intel/ads?days=7&offer=&concept=&angle=&format=&detail=false
 *
 * Individual ad detail with optional daily breakdown.
 *
 * MIGRADO NA FASE 1C (Wave 3 creative-intel):
 *  - getDb() → withWorkspace (RLS escopa ad_creatives + crm_leads)
 *  - 3 queries em sql`` + 1 query daily-breakdown N+1 (preservado:
 *    legado fazia query por ad, mantido pra evitar mudança de shape)
 *  - 7 filtros workspace_id manuais removidos
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
  const detail = sp.get("detail") === "true";
  const fOffer = sp.get("offer") || "";
  const fConcept = sp.get("concept") || "";
  const fAngle = sp.get("angle") || "";
  const fFormat = sp.get("format") || "";
  const fCampaign = sp.get("campaign") || "";
  const fAdset = sp.get("adset") || "";

  try {
    const filters = [
      days < 9999 ? sql`AND ci.date >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')` : sql``,
      fOffer ? sql`AND o.key = ${fOffer}` : sql``,
      fConcept ? sql`AND COALESCE(con.code, 'PRE') = ${fConcept}` : sql``,
      fAngle ? sql`AND COALESCE(ang.code, '-') = ${fAngle}` : sql``,
      fFormat ? sql`AND ac.format = ${fFormat}` : sql``,
      fCampaign ? sql`AND ci.campaign_name = ${fCampaign}` : sql``,
      fAdset ? sql`AND ci.adset_name = ${fAdset}` : sql``,
    ];
    const crmDateFilter = days < 9999
      ? sql`AND cl.subscribed_at >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')`
      : sql``;

    const { mainRows, crmRows, dailyByAd } = await withWorkspace(
      auth.workspace_id,
      async (tx) => {
        const main = await tx.execute(sql`
          SELECT
            ac.ad_name,
            ac.format,
            ac.hook,
            COALESCE(ac.motor, ang.motor, '-') AS motor,
            ac.status,
            o.key AS offer_key,
            COALESCE(con.code, 'PRE') AS concept_code,
            COALESCE(con.name, ac.concept_label, 'Pre-Conceito') AS concept_name,
            COALESCE(ang.code, '-') AS angle_code,
            COALESCE(ang.name, '-') AS angle_name,
            MAX(ci.ad_id) AS ad_id,
            CAST(COALESCE(SUM(CAST(ci.spend AS FLOAT)), 0) AS FLOAT) AS spend,
            COALESCE(SUM(ci.impressions), 0) AS impressions,
            COALESCE(SUM(ci.link_clicks), 0) AS clicks,
            COALESCE(SUM(ci.leads), 0) AS leads_meta
          FROM ad_creatives ac
          JOIN offers o ON ac.offer_id = o.id
          LEFT JOIN angles ang ON ac.angle_id = ang.id
          LEFT JOIN concepts con ON ang.concept_id = con.id
          INNER JOIN classified_insights ci ON ci.ad_name = ac.ad_name
          WHERE 1=1
            ${filters[0]} ${filters[1]} ${filters[2]} ${filters[3]}
            ${filters[4]} ${filters[5]} ${filters[6]}
          GROUP BY ac.ad_name, ac.format, ac.hook, ac.motor, ang.motor, ac.status,
                   o.key, con.code, con.name, ac.concept_label, ang.code, ang.name
          ORDER BY SUM(CAST(ci.spend AS FLOAT)) DESC
        `);
        const mainData = main as unknown as Array<Record<string, unknown>>;

        const crm = await tx.execute(sql`
          SELECT cl.utm_content AS ad_name,
                 COUNT(*) AS leads_crm,
                 SUM(CASE WHEN cl.is_qualified THEN 1 ELSE 0 END) AS leads_qualified
          FROM crm_leads cl
          INNER JOIN ad_creatives ac ON cl.utm_content = ac.ad_name
          WHERE 1=1 ${crmDateFilter}
          GROUP BY cl.utm_content
        `);
        const crmData = crm as unknown as Array<Record<string, unknown>>;

        // Daily breakdown se solicitado — N+1 preservado do legado
        const daysFilter = days < 9999
          ? sql`AND ci.date >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')`
          : sql``;
        const daily: Record<string, Array<Record<string, unknown>>> = {};
        if (detail) {
          for (const row of mainData) {
            const adName = row.ad_name as string;
            const dayResult = await tx.execute(sql`
              SELECT
                CAST(ci.date AS TEXT) AS date,
                ci.campaign_name AS campaign,
                ci.adset_name AS adset,
                CAST(COALESCE(ci.spend, 0) AS FLOAT) AS spend,
                COALESCE(ci.impressions, 0) AS impressions,
                COALESCE(ci.link_clicks, 0) AS clicks,
                COALESCE(ci.leads, 0) AS leads_meta
              FROM classified_insights ci
              WHERE ci.ad_name = ${adName} ${daysFilter}
              ORDER BY ci.date DESC
            `);
            daily[adName] = dayResult as unknown as Array<Record<string, unknown>>;
          }
        }

        return { mainRows: mainData, crmRows: crmData, dailyByAd: daily };
      },
    );

    const crmMap: Record<string, { crm: number; qual: number }> = {};
    for (const r of crmRows) {
      crmMap[r.ad_name as string] = {
        crm: Number(r.leads_crm),
        qual: Number(r.leads_qualified),
      };
    }

    const data = mainRows.map((row) => {
      const adName = row.ad_name as string;
      const crm = crmMap[adName] || { crm: 0, qual: 0 };
      const spend = Number(row.spend);
      const impressions = Number(row.impressions);
      const clicks = Number(row.clicks);
      const leadsMeta = Number(row.leads_meta);

      return {
        ad_name: adName,
        ad_id: row.ad_id || "",
        format: row.format,
        hook: row.hook || "",
        motor: row.motor,
        status: row.status,
        offer_key: row.offer_key,
        concept_code: row.concept_code,
        concept_name: row.concept_name,
        angle_code: row.angle_code,
        angle_name: row.angle_name,
        spend,
        impressions,
        clicks,
        ctr: impressions > 0 ? Math.round((clicks / impressions * 100) * 100) / 100 : 0,
        cpm: impressions > 0 ? Math.round((spend / impressions * 1000) * 100) / 100 : 0,
        leads_meta: leadsMeta,
        leads_crm: crm.crm,
        leads_qualified: crm.qual,
        cpl_meta: leadsMeta > 0 ? Math.round((spend / leadsMeta) * 100) / 100 : 0,
        cpl_crm: crm.crm > 0 ? Math.round((spend / crm.crm) * 100) / 100 : 0,
        days: detail
          ? (dailyByAd[adName] ?? []).map((d) => ({
              date: d.date,
              campaign: d.campaign,
              adset: d.adset,
              spend: Number(d.spend),
              impressions: Number(d.impressions),
              clicks: Number(d.clicks),
              leads_meta: Number(d.leads_meta),
            }))
          : [],
      };
    });

    return NextResponse.json({ data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("GET /api/creative-intel/ads error:", message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
