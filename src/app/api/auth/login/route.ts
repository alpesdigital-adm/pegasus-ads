/**
 * POST /api/auth/login
 *
 * Autentica via Supabase Auth (gotrue). Fase 2 PR 2c: removido fallback
 * legado scrypt/bcrypt — auth.users é a ÚNICA fonte.
 *
 * Body: { email, password, workspace_id? }
 *
 * Errors:
 *  - 400 VALIDATION_ERROR — campos obrigatórios
 *  - 401 INVALID_CREDENTIALS — email/senha incorretos
 *  - 403 NO_WORKSPACE_ACCESS — sem workspace disponível
 *  - 403 NO_LOCAL_PROFILE — auth ok mas sem public.users linkado
 */
import { NextRequest, NextResponse } from "next/server";
import { dbAdmin } from "@/lib/db";
import { users, workspaceMembers } from "@/lib/db/schema";
import { setWorkspaceCookie } from "@/lib/auth";
import {
  GotrueHttpError,
  setSupabaseCookies,
  signInWithPassword,
} from "@/lib/supabase-auth";
import { and, asc, eq } from "drizzle-orm";

async function resolveWorkspaceForUser(
  userId: string,
  requestedWsId: string | undefined,
): Promise<string | { error: NextResponse }> {
  if (requestedWsId) {
    const accessCheck = await dbAdmin
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.workspaceId, requestedWsId),
        ),
      )
      .limit(1);

    if (accessCheck.length === 0) {
      return {
        error: NextResponse.json(
          { error: "NO_WORKSPACE_ACCESS", message: "User does not have access to this workspace" },
          { status: 403 },
        ),
      };
    }
    return requestedWsId;
  }

  const wsRows = await dbAdmin
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);

  if (wsRows.length === 0) {
    return {
      error: NextResponse.json(
        { error: "NO_WORKSPACE_ACCESS", message: "User has no workspaces" },
        { status: 403 },
      ),
    };
  }
  return wsRows[0].workspaceId;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, workspace_id: requestedWsId } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "Fields required: email, password" },
        { status: 400 },
      );
    }

    const emailLower = String(email).toLowerCase();

    let session;
    try {
      session = await signInWithPassword(emailLower, password);
    } catch (err) {
      if (err instanceof GotrueHttpError) {
        if (err.status === 400 || err.status === 401 || err.status === 422) {
          return NextResponse.json(
            { error: "INVALID_CREDENTIALS", message: "Invalid email or password" },
            { status: 401 },
          );
        }
        if (err.status === 429) {
          return NextResponse.json(
            { error: "RATE_LIMIT", message: "Muitas tentativas. Aguarde alguns minutos." },
            { status: 429 },
          );
        }
      }
      throw err;
    }

    // Localiza profile local. Tenta auth_user_id primeiro; fallback por email
    // + auto-link (caso o profile exista mas ainda não esteja ligado).
    let localUser = (await dbAdmin
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        authUserId: users.authUserId,
      })
      .from(users)
      .where(eq(users.authUserId, session.user.id))
      .limit(1))[0];

    if (!localUser) {
      const byEmail = (await dbAdmin
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          avatarUrl: users.avatarUrl,
          authUserId: users.authUserId,
        })
        .from(users)
        .where(eq(users.email, emailLower))
        .limit(1))[0];

      if (byEmail) {
        if (!byEmail.authUserId) {
          await dbAdmin
            .update(users)
            .set({ authUserId: session.user.id })
            .where(eq(users.id, byEmail.id));
        }
        localUser = byEmail;
      }
    }

    if (!localUser) {
      return NextResponse.json(
        {
          error: "NO_LOCAL_PROFILE",
          message: "Autenticação OK no Supabase, mas sem profile local. Contacte admin.",
        },
        { status: 403 },
      );
    }

    const wsResolved = await resolveWorkspaceForUser(localUser.id, requestedWsId);
    if (typeof wsResolved !== "string") return wsResolved.error;

    const response = NextResponse.json({
      user: {
        id: localUser.id,
        email: localUser.email,
        name: localUser.name,
        avatar_url: localUser.avatarUrl,
      },
      workspace_id: wsResolved,
      auth_method: "supabase" as const,
    });

    setSupabaseCookies(response, session);
    setWorkspaceCookie(response, wsResolved);
    return response;
  } catch (error) {
    console.error("[auth/login]", error);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Login failed" },
      { status: 500 },
    );
  }
}
