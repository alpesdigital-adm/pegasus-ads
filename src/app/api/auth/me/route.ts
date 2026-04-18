/**
 * GET /api/auth/me
 *
 * Retorna usuário autenticado + workspace atual + lista de workspaces.
 *
 * Errors:
 * - 401 UNAUTHORIZED: não autenticado
 *
 * MIGRADO NA FASE 1C (Wave 1 auth):
 *  - initDb()/getDb() → dbAdmin
 *  - 1 query em Drizzle typed builder
 *  - getUserWorkspaces continua legado (será migrado junto com workspace.ts)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, AuthContext } from "@/lib/auth";
import { dbAdmin } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getUserWorkspaces } from "@/lib/workspace";
import { eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  const userRows = await dbAdmin
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatar_url: users.avatarUrl,
      created_at: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, ctx.user_id))
    .limit(1);

  if (userRows.length === 0) {
    return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
  }

  const workspaces = await getUserWorkspaces(ctx.user_id);

  return NextResponse.json({
    user: userRows[0],
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
