/**
 * GET /api/creative-intel/performance?days=7&offer=&concept=&angle=&format=&campaign=&adset=&launch=
 *
 * Aggregated performance by concept + angle, with filters.
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
  const fOffer = sp.get("offer") || "";
  const fConcept = sp.get("concept") || "";
  const fAngle = sp.get("angle") || "";
  const fFormat = sp.get("format") || "";
  const fCampaign = sp.get("campaign") || "";
  const fAdset = sp.get("adset") || "";
  const fLaunch = sp.get("launch") || "";

  try {
    const db = getDb();

    // Build WHERE
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
    if (fLaunch) { wheres.push("l.key = ?"); args.push(fLaunch); }

    const result = await db.execute({
      sql: `
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
        WHERE ${wheres.join(" AND ")}
        GROUP BY o.key, con.code, con.name, ac.concept_label, ang.code, ang.name, ac.motor, ang.motor
        ORDER BY SUM(CAST(ci.spend AS FLOAT)) DESC
      `,
      args,
    });

    // CRM leads per concept+angle
    const crmWheres: string[] = ["cl.workspace_id = ?"];
    const crmArgs: any[] = [auth.workspace_id];
    if (days < 9999) {
      crmWheres.push("cl.subscribed_at >= CURRENT_DATE - CAST(? AS INTEGER) * INTERVAL '1 day'");
      crmArgs.push(days);
    }

    const crmResult = await db.execute({
      sql: `
        SELECT
          cl.utm_content AS ad_name,
          COUNT(*) AS leads_crm,
          SUM(CASE WHEN cl.is_qualified THEN 1 ELSE 0 END) AS leads_qualified
        FROM crm_leads cl
        INNER JOIN ad_creatives ac ON cl.utm_content = ac.ad_name AND ac.workspace_id = cl.workspace_id
        WHERE ${crmWheres.join(" AND ")}
        GROUP BY cl.utm_content
      `,
      args: crmArgs,
    });

    // Map CRM by ad_name
    const crmMap: Record<string, { crm: number; qual: number }> = {};
    for (const r of crmResult.rows as any[]) {
      crmMap[r.ad_name] = { crm: Number(r.leads_crm), qual: Number(r.leads_qualified) };
    }

    // We need ad→angle mapping to aggregate CRM to angle level
    const adAngleResult = await db.execute({
      sql: `
        SELECT ac.ad_name,
               o.key AS offer_key,
               COALESCE(con.code, 'PRE') AS concept_code,
               COALESCE(ang.code, '-') AS angle_code
        FROM ad_creatives ac
        JOIN offers o ON ac.offer_id = o.id
        LEFT JOIN angles ang ON ac.angle_id = ang.id
        LEFT JOIN concepts con ON ang.concept_id = con.id
        WHERE ac.workspace_id = ?
      `,
      args: [auth.workspace_id],
    });

    // Aggregate CRM per angle
    const angleCrm: Record<string, { crm: number; qual: number }> = {};
    for (const r of adAngleResult.rows as any[]) {
      const key = `${r.offer_key}|${r.concept_code}|${r.angle_code}`;
      const adCrm = crmMap[r.ad_name] || { crm: 0, qual: 0 };
      if (!angleCrm[key]) angleCrm[key] = { crm: 0, qual: 0 };
      angleCrm[key].crm += adCrm.crm;
      angleCrm[key].qual += adCrm.qual;
    }

    // Build response
    const data = (result.rows as any[]).map(row => {
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
  } catch (err: any) {
    console.error("GET /api/creative-intel/performance error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
