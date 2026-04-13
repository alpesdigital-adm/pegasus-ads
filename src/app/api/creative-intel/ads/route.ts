/**
 * GET /api/creative-intel/ads?days=7&offer=&concept=&angle=&format=&detail=false
 *
 * Individual ad detail with optional daily breakdown.
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
  const detail = sp.get("detail") === "true";
  const fOffer = sp.get("offer") || "";
  const fConcept = sp.get("concept") || "";
  const fAngle = sp.get("angle") || "";
  const fFormat = sp.get("format") || "";
  const fCampaign = sp.get("campaign") || "";
  const fAdset = sp.get("adset") || "";

  try {
    const db = getDb();

    const wheres: string[] = ["ac.workspace_id = ?"];
    const args: any[] = [auth.workspace_id];

    if (days < 9999) {
      wheres.push("ci.date >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'");
      args.push(days);
    }
    if (fOffer) { wheres.push("o.key = ?"); args.push(fOffer); }
    if (fConcept) { wheres.push("COALESCE(con.code, 'PRE') = ?"); args.push(fConcept); }
    if (fAngle) { wheres.push("COALESCE(ang.code, '-') = ?"); args.push(fAngle); }
    if (fFormat) { wheres.push("ac.format = ?"); args.push(fFormat); }
    if (fCampaign) { wheres.push("ci.campaign_name = ?"); args.push(fCampaign); }
    if (fAdset) { wheres.push("ci.adset_name = ?"); args.push(fAdset); }

    // Main query: one row per ad
    const result = await db.execute({
      sql: `
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
          CAST(COALESCE(SUM(CAST(ci.spend AS FLOAT)), 0) AS FLOAT) AS spend,
          COALESCE(SUM(ci.impressions), 0) AS impressions,
          COALESCE(SUM(ci.link_clicks), 0) AS clicks,
          COALESCE(SUM(ci.leads), 0) AS leads_meta
        FROM ad_creatives ac
        JOIN offers o ON ac.offer_id = o.id
        LEFT JOIN angles ang ON ac.angle_id = ang.id
        LEFT JOIN concepts con ON ang.concept_id = con.id
        INNER JOIN classified_insights ci ON ci.ad_name = ac.ad_name
        WHERE ${wheres.join(" AND ")}
        GROUP BY ac.ad_name, ac.format, ac.hook, ac.motor, ang.motor, ac.status,
                 o.key, con.code, con.name, ac.concept_label, ang.code, ang.name
        ORDER BY SUM(CAST(ci.spend AS FLOAT)) DESC
      `,
      args,
    });

    // CRM per ad
    const crmWheres: string[] = ["cl.workspace_id = ?"];
    const crmArgs: any[] = [auth.workspace_id];
    if (days < 9999) {
      crmWheres.push("cl.subscribed_at >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'");
      crmArgs.push(days);
    }

    const crmResult = await db.execute({
      sql: `
        SELECT cl.utm_content AS ad_name,
               COUNT(*) AS leads_crm,
               SUM(CASE WHEN cl.is_qualified THEN 1 ELSE 0 END) AS leads_qualified
        FROM crm_leads cl
        INNER JOIN ad_creatives ac ON cl.utm_content = ac.ad_name AND ac.workspace_id = cl.workspace_id
        WHERE ${crmWheres.join(" AND ")}
        GROUP BY cl.utm_content
      `,
      args: crmArgs,
    });

    const crmMap: Record<string, { crm: number; qual: number }> = {};
    for (const r of crmResult.rows as any[]) {
      crmMap[r.ad_name] = { crm: Number(r.leads_crm), qual: Number(r.leads_qualified) };
    }

    // Build response
    const data = (result.rows as any[]).map(row => {
      const crm = crmMap[row.ad_name] || { crm: 0, qual: 0 };
      const spend = Number(row.spend);
      const impressions = Number(row.impressions);
      const clicks = Number(row.clicks);
      const leadsMeta = Number(row.leads_meta);

      return {
        ad_name: row.ad_name,
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
        days: [] as any[],
      };
    });

    // Daily breakdown if requested
    if (detail) {
      for (const ad of data) {
        const dayWheres = ["ci.ad_name = ?"];
        const dayArgs: any[] = [ad.ad_name];
        if (days < 9999) {
          dayWheres.push("ci.date >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'");
          dayArgs.push(days);
        }

        const dayResult = await db.execute({
          sql: `
            SELECT
              CAST(ci.date AS TEXT) AS date,
              ci.campaign_name AS campaign,
              ci.adset_name AS adset,
              CAST(COALESCE(ci.spend, 0) AS FLOAT) AS spend,
              COALESCE(ci.impressions, 0) AS impressions,
              COALESCE(ci.link_clicks, 0) AS clicks,
              COALESCE(ci.leads, 0) AS leads_meta
            FROM classified_insights ci
            WHERE ${dayWheres.join(" AND ")}
            ORDER BY ci.date DESC
          `,
          args: dayArgs,
        });

        ad.days = (dayResult.rows as any[]).map(d => ({
          date: d.date,
          campaign: d.campaign,
          adset: d.adset,
          spend: Number(d.spend),
          impressions: Number(d.impressions),
          clicks: Number(d.clicks),
          leads_meta: Number(d.leads_meta),
        }));
      }
    }

    return NextResponse.json({ data });
  } catch (err: any) {
    console.error("GET /api/creative-intel/ads error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
