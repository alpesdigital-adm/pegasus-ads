/**
 * Supabase Auth — Cliente server-side direto (sem @supabase/supabase-js).
 *
 * Padrão adotado pelo CRM (2026-04-18, pós-rotação TD-006): HTTP direto pro
 * gotrue + verificação local de JWT com crypto nativo. Mais leve que o pacote
 * oficial e evita acoplamento com o schema interno deles.
 *
 * Env vars obrigatórias (Fase 2):
 *  - SUPABASE_AUTH_URL        base do gotrue (ex: http://supabase-kong:8000/auth/v1)
 *  - SUPABASE_ANON_KEY        usada em signIn/signUp/refresh
 *  - SUPABASE_SERVICE_ROLE_KEY usada em adminCreateUser (apenas server)
 *  - SUPABASE_JWT_SECRET      HS256 secret pra verificar access_token offline
 *
 * Não exportar SUPABASE_SERVICE_ROLE_KEY nem SUPABASE_JWT_SECRET pro bundle
 * do cliente — este arquivo roda só em runtime Node ("use node").
 */

import crypto from "crypto";

// ── Config ─────────────────────────────────────────────────────────────────

function env(name: string, optional = false): string {
  const v = process.env[name];
  if (!v && !optional) {
    throw new Error(`Missing env: ${name}. Configure em .env ou compose.`);
  }
  return v ?? "";
}

function authUrl(): string {
  return env("SUPABASE_AUTH_URL").replace(/\/$/, "");
}

function anonKey(): string {
  return env("SUPABASE_ANON_KEY");
}

function serviceRoleKey(): string {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function jwtSecret(): string {
  return env("SUPABASE_JWT_SECRET");
}

// ── Tipos ──────────────────────────────────────────────────────────────────

export interface SupabaseUser {
  id: string;
  email?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  aud?: string;
  role?: string;
}

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  expires_in: number;
  token_type: "bearer";
  user: SupabaseUser;
}

