/**
 * Projects CRUD
 * GET /api/projects — list all
 * POST /api/projects — create { name, campaign_filter, description? }
 * PATCH /api/projects — update { id, name?, campaign_filter?, description?, status? }
 * DELETE /api/projects — delete { id }
 *
 * MIGRADO NA FASE 1C (Wave 4):
 *  - getDb() → withWorkspace (RLS escopa projects)
 *  - Queries tipadas via Drizzle
 *  - uuid() manual removido (defaultRandom no schema)
 *  - Filtros workspace_id manuais removidos (RLS cobre)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { asc, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const rows = await withWorkspace(auth.workspace_id, async (tx) =>
    tx.select().from(projects).orderBy(asc(projects.name)),
  );

  return NextResponse.json({ projects: rows });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json();
  if (!body.name || !body.campaign_filter) {
    return NextResponse.json({ error: "name and campaign_filter required" }, { status: 400 });
  }

  const inserted = await withWorkspace(auth.workspace_id, async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({
        workspaceId: auth.workspace_id,
        name: body.name,
        campaignFilter: body.campaign_filter,
        description: body.description ?? "",
        status: body.status ?? "active",
      })
      .returning();
    return row;
  });

  return NextResponse.json(
    { id: inserted.id, name: inserted.name, campaign_filter: inserted.campaignFilter },
    { status: 201 },
  );
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const set: Record<string, unknown> = {};
  if (body.name !== undefined) set.name = body.name;
  if (body.campaign_filter !== undefined) set.campaignFilter = body.campaign_filter;
  if (body.description !== undefined) set.description = body.description;
  if (body.status !== undefined) set.status = body.status;

  if (Object.keys(set).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  set.updatedAt = sql`NOW()`;

  await withWorkspace(auth.workspace_id, async (tx) => {
    await tx.update(projects).set(set).where(eq(projects.id, body.id));
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await withWorkspace(auth.workspace_id, async (tx) => {
    await tx.delete(projects).where(eq(projects.id, id));
  });

  return NextResponse.json({ ok: true });
}
