/**
 * POST /api/workspaces/switch
 *
 * Alterna workspace ativo na sessão.
 *
 * Body: { workspace_id }
 *
 * Errors:
 * - 401 UNAUTHORIZED: não autenticado
 * - 400 VALIDATION_ERROR: workspace_id ausente
 * - 403 NO_ACCESS: usuário não é membro do workspace
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, switchWorkspace, AuthContext } from "@/lib/auth";
import { initDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;

  const body = await req.json();
  const { workspace_id } = body;

  if (!workspace_id) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Field required: workspace_id" },
      { status: 400 }
    );
  }

  const token = req.cookies.get("pegasus_session")?.value;
  if (!token) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Session cookie required for workspace switch" },
      { status: 401 }
    );
  }

  const switched = await switchWorkspace(token, workspace_id);
  if (!switched) {
    return NextResponse.json(
      { error: "NO_ACCESS", message: "You are not a member of this workspace" },
      { status: 403 }
    );
  }

  return NextResponse.json({ ok: true, workspace_id });
}
