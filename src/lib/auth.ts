/**
 * Auth — Autenticação e sessão multi-tenant.
 *
 * Suporta dois modos:
 * 1. Cookie-based sessions (browser/UI)
 * 2. API Key (chamadas externas)
 *
 * Cada request autenticada carrega workspace_id no contexto.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "./db";
import crypto from "crypto";

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
  auth_method: "session" | "api_key";
}

// ── Session Management (simple token-based) ──

const SESSION_COOKIE = "pegasus_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createSession(
  userId: string,
  workspaceId: string
): Promise<string> {
  const db = getDb();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  await db.execute({
    sql: `INSERT INTO sessions (token, user_id, workspace_id, expires_at)
          VALUES (?, ?, ?, ?)`,
    args: [token, userId, workspaceId, expiresAt],
  });

  return token;
}

export async function getSession(token: string): Promise<AuthContext | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT s.user_id, s.workspace_id, wm.role
          FROM sessions s
          JOIN workspace_members wm ON wm.user_id = s.user_id AND wm.workspace_id = s.workspace_id
          WHERE s.token = ? AND s.expires_at > NOW()`,
    args: [token],
  });

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    user_id: row.user_id as string,
    workspace_id: row.workspace_id as string,
    role: row.role as "owner" | "admin" | "member",
    auth_method: "session",
  };
}

export async function deleteSession(token: string): Promise<void> {
  const db = getDb();
  await db.execute({ sql: `DELETE FROM sessions WHERE token = ?`, args: [token] });
}

export async function switchWorkspace(
  token: string,
  newWorkspaceId: string
): Promise<boolean> {
  const db = getDb();

  // Verify user has access to the new workspace
  const session = await getSession(token);
  if (!session) return false;

  const memberCheck = await db.execute({
    sql: `SELECT 1 FROM workspace_members WHERE user_id = ? AND workspace_id = ?`,
    args: [session.user_id, newWorkspaceId],
  });
  if (memberCheck.rows.length === 0) return false;

  await db.execute({
    sql: `UPDATE sessions SET workspace_id = ? WHERE token = ?`,
    args: [newWorkspaceId, token],
  });

  return true;
}

// ── API Key Authentication ──

async function authenticateApiKey(apiKey: string): Promise<AuthContext | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT ak.workspace_id, ak.user_id, wm.role
          FROM api_keys ak
          JOIN workspace_members wm ON wm.user_id = ak.user_id AND wm.workspace_id = ak.workspace_id
          WHERE ak.key_hash = ? AND ak.revoked_at IS NULL`,
    args: [hashApiKey(apiKey)],
  });

  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  // Update last_used_at
  await db.execute({
    sql: `UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = ?`,
    args: [hashApiKey(apiKey)],
  });

  return {
    user_id: row.user_id as string,
    workspace_id: row.workspace_id as string,
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

// ── Request Authentication ──

/**
 * Extrai AuthContext de um request.
 * Tenta session cookie primeiro, depois API key header.
 * Retorna null se não autenticado.
 */
export async function authenticate(req: NextRequest): Promise<AuthContext | null> {
  // 1. Try session cookie
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

    // 2b. Legacy TEST_LOG_API_KEY (backward compat)
    if (apiKey === process.env.TEST_LOG_API_KEY) {
      const db = getDb();
      // Prefer workspace with Meta account configured (for kill rules etc.)
      const result = await db.execute({
        sql: `SELECT w.id FROM workspaces w
              LEFT JOIN workspace_meta_accounts wma ON wma.workspace_id = w.id
              ORDER BY (wma.meta_account_id IS NOT NULL) DESC, w.created_at ASC
              LIMIT 1`,
        args: [],
      });
      if (result.rows.length > 0) {
        return {
          user_id: "legacy",
          workspace_id: result.rows[0].id as string,
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
  req: NextRequest
): Promise<AuthContext | NextResponse> {
  const ctx = await authenticate(req);
  if (!ctx) {
    return NextResponse.json(
      {
        error: "UNAUTHORIZED",
        message: "Authentication required. Provide a session cookie or x-api-key header.",
        docs: "GET /api/docs for authentication details.",
      },
      { status: 401 }
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
