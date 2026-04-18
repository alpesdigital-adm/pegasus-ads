/**
 * POST /api/auth/logout
 *
 * Destrói a sessão atual. Limpa cookies Supabase (sb-access-token +
 * sb-refresh-token) E legado (pegasus_session) — usuário pode estar em
 * qualquer um dos dois paths durante a transição.
 *
 * Revoga o refresh token no gotrue (best-effort — falha não bloqueia logout
 * do client).
 */
import { NextRequest, NextResponse } from "next/server";
import { deleteSession, clearSessionCookie } from "@/lib/auth";
import {
  SUPABASE_ACCESS_COOKIE,
  clearSupabaseCookies,
  signOut,
} from "@/lib/supabase-auth";

export async function POST(req: NextRequest) {
  // Path legado
  const pegasusToken = req.cookies.get("pegasus_session")?.value;
  if (pegasusToken) {
    await deleteSession(pegasusToken).catch((e) =>
      console.warn("[auth/logout] legacy session delete failed:", e),
    );
  }

  // Path Supabase — revoga no gotrue (opcional)
  const sbAccess = req.cookies.get(SUPABASE_ACCESS_COOKIE)?.value;
  if (sbAccess) {
    await signOut(sbAccess).catch((e) =>
      console.warn("[auth/logout] supabase signOut failed:", e),
    );
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  clearSupabaseCookies(response);
  return response;
}
