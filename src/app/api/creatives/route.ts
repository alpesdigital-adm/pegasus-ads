/**
 * POST /api/creatives — Import creative (manual, não-gerado por IA).
 *   body JSON ou multipart com { name, file|url, parent_id?, status?, prompt? }
 *
 * GET  /api/creatives — Lista creatives com métricas agregadas.
 *   params: status, parent_id, limit, offset
 *
 * MIGRADO NA FASE 1C (Wave 3):
 *  - getDb() → withWorkspace (RLS scoped)
 *  - INSERTs em Drizzle typed + defaultRandom cobre id + edge id
 *  - GET com aggregate via sql`` — subselects por métrica preservam shape
 *    original (total_spend, avg_cpm etc). RLS cobre c.workspace_id e
 *    m.workspace_id em todas as subqueries
 *  - Filtros manuais workspace_id removidos (8 instâncias no legado)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { creatives, creativeEdges } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { put } from "@vercel/blob";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";

// POST: Import an existing creative (not AI-generated)
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const contentType = req.headers.get("content-type") || "";

    let name: string;
    let blobUrl: string;
    let parentId: string | null = null;
    let status = "testing";
    let generation = 0;
    let metaAdId: string | null = null;
    let prompt: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      name = formData.get("name") as string;
      const file = formData.get("file") as File | null;
      const url = formData.get("url") as string | null;
      parentId = formData.get("parent_id") as string | null;
      status = (formData.get("status") as string) || "testing";
      metaAdId = formData.get("meta_ad_id") as string | null;
      prompt = formData.get("prompt") as string | null;

      if (!name) {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }

      if (file) {
        const ext = file.name.split(".").pop() || "png";
        const blob = await put(`creatives/${uuid()}.${ext}`, file, {
          access: "public",
          contentType: file.type,
        });
        blobUrl = blob.url;
      } else if (url) {
        blobUrl = url;
      } else {
        return NextResponse.json({ error: "file or url required" }, { status: 400 });
      }
    } else {
      const body = await req.json();
      name = body.name;
      blobUrl = body.blob_url;
      parentId = body.parent_id || null;
      status = body.status || "testing";
      metaAdId = body.meta_ad_id || null;
      prompt = body.prompt || null;
      generation = body.generation || 0;

      if (!name || !blobUrl) {
        return NextResponse.json({ error: "name and blob_url are required" }, { status: 400 });
      }
    }

    const created = await withWorkspace(auth.workspace_id, async (tx) => {
      // Bump generation from parent if provided
      if (parentId) {
        const parentRows = await tx
          .select({ generation: creatives.generation })
          .from(creatives)
          .where(eq(creatives.id, parentId))
          .limit(1);
        if (parentRows.length > 0) {
          generation = (parentRows[0].generation ?? 0) + 1;
        }
      }

      const inserted = await tx
        .insert(creatives)
        .values({
          workspaceId: auth.workspace_id,
          name,
          blobUrl,
          prompt,
          parentId,
          generation,
          status,
        })
        .returning({ id: creatives.id });

      const id = inserted[0].id as string;

      if (parentId) {
        await tx.insert(creativeEdges).values({
          workspaceId: auth.workspace_id,
          sourceId: parentId,
          targetId: id,
          relationship: "variation",
        });
      }

      return { id };
    });

    const creative = {
      id: created.id,
      name,
      blob_url: blobUrl,
      prompt,
      parent_id: parentId,
      generation,
      status,
      meta_ad_id: metaAdId,
      created_at: new Date().toISOString(),
    };
    return NextResponse.json({ creative }, { status: 201 });
  } catch (error) {
    console.error("Import creative error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const parent_id = searchParams.get("parent_id");
    const limit = parseInt(searchParams.get("limit") || "100");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Filters aplicáveis dentro do workspace (RLS cobre o resto)
    const filters = [
      status ? sql`AND c.status = ${status}` : sql``,
      parent_id ? sql`AND c.parent_id = ${parent_id}` : sql``,
    ];

    const rows = await withWorkspace(auth.workspace_id, async (tx) => {
      // Aggregate via correlated subqueries — RLS em c e m filtra por
      // workspace automaticamente. Sem workspace_id manual nos WHEREs.
      const result = await tx.execute(sql`
        SELECT c.*,
          (SELECT SUM(m.spend) FROM metrics m WHERE m.creative_id = c.id) AS total_spend,
          (SELECT SUM(m.impressions) FROM metrics m WHERE m.creative_id = c.id) AS total_impressions,
          (SELECT SUM(m.clicks) FROM metrics m WHERE m.creative_id = c.id) AS total_clicks,
          (SELECT SUM(m.leads) FROM metrics m WHERE m.creative_id = c.id) AS total_leads,
          (SELECT AVG(m.cpm) FROM metrics m WHERE m.creative_id = c.id) AS avg_cpm,
          (SELECT AVG(m.ctr) FROM metrics m WHERE m.creative_id = c.id) AS avg_ctr,
          (SELECT AVG(m.cpc) FROM metrics m WHERE m.creative_id = c.id AND m.cpc > 0) AS avg_cpc
        FROM creatives c
        WHERE 1=1
          ${filters[0]}
          ${filters[1]}
        ORDER BY c.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      return result as unknown as Array<Record<string, unknown>>;
    });

    const creativesList = rows.map((row) => {
      const totalSpend = Number(row.total_spend) || 0;
      const totalLeads = Number(row.total_leads) || 0;
      return {
        ...row,
        metrics: {
          total_spend: totalSpend,
          total_impressions: Number(row.total_impressions) || 0,
          total_clicks: Number(row.total_clicks) || 0,
          total_leads: totalLeads,
          avg_cpm: Number(row.avg_cpm) || 0,
          avg_ctr: Number(row.avg_ctr) || 0,
          avg_cpc: Number(row.avg_cpc) || 0,
          cpl: totalLeads > 0 ? totalSpend / totalLeads : null,
        },
      };
    });

    return NextResponse.json({ creatives: creativesList, count: creativesList.length });
  } catch (error) {
    console.error("List creatives error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
