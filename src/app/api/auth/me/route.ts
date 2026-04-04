/**
 * GET /api/auth/me
 *
 * Retorna usuário autenticado + workspace atual + lista de workspaces.
 *
 * Errors:
 * - 401 UNAUTHORIZED: não autenticado
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, AuthContext } from "@/lib/auth";
import { getDb, initDb } from "@/lib/db";
import { getUserWorkspaces } from "@/lib/workspace";

export async function GET(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  const db = getDb();

  const userResult = await db.execute({
    sql: `SELECT id, email, name, avatar_url, created_at FROM users WHERE id = ?`,
    args: [ctx.user_id],
  });

  if (userResult.rows.length === 0) {
    return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
  }

  const workspaces = await getUserWorkspaces(ctx.user_id);

  return NextResponse.json({
    user: userResult.rows[0],
    current_workspace_id: ctx.workspace_id,
    role: ctx.role,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      plan: w.plan,
      role: w.role,
    })),
  });
}
