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
 *
 * MIGRADO NA FASE 1C (Wave 4 — workspaces):
 *  - initDb()/getDb() removidos
 *  - JOIN users + workspace_members via Drizzle innerJoin
 *  - User lookup + duplicate check em dbAdmin (typed builder)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, AuthContext } from "@/lib/auth";
import { dbAdmin } from "@/lib/db";
import { users, workspaceMembers } from "@/lib/db/schema";
import { addWorkspaceMember, removeWorkspaceMember } from "@/lib/workspace";
import { and, asc, eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  const members = await dbAdmin
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatar_url: users.avatarUrl,
      role: workspaceMembers.role,
      created_at: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, ctx.workspace_id))
    .orderBy(asc(workspaceMembers.createdAt));

  return NextResponse.json({ members });
}

export async function POST(req: NextRequest) {
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

  const userRow = await dbAdmin
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (userRow.length === 0) {
    return NextResponse.json(
      { error: "USER_NOT_FOUND", message: `No user found with email: ${email}` },
      { status: 404 }
    );
  }

  const userId = userRow[0].id;

  const existing = await dbAdmin
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ctx.workspace_id),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return NextResponse.json(
      { error: "ALREADY_MEMBER", message: "User is already a member of this workspace" },
      { status: 409 }
    );
  }

  await addWorkspaceMember(ctx.workspace_id, userId, memberRole);

  return NextResponse.json({ ok: true, user_id: userId, role: memberRole }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
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
