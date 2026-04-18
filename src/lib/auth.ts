/**
 * Auth — Autenticação multi-tenant.
 *
 * Fase 2 fechada: legacy scrypt/bcrypt + sessions removidos (PR 2c);
 * TEST_LOG_API_KEY fallback removido (TD-003 resolvido). Suporta dois modos:
 *  1. Supabase Auth (cookie sb-access-token, JWT gotrue verificado HS256
 *     localmente)
 *  2. API Key (x-api-key header, hash em api_keys table per-workspace)
 *
 * Workspace ativo:
 *  - Hint via `?workspace_id=` (query) > `x-workspace-id` (header)
 *    > `pegasus_workspace_id` cookie > primeiro membership (fallback)
 *  - O cookie é setado por POST /api/workspaces/switch
 */

import { NextRequest, NextResponse } from "next/server";
import { dbAdmin } from "./db";
import { users, workspaceMembers, apiKeys } from "./db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import crypto from "crypto";
import {
  verifySupabaseJwt,
  SUPABASE_ACCESS_COOKIE,
} from "./supabase-auth";

// ── Types ──

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  created_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_at: string;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  created_at: string;
}

export interface AuthContext {
  user_id: string;
  workspace_id: string;
  role: "owner" | "admin" | "member";
  auth_method: "supabase" | "api_key";
}

// ── Workspace cookie (persiste preferência cross-request) ──

export const WORKSPACE_COOKIE = "pegasus_workspace_id";
const WORKSPACE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30d

export function setWorkspaceCookie(
  response: NextResponse,
  workspaceId: string,
): NextResponse {
  response.cookies.set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: WORKSPACE_COOKIE_MAX_AGE,
    path: "/",
  });
  return response;
}

export function clearWorkspaceCookie(response: NextResponse): NextResponse {
  response.cookies.delete(WORKSPACE_COOKIE);
  return response;
}

// ── API Key ──

async function authenticateApiKey(apiKey: string): Promise<AuthContext | null> {
  const keyHash = hashApiKey(apiKey);

  const rows = await dbAdmin
    .select({
      workspaceId: apiKeys.workspaceId,
      userId: apiKeys.userId,
      role: workspaceMembers.role,
    })
    .from(apiKeys)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, apiKeys.userId),
        eq(workspaceMembers.workspaceId, apiKeys.workspaceId),
      ),
    )
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];

  // Update last_used_at
  await dbAdmin
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.keyHash, keyHash));

  return {
    user_id: row.userId as string,
    workspace_id: row.workspaceId as string,
    role: row.role as "owner" | "admin" | "member",
    auth_method: "api_key",
  };
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): string {
  return `pgs_${crypto.randomBytes(24).toString("hex")}`;
}

// ── Supabase session ──

async function getSupabaseSession(
  accessToken: string,
  workspaceHint?: string,
): Promise<AuthContext | null> {
  const payload = verifySupabaseJwt(accessToken);
  if (!payload?.sub) return null;

  const userRows = await dbAdmin
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authUserId, payload.sub))
    .limit(1);

  if (userRows.length === 0) return null;
  const localUserId = userRows[0].id;

  const wsRows = await dbAdmin
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(
      workspaceHint
        ? and(
            eq(workspaceMembers.userId, localUserId),
            eq(workspaceMembers.workspaceId, workspaceHint),
          )
        : eq(workspaceMembers.userId, localUserId),
    )
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);

  if (wsRows.length === 0) return null;

  return {
    user_id: localUserId,
    workspace_id: wsRows[0].workspaceId,
    role: wsRows[0].role as "owner" | "admin" | "member",
    auth_method: "supabase",
  };
}

// ── Request Authentication ──

/**
 * Extrai AuthContext de um request.
 *
 * Ordem:
 *  1. sb-access-token (Supabase Auth — gotrue JWT verificado HS256 local)
 *  2. x-api-key (api_keys table — hash, revoke, per-workspace)
 */
export async function authenticate(req: NextRequest): Promise<AuthContext | null> {
  const supabaseToken = req.cookies.get(SUPABASE_ACCESS_COOKIE)?.value;
  if (supabaseToken) {
    const workspaceHint =
      req.nextUrl.searchParams.get("workspace_id") ||
      req.headers.get("x-workspace-id") ||
      req.cookies.get(WORKSPACE_COOKIE)?.value ||
      undefined;
    const ctx = await getSupabaseSession(supabaseToken, workspaceHint);
    if (ctx) return ctx;
  }

  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const ctx = await authenticateApiKey(apiKey);
    if (ctx) return ctx;
  }

  return null;
}

export async function requireAuth(
  req: NextRequest,
): Promise<AuthContext | NextResponse> {
  const ctx = await authenticate(req);
  if (!ctx) {
    return NextResponse.json(
      {
        error: "UNAUTHORIZED",
        message: "Authentication required. Provide a Supabase session cookie or x-api-key header.",
        docs: "GET /api/docs for authentication details.",
      },
      { status: 401 },
    );
  }
  return ctx;
}

export async function optionalAuth(req: NextRequest): Promise<AuthContext | null> {
  return authenticate(req);
}
