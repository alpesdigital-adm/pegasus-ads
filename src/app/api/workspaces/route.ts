/**
 * GET  /api/workspaces — Lista workspaces do usuário
 * POST /api/workspaces — Cria novo workspace
 *
 * Errors:
 * - 401 UNAUTHORIZED: não autenticado
 * - 400 VALIDATION_ERROR: campos ausentes ou slug duplicado
 * - 409 SLUG_EXISTS: slug já em uso
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, AuthContext } from "@/lib/auth";
import { initDb, getDb } from "@/lib/db";
import { getUserWorkspaces, createWorkspace } from "@/lib/workspace";

export async function GET(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  const workspaces = await getUserWorkspaces(ctx.user_id);

  return NextResponse.json({
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      plan: w.plan,
      role: w.role,
    })),
  });
}

export async function POST(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  const body = await req.json();
  const { name, slug } = body;

  if (!name || !slug) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Fields required: name, slug" },
      { status: 400 }
    );
  }

  if (!/^[a-z0-9-]+$/.test(slug) || slug.length > 40) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Slug must be lowercase alphanumeric with hyphens, max 40 chars" },
      { status: 400 }
    );
  }

  // Check slug uniqueness
  const db = getDb();
  const existing = await db.execute({
    sql: `SELECT id FROM workspaces WHERE slug = ?`,
    args: [slug],
  });
  if (existing.rows.length > 0) {
    return NextResponse.json(
      { error: "SLUG_EXISTS", message: "A workspace with this slug already exists" },
      { status: 409 }
    );
  }

  const workspaceId = await createWorkspace({
    name,
    slug,
    owner_user_id: ctx.user_id,
  });

  return NextResponse.json({ id: workspaceId, name, slug, plan: "free" }, { status: 201 });
}