export interface JwtPayload {
  sub: string; // auth.users.id
  email?: string;
  role?: string;
  aud?: string;
  exp?: number; // unix seconds
  iat?: number;
  iss?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

// ── JWT local verify (HS256) ───────────────────────────────────────────────
// Evita round-trip ao gotrue em toda request autenticada. Gotrue emite HS256
// assinado com SUPABASE_JWT_SECRET (o mesmo valor em GOTRUE_JWT_SECRET do
// container). Valida signature + exp.

function base64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function verifySupabaseJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const expected = crypto
      .createHmac("sha256", jwtSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const provided = base64urlDecode(signatureB64);

    // timingSafeEqual exige mesmo tamanho — falha defensiva se diferente
    if (expected.length !== provided.length) return null;
    if (!crypto.timingSafeEqual(expected, provided)) return null;

    const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf-8")) as JwtPayload;
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── HTTP client pro gotrue ─────────────────────────────────────────────────

interface GotrueError {
  error?: string;
  error_description?: string;
  msg?: string;
  message?: string;
  code?: number | string;
}

async function gotrueFetch<T>(
  path: string,
  init: RequestInit & { useServiceRole?: boolean; accessToken?: string } = {},
): Promise<T> {
  const { useServiceRole, accessToken, ...rest } = init;
  const apiKey = useServiceRole ? serviceRoleKey() : anonKey();
  const headers: Record<string, string> = {
    apikey: apiKey,
    Authorization: `Bearer ${accessToken ?? apiKey}`,
    "Content-Type": "application/json",
    ...(rest.headers as Record<string, string> | undefined),
  };

  const res = await fetch(`${authUrl()}${path}`, { ...rest, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const e = body as GotrueError;
    const msg = e.error_description || e.msg || e.message || e.error || `HTTP ${res.status}`;
    throw new GotrueHttpError(msg, res.status, e);
  }

  return body as T;
}

export class GotrueHttpError extends Error {
  status: number;
  body: GotrueError;
  constructor(message: string, status: number, body: GotrueError) {
    super(message);
    this.name = "GotrueHttpError";
    this.status = status;
    this.body = body;
  }
}

// ── Password grant ─────────────────────────────────────────────────────────

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SupabaseSession> {
  return gotrueFetch<SupabaseSession>("/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

// ── Refresh token ──────────────────────────────────────────────────────────

export async function refreshSession(refreshToken: string): Promise<SupabaseSession> {
  return gotrueFetch<SupabaseSession>("/token?grant_type=refresh_token", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

// ── Signup ─────────────────────────────────────────────────────────────────

export async function signUp(
  email: string,
  password: string,
  userMetadata?: Record<string, unknown>,
): Promise<SupabaseSession | { user: SupabaseUser }> {
  return gotrueFetch("/signup", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      data: userMetadata,
    }),
  });
}

// ── Signout ────────────────────────────────────────────────────────────────

export async function signOut(accessToken: string): Promise<void> {
  await gotrueFetch("/logout", {
    method: "POST",
    accessToken,
  });
}

// ── Recupera user pelo access_token (usado raramente — prefer verify local) ──

export async function getUserFromToken(accessToken: string): Promise<SupabaseUser | null> {
  try {
    return await gotrueFetch<SupabaseUser>("/user", {
      method: "GET",
      accessToken,
    });
  } catch {
    return null;
  }
}

// ── Admin (service_role) ───────────────────────────────────────────────────

export interface AdminCreateUserInput {
  email: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export async function adminCreateUser(input: AdminCreateUserInput): Promise<SupabaseUser> {
  return gotrueFetch<SupabaseUser>("/admin/users", {
    method: "POST",
    useServiceRole: true,
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      email_confirm: input.email_confirm ?? true,
      user_metadata: input.user_metadata,
      app_metadata: input.app_metadata,
    }),
  });
}

export async function adminSendPasswordReset(email: string, redirectTo?: string): Promise<void> {
  await gotrueFetch("/recover", {
    method: "POST",
    body: JSON.stringify({ email, redirect_to: redirectTo }),
  });
}

export async function adminGetUserByEmail(email: string): Promise<SupabaseUser | null> {
  // ATENÇÃO: gotrue NÃO suporta filtro por email em GET /admin/users — o
  // parâmetro ?email= é silenciosamente ignorado e a lista inteira volta
  // paginada. Bug detectado em prod (2026-04-18) após script confiar em
  // users[0] e ligar user errado. Fix: fetch paginado + filtro client-side.
  try {
    const emailLower = email.toLowerCase();
    const perPage = 1000;
    for (let page = 1; page < 100; page++) {
      const { users } = await gotrueFetch<{ users: SupabaseUser[] }>(
        `/admin/users?page=${page}&per_page=${perPage}`,
        { method: "GET", useServiceRole: true },
      );
      if (!users || users.length === 0) return null;
      const match = users.find((u) => u.email?.toLowerCase() === emailLower);
      if (match) return match;
      if (users.length < perPage) return null;
    }
    return null;
  } catch {
    return null;
  }
}

export interface AdminUpdateUserInput {
  password?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export async function adminUpdateUser(
  userId: string,
  input: AdminUpdateUserInput,
): Promise<SupabaseUser> {
  return gotrueFetch<SupabaseUser>(`/admin/users/${userId}`, {
    method: "PUT",
    useServiceRole: true,
    body: JSON.stringify(input),
  });
}

// ── Cookie helpers ─────────────────────────────────────────────────────────
// Nomes alinhados com @supabase/ssr para compatibilidade com o pacote oficial
// se migrarmos depois. Access token é curto (1h), refresh token 30d.

import type { NextResponse } from "next/server";

export const SUPABASE_ACCESS_COOKIE = "sb-access-token";
export const SUPABASE_REFRESH_COOKIE = "sb-refresh-token";

const ACCESS_COOKIE_MAX_AGE = 60 * 60; // 1h
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30d

interface CookieAttrs {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  maxAge: number;
  path: string;
}

function cookieAttrs(maxAge: number): CookieAttrs {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge,
    path: "/",
  };
}

export function setSupabaseCookies(
  response: NextResponse,
  session: { access_token: string; refresh_token: string },
): NextResponse {
  response.cookies.set(SUPABASE_ACCESS_COOKIE, session.access_token, cookieAttrs(ACCESS_COOKIE_MAX_AGE));
  response.cookies.set(SUPABASE_REFRESH_COOKIE, session.refresh_token, cookieAttrs(REFRESH_COOKIE_MAX_AGE));
  return response;
}

export function clearSupabaseCookies(response: NextResponse): NextResponse {
  response.cookies.delete(SUPABASE_ACCESS_COOKIE);
  response.cookies.delete(SUPABASE_REFRESH_COOKIE);
  return response;
}
