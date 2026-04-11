/**
 * Projects CRUD
 * GET /api/projects — list all
 * POST /api/projects — create { name, campaign_filter, description? }
 * PATCH /api/projects — update { id, name?, campaign_filter?, description?, status? }
 * DELETE /api/projects — delete { id }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const db = getDb();
  const result = await db.execute({
    sql: "SELECT * FROM projects WHERE workspace_id = ? ORDER BY name ASC",
    args: [auth.workspace_id],
  });
  return NextResponse.json({ projects: result.rows });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json();
  if (!body.name || !body.campaign_filter) {
    return NextResponse.json({ error: "name and campaign_filter required" }, { status: 400 });
  }

  const db = getDb();
  const id = uuid();
  await db.execute({
    sql: `INSERT INTO projects (id, workspace_id, name, campaign_filter, description, status)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, auth.workspace_id, body.name, body.campaign_filter, body.description || "", body.status || "active"],
  });

  return NextResponse.json({ id, name: body.name, campaign_filter: body.campaign_filter }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const updates: string[] = [];
  const args: unknown[] = [];

  for (const field of ["name", "campaign_filter", "description", "status"]) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`);
      args.push(body[field]);
    }
  }
  if (updates.length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  updates.push("updated_at = NOW()");
  args.push(body.id, auth.workspace_id);

  const db = getDb();
  await db.execute({
    sql: `UPDATE projects SET ${updates.join(", ")} WHERE id = ? AND workspace_id = ?`,
    args,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const db = getDb();
  await db.execute({
    sql: "DELETE FROM projects WHERE id = ? AND workspace_id = ?",
    args: [id, auth.workspace_id],
  });

  return NextResponse.json({ ok: true });
}
