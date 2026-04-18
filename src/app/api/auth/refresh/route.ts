/**
 * POST /api/auth/refresh
 *
 * Troca sb-refresh-token por um novo par access/refresh. Chamada pelo
 * frontend quando detecta 401 (access expirado) antes de redirecionar
 * pro login.
 *
 * Errors:
 *  - 401 NO_REFRESH_TOKEN: cookie ausente
 *  - 401 INVALID_REFRESH: gotrue rejeitou
 *  - 500 INTERNAL_ERROR: falha inesperada
 */
import { NextRequest, NextResponse } from "next/server";
import {
  GotrueHttpError,
  SUPABASE_REFRESH_COOKIE,
  clearSupabaseCookies,
  refreshSession,
  setSupabaseCookies,
} from "@/lib/supabase-auth";

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get(SUPABASE_REFRESH_COOKIE)?.value;
  if (!refreshToken) {
    return NextResponse.json(
      { error: "NO_REFRESH_TOKEN", message: "Missing refresh token cookie." },
      { status: 401 },
    );
  }

  try {
    const session = await refreshSession(refreshToken);
    const response = NextResponse.json({ ok: true, expires_at: session.expires_at });
    return setSupabaseCookies(response, session);
  } catch (err) {
    if (err instanceof GotrueHttpError && err.status < 500) {
      // Refresh token inválido / expirado — limpa cookies pra forçar login
      const response = NextResponse.json(
        { error: "INVALID_REFRESH", message: err.message },
        { status: 401 },
      );
      return clearSupabaseCookies(response);
    }

    console.error("[auth/refresh]", err);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
