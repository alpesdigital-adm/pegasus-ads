/**
 * POST /api/workspaces/switch
 *
 * Alterna workspace ativo. Valida que o user é membro e seta o cookie
 * `pegasus_workspace_id` — usado como hint em requests subsequentes.
 *
 * Body: { workspace_id }
 *
 * Errors:
 *  - 401 UNAUTHORIZED — não autenticado
 *  - 400 VALIDATION_ERROR — workspace_id ausente
 *  - 403 NO_ACCESS — usuário não é membro do workspace
 *
 * Fase 2 PR 2c: reescrito — antes atualizava sessions.workspace_id,
 * agora seta cookie (Supabase JWT é stateless).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, setWorkspaceCookie } from "@/lib/auth";
import { dbAdmin } from "@/lib/db";
import { workspaceMembers } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;

  const body = await req.json();
  const { workspace_id } = body;

  if (!workspace_id) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Field required: workspace_id" },
      { status: 400 },
    );
  }

  const membership = await dbAdmin
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, authResult.user_id),
        eq(workspaceMembers.workspaceId, workspace_id),
      ),
    )
    .limit(1);

  if (membership.length === 0) {
    return NextResponse.json(
      { error: "NO_ACCESS", message: "You are not a member of this workspace" },
      { status: 403 },
    );
  }

  const response = NextResponse.json({ ok: true, workspace_id });
  return setWorkspaceCookie(response, workspace_id);
}
