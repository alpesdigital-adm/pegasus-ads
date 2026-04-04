/**
 * GET    /api/workspaces/members — Lista membros do workspace atual
 * POST   /api/workspaces/members — Convida membro (por email)
 * DELETE /api/workspaces/members — Remove membro
 *
 * Errors:
 * - 401 UNAUTHORIZED
 * - 403 FORBIDDEN: apenas owner/admin pode gerenciar membros
 * - 404 USER_NOT_FOUND: email não encontrado
 * - 409 ALREADY_MEMBER: já é membro
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, AuthContext } from "@/lib/auth";
import { initDb, getDb } from "@/lib/db";
import { addWorkspaceMember, removeWorkspaceMember } from "@/lib/workspace";

export async function GET(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  const db = getDb();
  const result = await db.execute({
    sql: `SELECT u.id, u.email, u.name, u.avatar_url, wm.role, wm.created_at
          FROM workspace_members wm
          JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id = ?
          ORDER BY wm.created_at ASC`,
    args: [ctx.workspace_id],
  });

  return NextResponse.json({ members: result.rows });
}

export async function POST(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  if (ctx.role === "member") {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "Only owner or admin can add members" },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { email, role } = body;

  if (!email) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Field required: email" },
      { status: 400 }
    );
  }

  const memberRole = role === "admin" ? "admin" : "member";

  const db = getDb();
  const userResult = await db.execute({
    sql: `SELECT id FROM users WHERE email = ?`,
    args: [email.toLowerCase()],
  });

  if (userResult.rows.length === 0) {
    return NextResponse.json(
      { error: "USER_NOT_FOUND", message: `No user found with email: ${email}` },
      { status: 404 }
    );
  }

  const userId = userResult.rows[0].id as string;

  // Check if already member
  const existing = await db.execute({
    sql: `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    args: [ctx.workspace_id, userId],
  });
  if (existing.rows.length > 0) {
    return NextResponse.json(
      { error: "ALREADY_MEMBER", message: "User is already a member of this workspace" },
      { status: 409 }
    );
  }

  await addWorkspaceMember(ctx.workspace_id, userId, memberRole);

  return NextResponse.json({ ok: true, user_id: userId, role: memberRole }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  if (ctx.role === "member") {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "Only owner or admin can remove members" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("user_id");

  if (!userId) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Query param required: user_id" },
      { status: 400 }
    );
  }

  await removeWorkspaceMember(ctx.workspace_id, userId);
  return NextResponse.json({ ok: true });
}
