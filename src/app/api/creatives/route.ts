import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { put } from "@vercel/blob";
import { v4 as uuid } from "uuid";

// POST: Import an existing creative (not AI-generated)
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
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
        blobUrl = url; // Use external URL directly
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

    if (parentId) {
      const parentRow = await db.execute({
        sql: "SELECT generation FROM creatives WHERE id = ? AND workspace_id = ?",
        args: [parentId, auth.workspace_id],
      });
      if (parentRow.rows.length > 0) {
        generation = (parentRow.rows[0].generation as number) + 1;
      }
    }

    const id = uuid();
    await db.execute({
      sql: `INSERT INTO creatives (id, name, blob_url, prompt, parent_id, generation, status, workspace_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name, blobUrl, prompt, parentId, generation, status, auth.workspace_id],
    });

    // Create edge if parent exists
    if (parentId) {
      const edgeId = uuid();
      await db.execute({
        sql: `INSERT INTO creative_edges (id, source_id, target_id, relationship)
              VALUES (?, ?, ?, 'variation')`,
        args: [edgeId, parentId, id],
      });
    }

    const creative = { id, name, blob_url: blobUrl, prompt, parent_id: parentId, generation, status, meta_ad_id: metaAdId, created_at: new Date().toISOString() };
    return NextResponse.json({ creative }, { status: 201 });
  } catch (error) {
    console.error("Import creative error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const { searchParams } = new URL(req.url);

    const status = searchParams.get("status");
    const parent_id = searchParams.get("parent_id");
    const limit = parseInt(searchParams.get("limit") || "100");
    const offset = parseInt(searchParams.get("offset") || "0");

    let sql = `
      SELECT c.*,
        (SELECT SUM(m.spend) FROM metrics m WHERE m.creative_id = c.id AND m.workspace_id = ?) as total_spend,
        (SELECT SUM(m.impressions) FROM metrics m WHERE m.creative_id = c.id AND m.workspace_id = ?) as total_impressions,
        (SELECT SUM(m.clicks) FROM metrics m WHERE m.creative_id = c.id AND m.workspace_id = ?) as total_clicks,
        (SELECT SUM(m.leads) FROM metrics m WHERE m.creative_id = c.id AND m.workspace_id = ?) as total_leads,
        (SELECT AVG(m.cpm) FROM metrics m WHERE m.creative_id = c.id AND m.workspace_id = ?) as avg_cpm,
        (SELECT AVG(m.ctr) FROM metrics m WHERE m.creative_id = c.id AND m.workspace_id = ?) as avg_ctr,
        (SELECT AVG(m.cpc) FROM metrics m WHERE m.creative_id = c.id AND m.workspace_id = ? AND m.cpc > 0) as avg_cpc
      FROM creatives c
      WHERE c.workspace_id = ?
    `;
    const wsId = auth.workspace_id;
    const args: (string | number)[] = [wsId, wsId, wsId, wsId, wsId, wsId, wsId, wsId];

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
