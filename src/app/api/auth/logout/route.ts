/**
 * POST /api/auth/logout
 *
 * Destrói a sessão atual.
 *
 * Errors:
 * - 401 UNAUTHORIZED: não autenticado
 */
import { NextRequest, NextResponse } from "next/server";
import { deleteSession, clearSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const token = req.cookies.get("pegasus_session")?.value;
  if (token) {
    await deleteSession(token);
  }

  const response = NextResponse.json({ ok: true });
  return clearSessionCookie(response);
}
