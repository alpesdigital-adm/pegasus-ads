/**
 * POST /api/auth/logout
 *
 * Destrói a sessão Supabase atual: revoga refresh token no gotrue
 * (best-effort) + limpa cookies sb-access-token, sb-refresh-token e
 * pegasus_workspace_id.
 */
import { NextRequest, NextResponse } from "next/server";
import { clearWorkspaceCookie } from "@/lib/auth";
import {
  SUPABASE_ACCESS_COOKIE,
  clearSupabaseCookies,
  signOut,
} from "@/lib/supabase-auth";

export async function POST(req: NextRequest) {
  const sbAccess = req.cookies.get(SUPABASE_ACCESS_COOKIE)?.value;
  if (sbAccess) {
    await signOut(sbAccess).catch((e) =>
      console.warn("[auth/logout] supabase signOut failed:", e),
    );
  }

  const response = NextResponse.json({ ok: true });
  clearSupabaseCookies(response);
  clearWorkspaceCookie(response);
  return response;
}
