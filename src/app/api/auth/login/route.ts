/**
 * POST /api/auth/login
 *
 * Autentica usuário com email/senha.
 * Retorna session token no cookie.
 *
 * Body: { email, password, workspace_id? }
 *
 * Se workspace_id omitido, usa o primeiro workspace do usuário.
 *
 * Suporta bcrypt ($2b$...) e scrypt (hash:salt) password hashes.
 *
 * Errors:
 * - 400 VALIDATION_ERROR: campos obrigatórios ausentes
 * - 401 INVALID_CREDENTIALS: email ou senha incorretos
 * - 403 NO_WORKSPACE_ACCESS: usuário não tem acesso ao workspace
 * - 500 INTERNAL_ERROR: falha interna
 */
import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { createSession, setSessionCookie } from "@/lib/auth";
import crypto from "crypto";

// ---------- password verification helpers ----------

async function verifyBcrypt(password: string, storedHash: string): Promise<boolean> {
  // Dynamic import to avoid bundling issues if bcryptjs not available
  try {
    const bcrypt = await import("bcryptjs");
    return bcrypt.compare(password, storedHash);
  } catch {
    // Fallback: try bcrypt (native)
    try {
      const bcrypt = await import("bcrypt");
      return bcrypt.compare(password, storedHash);
    } catch {
      console.error("[auth/login] Neither bcryptjs nor bcrypt available");
      return false;
    }
  }
}

function verifyScrypt(password: string, storedHash: string): boolean {
  const [hash, salt] = storedHash.split(":");
  if (!hash || !salt) return false;
  const attemptHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return attemptHash === hash;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith("$2b$") || storedHash.startsWith("$2a$")) {
    return verifyBcrypt(password, storedHash);
  }
  // Default: scrypt format "hash:salt"
  return verifyScrypt(password, storedHash);
}

// ---------- route handler ----------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, workspace_id } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "Fields required: email, password" },
        { status: 400 }
      );
    }

    const db = await initDb();

    // Find user
    const userResult = await db.execute({
      sql: `SELECT id, email, name, password_hash, avatar_url FROM users WHERE email = ?`,
      args: [email.toLowerCase()],
    });

    if (userResult.rows.length === 0) {
      return NextResponse.json(
        { error: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        { status: 401 }
      );
    }

    const user = userResult.rows[0];
    const passwordValid = await verifyPassword(password, user.password_hash as string);

    if (!passwordValid) {
      return NextResponse.json(
        { error: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        { status: 401 }
      );
    }

    // Resolve workspace
    let wsId = workspace_id;
    if (!wsId) {
      const wsResult = await db.execute({
        sql: `SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`,
        args: [user.id as string],
      });
      if (wsResult.rows.length === 0) {
        return NextResponse.json(
          { error: "NO_WORKSPACE_ACCESS", message: "User has no workspaces" },
          { status: 403 }
        );
      }
      wsId = wsResult.rows[0].workspace_id;
    } else {
      // Verify access
      const accessCheck = await db.execute({
        sql: `SELECT 1 FROM workspace_members WHERE user_id = ? AND workspace_id = ?`,
        args: [user.id as string, wsId],
      });
      if (accessCheck.rows.length === 0) {
        return NextResponse.json(
          { error: "NO_WORKSPACE_ACCESS", message: "User does not have access to this workspace" },
          { status: 403 }
        );
      }
    }

    // Create session
    const token = await createSession(user.id as string, wsId as string);

    const response = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url },
      workspace_id: wsId,
    });

    return setSessionCookie(response, token);
  } catch (error) {
    console.error("[auth/login]", error);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Login failed" },
      { status: 500 }
    );
  }
}
