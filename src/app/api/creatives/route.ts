import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const db = await initDb();
    const { searchParams } = new URL(request.url);

    const status = searchParams.get("status");
    const parent_id = searchParams.get("parent_id");
    const limit = parseInt(searchParams.get("limit") || "100");
    const offset = parseInt(searchParams.get("offset") || "0");

    let sql = `
      SELECT c.*,
        (SELECT SUM(m.spend) FROM metrics m WHERE m.creative_id = c.id) as total_spend,
        (SELECT SUM(m.impressions) FROM metrics m WHERE m.creative_id = c.id) as total_impressions,
        (SELECT SUM(m.clicks) FROM metrics m WHERE m.creative_id = c.id) as total_clicks,
        (SELECT SUM(m.leads) FROM metrics m WHERE m.creative_id = c.id) as total_leads,
        (SELECT AVG(m.cpm) FROM metrics m WHERE m.creative_id = c.id) as avg_cpm,
        (SELECT AVG(m.ctr) FROM metrics m WHERE m.creative_id = c.id) as avg_ctr,
        (SELECT AVG(m.cpc) FROM metrics m WHERE m.creative_id = c.id AND m.cpc > 0) as avg_cpc
      FROM creatives c
      WHERE 1=1
    `;
    const args: (string | number)[] = [];

    if (status) {
      sql += " AND c.status = ?";
      args.push(status);
    }
    if (parent_id) {
      sql += " AND c.parent_id = ?";
      args.push(parent_id);
    }

    sql += " ORDER BY c.created_at DESC LIMIT ? OFFSET ?";
    args.push(limit, offset);

    const result = await db.execute({ sql, args });

    const creatives = result.rows.map((row) => {
      const totalSpend = (row.total_spend as number) || 0;
      const totalLeads = (row.total_leads as number) || 0;
      return {
        ...row,
        metrics: {
          total_spend: totalSpend,
          total_impressions: (row.total_impressions as number) || 0,
          total_clicks: (row.total_clicks as number) || 0,
          total_leads: totalLeads,
          avg_cpm: (row.avg_cpm as number) || 0,
          avg_ctr: (row.avg_ctr as number) || 0,
          avg_cpc: (row.avg_cpc as number) || 0,
          cpl: totalLeads > 0 ? totalSpend / totalLeads : null,
        },
      };
    });

    return NextResponse.json({ creatives, count: creatives.length });
  } catch (error) {
    console.error("List creatives error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
