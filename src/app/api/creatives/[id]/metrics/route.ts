import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import type { UpdateMetricsRequest } from "@/lib/types";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const body: UpdateMetricsRequest = await req.json();
    const db = getDb();

    // Check creative exists in this workspace
    const creative = await db.execute({
      sql: "SELECT id FROM creatives WHERE id = ? AND workspace_id = ?",
      args: [id, auth.workspace_id],
    });
    if (creative.rows.length === 0) {
      return NextResponse.json({ error: "Creative not found" }, { status: 404 });
    }

    if (!body.date) {
      return NextResponse.json({ error: "date is required" }, { status: 400 });
    }

    // Upsert metrics
    const metricsId = uuid();
    await db.execute({
      sql: `INSERT INTO metrics (id, creative_id, date, spend, impressions, cpm, ctr, clicks, cpc, leads, cpl, meta_ad_id, workspace_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(creative_id, date) DO UPDATE SET
              spend = EXCLUDED.spend,
              impressions = EXCLUDED.impressions,
              cpm = EXCLUDED.cpm,
              ctr = EXCLUDED.ctr,
              clicks = EXCLUDED.clicks,
              cpc = EXCLUDED.cpc,
              leads = EXCLUDED.leads,
              cpl = EXCLUDED.cpl,
              meta_ad_id = COALESCE(EXCLUDED.meta_ad_id, metrics.meta_ad_id)`,
      args: [
        metricsId,
        id,
        body.date,
        body.spend || 0,
        body.impressions || 0,
        body.cpm || 0,
        body.ctr || 0,
        body.clicks || 0,
        body.cpc || 0,
        body.leads || 0,
        body.cpl || null,
        body.meta_ad_id || null,
        auth.workspace_id,
      ],
    });

    // Auto-update creative status based on metrics
    const totalMetrics = await db.execute({
      sql: `SELECT SUM(spend) as total_spend, SUM(leads) as total_leads FROM metrics WHERE creative_id = ? AND workspace_id = ?`,
      args: [id, auth.workspace_id],
    });

    const totalSpend = (totalMetrics.rows[0].total_spend as number) || 0;
    const totalLeads = (totalMetrics.rows[0].total_leads as number) || 0;
    const cpl = totalLeads > 0 ? totalSpend / totalLeads : null;

    // If creative has metrics, mark as testing at minimum
    const currentCreative = await db.execute({
      sql: "SELECT status FROM creatives WHERE id = ? AND workspace_id = ?",
      args: [id, auth.workspace_id],
    });
    if (currentCreative.rows[0].status === "generated") {
      await db.execute({
        sql: "UPDATE creatives SET status = 'testing' WHERE id = ? AND workspace_id = ?",
        args: [id, auth.workspace_id],
      });
    }

    return NextResponse.json({
      creative_id: id,
      date: body.date,
      aggregate: {
        total_spend: totalSpend,
        total_leads: totalLeads,
        cpl,
      },
    });
  } catch (error) {
    console.error("Update metrics error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const db = getDb();

    const result = await db.execute({
      sql: "SELECT * FROM metrics WHERE creative_id = ? AND workspace_id = ? ORDER BY date DESC",
      args: [id, auth.workspace_id],
    });

    return NextResponse.json({ metrics: result.rows });
  } catch (error) {
    console.error("Get metrics error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
