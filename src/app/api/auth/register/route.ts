/**
 * POST /api/auth/register
 *
 * Cria novo usuário via Supabase Auth (gotrue) + profile local + workspace
 * padrão. Retorna cookies sb-access-token + sb-refresh-token.
 *
 * Body: { email, password, name, workspace_name? }
 *
 * FASE 2 PR 2b: contas novas SEMPRE nascem no gotrue. O fluxo scrypt legado
 * (bcrypt local) é terminal — nunca mais cria users com password_hash.
 *
 * Fluxo:
 *  1. Valida campos
 *  2. Check email duplicado em public.users
 *  3. signUp no gotrue (cria auth.users)
 *  4. INSERT em public.users com auth_user_id = gotrue.user.id (sem
 *     password_hash — fica NULL)
 *  5. createWorkspace + adiciona user como owner
 *  6. Se a resposta do gotrue trouxe access_token (auto-confirm ON), seta
 *     cookies e retorna 201. Senão, retorna 202 (pending email confirmation).
 */
import { NextRequest, NextResponse } from "next/server";
import { dbAdmin } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createWorkspace } from "@/lib/workspace";
import {
  APP_TAG,
  GotrueHttpError,
  ensureAppEnrolled,
  setSupabaseCookies,
  signUp,
  type SupabaseSession,
  type SupabaseUser,
} from "@/lib/supabase-auth";
import { eq } from "drizzle-orm";

function hasAccessToken(x: SupabaseSession | { user: SupabaseUser }): x is SupabaseSession {
  return (x as SupabaseSession).access_token !== undefined;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, name, workspace_name } = body;

    if (!email || !password || !name) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: "Fields required: email, password, name",
          fields: {
            email: !email ? "required" : undefined,
            password: !password ? "required" : undefined,
            name: !name ? "required" : undefined,
          },
        },
        { status: 400 },
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "Invalid email format" },
        { status: 400 },
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "Password must be at least 8 characters" },
        { status: 400 },
      );
    }

    const emailLower = String(email).toLowerCase();

    // Check duplicado local
    const existing = await dbAdmin
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, emailLower))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(
        { error: "EMAIL_EXISTS", message: "A user with this email already exists" },
        { status: 409 },
      );
    }

    // Cria no gotrue
    let signupResult: SupabaseSession | { user: SupabaseUser };
    try {
      signupResult = await signUp(emailLower, password, { name });
    } catch (err) {
      if (err instanceof GotrueHttpError) {
        if (err.status === 422 || err.status === 400) {
          return NextResponse.json(
            { error: "SUPABASE_VALIDATION_ERROR", message: err.message },
            { status: err.status },
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

    const supabaseUser = signupResult.user;
    if (!supabaseUser?.id) {
      return NextResponse.json(
        { error: "INTERNAL_ERROR", message: "Supabase signup retornou sem user.id" },
        { status: 500 },
      );
    }

    // SSO multi-app: tagga user com app_metadata.apps=["pegasus_ads"].
    // /signup não aceita app_metadata — precisa ser via admin API logo após.
    // ensureAppEnrolled é idempotente e preserva outros apps caso já exista.
    try {
      await ensureAppEnrolled(supabaseUser, APP_TAG);
    } catch (err) {
      console.warn("[auth/register] ensureAppEnrolled falhou:", err);
      // Não-crítico pro fluxo de registro — profile local é criado mesmo
      // sem a tag. Reconciliação pode ser feita depois via one-off SQL.
    }

    // Cria profile local
    const inserted = await dbAdmin
      .insert(users)
      .values({
        email: emailLower,
        name,
        authUserId: supabaseUser.id,
      })
      .returning({ id: users.id });

    const localUserId = inserted[0].id;

    // Cria workspace padrão
    const slug = emailLower.split("@")[0].replace(/[^a-z0-9-]/g, "-").slice(0, 30);
    const wsName = workspace_name || `${name}'s Workspace`;
    const workspaceId = await createWorkspace({
      name: wsName,
      slug: `${slug}-${Date.now().toString(36)}`,
      owner_user_id: localUserId,
    });

    const responseBody = {
      user: { id: localUserId, email: emailLower, name },
      workspace: { id: workspaceId, name: wsName },
    };

    if (hasAccessToken(signupResult)) {
      // Auto-confirm ON — já pode setar cookies
      const response = NextResponse.json(responseBody, { status: 201 });
      return setSupabaseCookies(response, signupResult);
    }

    // Auto-confirm OFF — usuário precisa clicar no email
    return NextResponse.json(
      {
        ...responseBody,
        pending_email_confirmation: true,
        message: "Conta criada. Confirme o email pra fazer login.",
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("[auth/register]", error);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Registration failed" },
      { status: 500 },
    );
  }
}
