/**
 * POST /api/auth/login
 *
 * Autentica usuário com email/senha.
 *
 * Body: { email, password, workspace_id? }
 *
 * FASE 2 PR 2b — agora tenta Supabase Auth (gotrue) PRIMEIRO. Se falhar
 * (conta ainda não migrada), cai no fluxo legado scrypt/bcrypt.
 *
 *  - Caminho Supabase: signInWithPassword → auto-link auth_user_id se
 *    ainda não linkado → set sb-access-token + sb-refresh-token cookies
 *  - Fallback legado: verifyPassword local → createSession → pegasus_session
 *
 * Usuários com `auth_user_id` populado só conseguem entrar via Supabase
 * (o password_hash local fica como sombra até Fase 2c). Usuários sem
 * auth_user_id continuam no legado até rodar scripts/phase-2-migrate-users-to-auth.ts.
 *
 * Errors:
 *  - 400 VALIDATION_ERROR — campos obrigatórios
 *  - 401 INVALID_CREDENTIALS — email/senha incorretos em ambos paths
 *  - 403 NO_WORKSPACE_ACCESS — sem workspace disponível
 */
import { NextRequest, NextResponse } from "next/server";
import { dbAdmin } from "@/lib/db";
import { users, workspaceMembers } from "@/lib/db/schema";
import { createSession, setSessionCookie } from "@/lib/auth";
import {
  GotrueHttpError,
  setSupabaseCookies,
  signInWithPassword,
} from "@/lib/supabase-auth";
import { and, asc, eq } from "drizzle-orm";
import crypto from "crypto";
import bcryptjs from "bcryptjs";

// ── Password verification (legado) ─────────────────────────────────────────

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith("$2b$") || storedHash.startsWith("$2a$")) {
    return bcryptjs.compare(password, storedHash);
  }
  const [hash, salt] = storedHash.split(":");
  if (!hash || !salt) return false;
  const attemptHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return attemptHash === hash;
}

// ── Workspace resolver — compartilhado entre os dois paths ─────────────────

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

// ── Handler ────────────────────────────────────────────────────────────────

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

    // ─── Path 1: Supabase Auth (gotrue) ───────────────────────────────────
    try {
      const session = await signInWithPassword(emailLower, password);

      // Localiza profile local. Tenta primeiro por auth_user_id (caminho feliz
      // após script de migração); fallback por email + auto-link se ainda não
      // linkado (caso de re-link pós-reset).
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
          // Auto-link (migração oportunística — pode acontecer se script rodou
          // e alguém loga antes do deploy ficar estável)
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

      return setSupabaseCookies(response, session);
    } catch (err) {
      if (err instanceof GotrueHttpError) {
        // 400/401/422 do gotrue = credenciais inválidas no Supabase.
        // Não é falha fatal — cai pro legado abaixo. Outros 5xx/rede vazam.
        if (err.status < 500) {
          // fallthrough para legado
        } else {
          throw err;
        }
      } else {
        // Erro de config (ex: env var faltando) — registra e tenta legado
        console.warn("[auth/login] Supabase unavailable, falling back to legacy:", err);
      }
    }

    // ─── Path 2: Legado scrypt/bcrypt ─────────────────────────────────────
    const userRows = await dbAdmin
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        passwordHash: users.passwordHash,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.email, emailLower))
      .limit(1);

    if (userRows.length === 0 || !userRows[0].passwordHash) {
      return NextResponse.json(
        { error: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        { status: 401 },
      );
    }

    const user = userRows[0];
    const passwordValid = await verifyPassword(password, user.passwordHash as string);

    if (!passwordValid) {
      return NextResponse.json(
        { error: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        { status: 401 },
      );
    }

    const wsResolved = await resolveWorkspaceForUser(user.id, requestedWsId);
    if (typeof wsResolved !== "string") return wsResolved.error;

    const token = await createSession(user.id, wsResolved);

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar_url: user.avatarUrl,
      },
      workspace_id: wsResolved,
      auth_method: "session" as const,
    });

    return setSessionCookie(response, token);
  } catch (error) {
    console.error("[auth/login]", error);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Login failed" },
      { status: 500 },
    );
  }
}
