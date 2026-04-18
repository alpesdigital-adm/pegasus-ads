/**
 * PATCH /api/creatives/[id]/metrics — Upsert métricas diárias manuais.
 * GET   /api/creatives/[id]/metrics — Lista métricas do criativo.
 *
 * MIGRADO NA FASE 1C (Wave 3):
 *  - getDb() → withWorkspace (RLS)
 *  - 5 queries → Drizzle typed (SELECT + UPSERT + aggregate + UPDATE)
 *  - uuid() manual removido (defaultRandom cobre)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { creatives, metrics } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { eq } from "drizzle-orm";
import type { UpdateMetricsRequest } from "@/lib/types";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const body: UpdateMetricsRequest = await req.json();

    if (!body.date) {
      return NextResponse.json({ error: "date is required" }, { status: 400 });
    }

    const result = await withWorkspace(auth.workspace_id, async (tx) => {
      // Check creative existe no workspace (RLS)
      const creativeRows = await tx
        .select({ id: creatives.id, status: creatives.status })
        .from(creatives)
        .where(eq(creatives.id, id))
        .limit(1);
      if (creativeRows.length === 0) return { error: "not_found" as const };

      // UPSERT métricas
      await tx
        .insert(metrics)
        .values({
          workspaceId: auth.workspace_id,
          creativeId: id,
          date: body.date,
          spend: body.spend || 0,
          impressions: body.impressions || 0,
          cpm: body.cpm || 0,
          ctr: body.ctr || 0,
          clicks: body.clicks || 0,
          cpc: body.cpc || 0,
          leads: body.leads || 0,
          cpl: body.cpl ?? null,
          metaAdId: body.meta_ad_id ?? null,
        })
        .onConflictDoUpdate({
          target: [metrics.creativeId, metrics.date],
          set: {
            spend: sql`EXCLUDED.spend`,
            impressions: sql`EXCLUDED.impressions`,
            cpm: sql`EXCLUDED.cpm`,
            ctr: sql`EXCLUDED.ctr`,
            clicks: sql`EXCLUDED.clicks`,
            cpc: sql`EXCLUDED.cpc`,
            leads: sql`EXCLUDED.leads`,
            cpl: sql`EXCLUDED.cpl`,
            metaAdId: sql`COALESCE(EXCLUDED.meta_ad_id, metrics.meta_ad_id)`,
          },
        });

      // Aggregate para response + decidir se precisa promover status
      const aggResult = await tx.execute(sql`
        SELECT SUM(spend) AS total_spend, SUM(leads) AS total_leads
        FROM metrics
        WHERE creative_id = ${id}
      `);
      const aggRows = aggResult as unknown as Array<Record<string, unknown>>;
      const totalSpend = Number(aggRows[0]?.total_spend ?? 0);
      const totalLeads = Number(aggRows[0]?.total_leads ?? 0);

      // Promover 'generated' → 'testing' se tem métricas
      if (creativeRows[0].status === "generated") {
        await tx
          .update(creatives)
          .set({ status: "testing" })
          .where(eq(creatives.id, id));
      }

      return { totalSpend, totalLeads };
    });

    if ("error" in result && result.error === "not_found") {
      return NextResponse.json({ error: "Creative not found" }, { status: 404 });
    }

    const { totalSpend, totalLeads } = result as { totalSpend: number; totalLeads: number };
    const cpl = totalLeads > 0 ? totalSpend / totalLeads : null;

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
      { status: 500 },
    );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const rows = await withWorkspace(auth.workspace_id, async (tx) => {
      return tx
        .select()
        .from(metrics)
        .where(eq(metrics.creativeId, id))
        .orderBy(sql`date DESC`);
    });
    return NextResponse.json({ metrics: rows });
  } catch (error) {
    console.error("Get metrics error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

