import { NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import type { GraphData, GraphNode, GraphEdge } from "@/lib/types";

export async function GET() {
  try {
    const db = await initDb();

    // Get all creatives with aggregated metrics
    const creativesResult = await db.execute(`
      SELECT c.*,
        (SELECT SUM(m.spend) FROM metrics m WHERE m.creative_id = c.id) as total_spend,
        (SELECT SUM(m.impressions) FROM metrics m WHERE m.creative_id = c.id) as total_impressions,
        (SELECT SUM(m.clicks) FROM metrics m WHERE m.creative_id = c.id) as total_clicks,
        (SELECT SUM(m.leads) FROM metrics m WHERE m.creative_id = c.id) as total_leads,
        (SELECT AVG(m.cpm) FROM metrics m WHERE m.creative_id = c.id) as avg_cpm,
        (SELECT AVG(m.ctr) FROM metrics m WHERE m.creative_id = c.id) as avg_ctr,
        (SELECT AVG(m.cpc) FROM metrics m WHERE m.creative_id = c.id AND m.cpc > 0) as avg_cpc
      FROM creatives c
      ORDER BY c.generation ASC, c.created_at ASC
    `);

    // Get all edges
    const edgesResult = await db.execute(
      "SELECT * FROM creative_edges ORDER BY created_at ASC"
    );

    const nodes: GraphNode[] = creativesResult.rows.map((row) => {
      const totalSpend = (row.total_spend as number) || 0;
      const totalLeads = (row.total_leads as number) || 0;
      return {
        id: row.id as string,
        name: row.name as string,
        thumbnail_url: row.thumbnail_url as string | undefined,
        blob_url: row.blob_url as string,
        status: row.status as GraphNode["status"],
        generation: row.generation as number,
        prompt: row.prompt as string | undefined,
        created_at: row.created_at as string,
        metrics: totalSpend > 0
          ? {
              total_spend: totalSpend,
              total_impressions: (row.total_impressions as number) || 0,
              total_clicks: (row.total_clicks as number) || 0,
              total_leads: totalLeads,
              avg_cpm: (row.avg_cpm as number) || 0,
              avg_ctr: (row.avg_ctr as number) || 0,
              avg_cpc: (row.avg_cpc as number) || 0,
              cpl: totalLeads > 0 ? totalSpend / totalLeads : null,
            }
          : undefined,
      };
    });

    const edges: GraphEdge[] = edgesResult.rows.map((row) => ({
      id: row.id as string,
      source: row.source_id as string,
      target: row.target_id as string,
      relationship: row.relationship as GraphEdge["relationship"],
      variable_isolated: row.variable_isolated as string | undefined,
    }));

    const graph: GraphData = { nodes, edges };
    return NextResponse.json(graph);
  } catch (error) {
    console.error("Graph error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
