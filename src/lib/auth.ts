/**
 * Auth — Autenticação e sessão multi-tenant.
 *
 * Suporta dois modos:
 * 1. Cookie-based sessions (browser/UI)
 * 2. API Key (chamadas externas)
 *
 * Cada request autenticada carrega workspace_id no contexto.
 *
 * MIGRADO NA FASE 1C (Wave 1 auth):
 *  - getDb().execute() → dbAdmin (BYPASSRLS — auth acontece antes do
 *    contexto de workspace_id estar definido)
 *  - 7 queries CRUD em Drizzle typed builder
 *  - ORDER BY complexo do TEST_LOG_API_KEY usa sql`` no orderBy
 *  - Todas as funções preservam comportamento exato do legado
 */

import { NextRequest, NextResponse } from "next/server";
import { dbAdmin, sql } from "./db";
import {
  sessions,
  users,
  workspaceMembers,
  apiKeys,
  workspaces,
  workspaceMetaAccounts,
} from "./db/schema";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
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

export interface SessionPayload {
  user_id: string;
  workspace_id: string;
  role: "owner" | "admin" | "member";
}

export interface AuthContext {
  user_id: string;
  workspace_id: string;
  role: "owner" | "admin" | "member";
  auth_method: "supabase" | "session" | "api_key";
}

// ── Session Management (simple token-based) ──

const SESSION_COOKIE = "pegasus_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createSession(
  userId: string,
  workspaceId: string,
): Promise<string> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await dbAdmin.insert(sessions).values({
    token,
    userId,
    workspaceId,
    expiresAt,
  });

  return token;
}

export async function getSession(token: string): Promise<AuthContext | null> {
  const rows = await dbAdmin
    .select({
      userId: sessions.userId,
      workspaceId: sessions.workspaceId,
      role: workspaceMembers.role,
    })
    .from(sessions)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, sessions.userId),
        eq(workspaceMembers.workspaceId, sessions.workspaceId),
      ),
    )
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    user_id: row.userId as string,
    workspace_id: row.workspaceId as string,
    role: row.role as "owner" | "admin" | "member",
    auth_method: "session",
  };
}

export async function deleteSession(token: string): Promise<void> {
  await dbAdmin.delete(sessions).where(eq(sessions.token, token));
}

export async function switchWorkspace(
  token: string,
  newWorkspaceId: string,
): Promise<boolean> {
  // Verify user has access to the new workspace
  const session = await getSession(token);
  if (!session) return false;

  const memberCheck = await dbAdmin
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, session.user_id),
        eq(workspaceMembers.workspaceId, newWorkspaceId),
      ),
    )
    .limit(1);

  if (memberCheck.length === 0) return false;

  await dbAdmin
    .update(sessions)
    .set({ workspaceId: newWorkspaceId })
    .where(eq(sessions.token, token));

  return true;
}

// ── API Key Authentication ──

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

// ── Supabase session (Fase 2) ──
// Resolve AuthContext a partir do cookie sb-access-token (JWT emitido por
// gotrue). Verificação local via HS256 — não faz round-trip. O subject do JWT
// (auth.users.id) é usado pra lookup em public.users via auth_user_id +
// workspace preferido.
//
// Se `workspaceHint` (querystring ?workspace_id ou header x-workspace-id) for
// passado e o usuário for membro, usa. Caso contrário, primeiro workspace
// (ordem de ingresso) — mesmo comportamento do login legado.

async function getSupabaseSession(
  accessToken: string,
  workspaceHint?: string,
): Promise<AuthContext | null> {
  const payload = verifySupabaseJwt(accessToken);
  if (!payload?.sub) return null;

  // Lookup local user pelo authUserId
  const userRows = await dbAdmin
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authUserId, payload.sub))
    .limit(1);

  if (userRows.length === 0) return null;
  const localUserId = userRows[0].id;

  // Pega workspace (hint ou primeiro)
  const wsQuery = dbAdmin
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

  const wsRows = await wsQuery;
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
 * Ordem de tentativa (Fase 2 transition):
 *  1. sb-access-token (Supabase Auth — gotrue JWT)
 *  2. pegasus_session (legado scrypt/bcrypt — sessions table)
 *  3. x-api-key header
 *
 * A ordem reflete preferência: Supabase > legado > API key. Sessões legadas
 * continuam válidas até Fase 2c removê-las.
 */
export async function authenticate(req: NextRequest): Promise<AuthContext | null> {
  // 1. Try Supabase Auth JWT (Fase 2)
  const supabaseToken = req.cookies.get(SUPABASE_ACCESS_COOKIE)?.value;
  if (supabaseToken) {
    const workspaceHint =
      req.nextUrl.searchParams.get("workspace_id") ||
      req.headers.get("x-workspace-id") ||
      undefined;
    const ctx = await getSupabaseSession(supabaseToken, workspaceHint);
    if (ctx) return ctx;
  }

  // 2. Try legacy session cookie
  const sessionToken = req.cookies.get(SESSION_COOKIE)?.value;
  if (sessionToken) {
    const ctx = await getSession(sessionToken);
    if (ctx) return ctx;
  }

  // 2. Try API key (standard, then legacy TEST_LOG_API_KEY)
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    // 2a. Standard API key (hashed, from api_keys table)
    const ctx = await authenticateApiKey(apiKey);
    if (ctx) return ctx;

    // 2b. Legacy TEST_LOG_API_KEY (backward compat — TD-003, remover 90d pós-Fase 2)
    if (apiKey === process.env.TEST_LOG_API_KEY) {
      // Prefer workspace with Meta account configured (for kill rules etc.)
      // Drizzle não tem LEFT JOIN com ORDER BY em expressão simples, mas o
      // builder aceita sql`` em orderBy — mantém: workspaces com Meta account
      // vêm primeiro (DESC de IS NOT NULL), empate pelo workspace mais antigo.
      const rows = await dbAdmin
        .select({ id: workspaces.id })
        .from(workspaces)
        .leftJoin(
          workspaceMetaAccounts,
          eq(workspaceMetaAccounts.workspaceId, workspaces.id),
        )
        .orderBy(
          desc(sql`${workspaceMetaAccounts.metaAccountId} IS NOT NULL`),
          asc(workspaces.createdAt),
        )
        .limit(1);

      if (rows.length > 0) {
        return {
          user_id: "legacy",
          workspace_id: rows[0].id as string,
          role: "admin",
          auth_method: "api_key",
        };
      }
    }
  }

  return null;
}

/**
 * Middleware wrapper — retorna 401 se não autenticado.
 */
export async function requireAuth(
  req: NextRequest,
): Promise<AuthContext | NextResponse> {
  const ctx = await authenticate(req);
  if (!ctx) {
    return NextResponse.json(
      {
        error: "UNAUTHORIZED",
        message: "Authentication required. Provide a session cookie or x-api-key header.",
        docs: "GET /api/docs for authentication details.",
      },
      { status: 401 },
    );
  }
  return ctx;
}

/**
 * Optional auth — retorna AuthContext ou null (para endpoints públicos com auth opcional).
 */
export async function optionalAuth(req: NextRequest): Promise<AuthContext | null> {
  return authenticate(req);
}

// ── Cookie helpers ──

export function setSessionCookie(response: NextResponse, token: string): NextResponse {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DURATION_MS / 1000,
    path: "/",
  });
  return response;
}

export function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
