/**
 * POST /api/auth/register
 *
 * Cria novo usuário + workspace padrão.
 * Retorna session token no cookie.
 *
 * Body: { email, password, name, workspace_name? }
 *
 * Errors:
 * - 400 VALIDATION_ERROR: campos obrigatórios ausentes ou email inválido
 * - 409 EMAIL_EXISTS: email já cadastrado
 * - 500 INTERNAL_ERROR: falha ao criar usuário
 *
 * MIGRADO NA FASE 1C (Wave 1 auth):
 *  - initDb() → dbAdmin
 *  - 2 queries próprias (SELECT email + INSERT user) em Drizzle
 *  - createWorkspace continua legado (migrada depois junto com workspace.ts)
 */
import { NextRequest, NextResponse } from "next/server";
import { dbAdmin } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createSession, setSessionCookie } from "@/lib/auth";
import { createWorkspace } from "@/lib/workspace";
import { eq } from "drizzle-orm";
import crypto from "crypto";

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

    // Check existing email
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

    // Create user (scrypt password: hash:salt)
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex") + ":" + salt;

    const inserted = await dbAdmin
      .insert(users)
      .values({
        email: emailLower,
        name,
        passwordHash,
      })
      .returning({ id: users.id });

    const userId = inserted[0].id as string;

    // Create default workspace (via library legado, migração pendente)
    const slug = emailLower.split("@")[0].replace(/[^a-z0-9-]/g, "-").slice(0, 30);
    const wsName = workspace_name || `${name}'s Workspace`;
    const workspaceId = await createWorkspace({
      name: wsName,
      slug: `${slug}-${Date.now().toString(36)}`,
      owner_user_id: userId,
    });

    // Create session
    const token = await createSession(userId, workspaceId);

    const response = NextResponse.json(
      {
        user: { id: userId, email: emailLower, name },
        workspace: { id: workspaceId, name: wsName },
      },
      { status: 201 },
    );

    return setSessionCookie(response, token);
  } catch (error) {
    console.error("[auth/register]", error);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Registration failed" },
      { status: 500 },
    );
  }
}
