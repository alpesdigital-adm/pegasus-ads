/**
 * GET /api/auth/google/callback
 *
 * Callback do OAuth Google — troca code por tokens e persiste.
 *
 * MIGRADO NA FASE 1C (Wave 1 auth):
 *  - initDb() removido — schema é gerenciado por Drizzle migrations.
 *  - saveTokens continua via google-drive.ts (library legado — migração
 *    pendente junto com google-drive.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, saveTokens } from "@/lib/google-drive";
import { requireAuth } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (auth instanceof NextResponse) {
      return NextResponse.redirect(new URL("/?error=not_authenticated", request.url));
    }

    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get("code");
    const error = searchParams.get("error");

    if (error) {
      return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(error)}`, request.url));
    }

    if (!code) {
      return NextResponse.redirect(new URL("/?error=no_code", request.url));
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForToken(code);

    // Save tokens to DB (via google-drive.ts legacy — migra com workspace.ts)
    await saveTokens(auth.workspace_id, tokens);

    // Redirect back to app with success message
    return NextResponse.redirect(new URL("/?success=google_connected", request.url));
  } catch (error) {
    console.error("Callback error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to authenticate with Google";
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(errorMessage)}`, request.url));
  }
}
