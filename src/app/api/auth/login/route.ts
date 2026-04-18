/**
 * POST /api/auth/login
 *
 * Autentica usuario com email/senha.
 * Retorna session token no cookie.
 *
 * Body: { email, password, workspace_id? }
 *
 * Se workspace_id omitido, usa o primeiro workspace do usuario.
 *
 * Suporta bcrypt ($2b$...) e scrypt (hash:salt) password hashes.
 *
 * MIGRADO NA FASE 1C (Wave 1 auth):
 *  - initDb() → dbAdmin (auth happens cross-workspace)
 *  - 3 queries em Drizzle typed builder
 */
import { NextRequest, NextResponse } from "next/server";
import { dbAdmin } from "@/lib/db";
import { users, workspaceMembers } from "@/lib/db/schema";
import { createSession, setSessionCookie } from "@/lib/auth";
import { and, asc, eq } from "drizzle-orm";
import crypto from "crypto";
import bcryptjs from "bcryptjs";

// ---------- password verification ----------

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // Bcrypt format: $2b$10$... or $2a$10$...
  if (storedHash.startsWith("$2b$") || storedHash.startsWith("$2a$")) {
    return bcryptjs.compare(password, storedHash);
  }
  // Scrypt format: hash:salt
  const [hash, salt] = storedHash.split(":");
  if (!hash || !salt) return false;
  const attemptHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return attemptHash === hash;
}

// ---------- route handler ----------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password, workspace_id } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "Fields required: email, password" },
        { status: 400 },
      );
    }

    // Find user
    const userRows = await dbAdmin
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        passwordHash: users.passwordHash,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.email, String(email).toLowerCase()))
      .limit(1);

    if (userRows.length === 0) {
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

    // Resolve workspace
    let wsId: string | undefined = workspace_id;
    if (!wsId) {
      const wsRows = await dbAdmin
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user.id as string))
        .orderBy(asc(workspaceMembers.createdAt))
        .limit(1);

      if (wsRows.length === 0) {
        return NextResponse.json(
          { error: "NO_WORKSPACE_ACCESS", message: "User has no workspaces" },
          { status: 403 },
        );
      }
      wsId = wsRows[0].workspaceId as string;
    } else {
      // Verify access
      const accessCheck = await dbAdmin
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, user.id as string),
            eq(workspaceMembers.workspaceId, wsId),
          ),
        )
        .limit(1);

      if (accessCheck.length === 0) {
        return NextResponse.json(
          { error: "NO_WORKSPACE_ACCESS", message: "User does not have access to this workspace" },
          { status: 403 },
        );
      }
    }

    // Create session
    const token = await createSession(user.id as string, wsId as string);

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar_url: user.avatarUrl,
      },
      workspace_id: wsId,
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
