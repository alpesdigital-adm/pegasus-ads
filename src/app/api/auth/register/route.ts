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
 */
import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { createSession, setSessionCookie } from "@/lib/auth";
import { createWorkspace } from "@/lib/workspace";
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
        { status: 400 }
      );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "Invalid email format" },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    const db = (await initDb());

    // Check existing email
    const existing = await db.execute({
      sql: `SELECT id FROM users WHERE email = ?`,
      args: [email.toLowerCase()],
    });
    if (existing.rows.length > 0) {
      return NextResponse.json(
        { error: "EMAIL_EXISTS", message: "A user with this email already exists" },
        { status: 409 }
      );
    }

    // Create user
    const userId = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex") + ":" + salt;

    await db.execute({
      sql: `INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`,
      args: [userId, email.toLowerCase(), name, passwordHash],
    });

    // Create default workspace
    const slug = email.split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
    const wsName = workspace_name || `${name}'s Workspace`;
    const workspaceId = await createWorkspace({
      name: wsName,
      slug: `${slug}-${Date.now().toString(36)}`,
      owner_user_id: userId,
    });

    // Create session
    const token = await createSession(userId, workspaceId);

    const response = NextResponse.json({
      user: { id: userId, email: email.toLowerCase(), name },
      workspace: { id: workspaceId, name: wsName },
    }, { status: 201 });

    return setSessionCookie(response, token);
  } catch (error) {
    console.error("[auth/register]", error);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Registration failed" },
      { status: 500 }
    );
  }
}
