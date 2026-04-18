/**
 * GET /api/creative-intel/taxonomy?days=9999
 *
 * Returns the full creative hierarchy: offers → concepts → angles
 * with aggregate metrics (spend, leads_crm, cpl, ad_count).
 *
 * MIGRADO NA FASE 1C (Wave 3 creative-intel):
 *  - getDb() → withWorkspace (RLS escopa ad_creatives, crm_leads,
 *    classified_insights via ad_creatives JOIN policy)
 *  - 2 queries em sql`` com JOIN multi-tabela e date filter dinâmico
 *  - Filtros manuais workspace_id removidos (3 instâncias)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { withWorkspace, sql } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const days = parseInt(req.nextUrl.searchParams.get("days") || "9999", 10);

  try {
    // Date filter dinâmico — só aplica se days < 9999 (sentinel "lifetime")
    const dateFilter = days < 9999
      ? sql`AND ci.date >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')`
      : sql``;
    const crmDateFilter = days < 9999
      ? sql`AND cl.subscribed_at >= CURRENT_DATE - (${days}::INTEGER * INTERVAL '1 day')`
      : sql``;

    const { mainRows, crmRows } = await withWorkspace(auth.workspace_id, async (tx) => {
      const main = await tx.execute(sql`
        SELECT
          o.key AS offer_key,
          o.name AS offer_name,
          o.offer_type,
          o.cpl_target,
          COALESCE(con.code, 'PRE') AS concept_code,
          COALESCE(con.name, ac.concept_label, 'Pre-Conceito') AS concept_name,
          COALESCE(ang.code, '-') AS angle_code,
          COALESCE(ang.name, '-') AS angle_name,
          COALESCE(ac.motor, ang.motor, '-') AS motor,
          ac.ad_name,
          CAST(COALESCE(SUM(CAST(ci.spend AS FLOAT)), 0) AS FLOAT) AS spend,
          COALESCE(SUM(ci.leads), 0) AS leads_meta
        FROM ad_creatives ac
        JOIN offers o ON ac.offer_id = o.id
        LEFT JOIN angles ang ON ac.angle_id = ang.id
        LEFT JOIN concepts con ON ang.concept_id = con.id
        LEFT JOIN classified_insights ci ON ci.ad_name = ac.ad_name ${dateFilter}
        GROUP BY o.key, o.name, o.offer_type, o.cpl_target,
                 con.code, con.name, ac.concept_label,
                 ang.code, ang.name, ac.motor, ang.motor, ac.ad_name
        ORDER BY o.key, concept_code, angle_code, ac.ad_name
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

      return {
        mainRows: main as unknown as Array<Record<string, unknown>>,
        crmRows: crm as unknown as Array<Record<string, unknown>>,
      };
    });

    const crmMap: Record<string, { crm: number; qual: number }> = {};
    for (const r of crmRows) {
      crmMap[r.ad_name as string] = {
        crm: Number(r.leads_crm),
        qual: Number(r.leads_qualified),
      };
    }

    // Build hierarchy
    interface AngleNode { code: string; name: string; motor: string; spend: number; leads_crm: number; cpl_crm: number; ad_count: number; }
    interface ConceptNode { code: string; name: string; spend: number; leads_crm: number; cpl_crm: number; ad_count: number; angles: AngleNode[]; }
    interface OfferNode { key: string; name: string; offer_type: string; cpl_target: number | null; spend: number; leads_crm: number; cpl_crm: number; ad_count: number; concepts: ConceptNode[]; }

    const offersMap = new Map<string, OfferNode>();

    for (const row of mainRows) {
      const adCrm = crmMap[row.ad_name as string] || { crm: 0, qual: 0 };
      const spend = Number(row.spend) || 0;

      if (!offersMap.has(row.offer_key as string)) {
        offersMap.set(row.offer_key as string, {
          key: row.offer_key as string,
          name: row.offer_name as string,
          offer_type: row.offer_type as string,
          cpl_target: row.cpl_target ? Number(row.cpl_target) : null,
          spend: 0, leads_crm: 0, cpl_crm: 0, ad_count: 0, concepts: [],
        });
      }
      const offer = offersMap.get(row.offer_key as string)!;

      let concept = offer.concepts.find((c) => c.code === row.concept_code);
      if (!concept) {
        concept = {
          code: row.concept_code as string,
          name: row.concept_name as string,
          spend: 0, leads_crm: 0, cpl_crm: 0, ad_count: 0, angles: [],
        };
        offer.concepts.push(concept);
      }

      let angle = concept.angles.find((a) => a.code === row.angle_code);
      if (!angle) {
        angle = {
          code: row.angle_code as string,
          name: row.angle_name as string,
          motor: row.motor as string,
          spend: 0, leads_crm: 0, cpl_crm: 0, ad_count: 0,
        };
        concept.angles.push(angle);
      }

      angle.spend += spend;
      angle.leads_crm += adCrm.crm;
      angle.ad_count += 1;

      concept.spend += spend;
      concept.leads_crm += adCrm.crm;
      concept.ad_count += 1;

      offer.spend += spend;
      offer.leads_crm += adCrm.crm;
      offer.ad_count += 1;
    }

    for (const offer of offersMap.values()) {
      offer.cpl_crm = offer.leads_crm > 0 ? Math.round((offer.spend / offer.leads_crm) * 100) / 100 : 0;
      for (const c of offer.concepts) {
        c.cpl_crm = c.leads_crm > 0 ? Math.round((c.spend / c.leads_crm) * 100) / 100 : 0;
        c.angles.sort((a, b) => b.spend - a.spend);
        for (const a of c.angles) {
          a.cpl_crm = a.leads_crm > 0 ? Math.round((a.spend / a.leads_crm) * 100) / 100 : 0;
        }
      }
      offer.concepts.sort((a, b) => b.spend - a.spend);
    }

    return NextResponse.json({
      offers: [...offersMap.values()].sort((a, b) => b.spend - a.spend),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("GET /api/creative-intel/taxonomy error:", message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
