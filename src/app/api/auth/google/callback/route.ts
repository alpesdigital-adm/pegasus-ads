import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, saveTokens } from "@/lib/google-drive";
import { initDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get("code");
    const error = searchParams.get("error");

    if (error) {
      return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(error)}`, request.url));
    }

    if (!code) {
      return NextResponse.redirect(new URL("/?error=no_code", request.url));
    }

    // Initialize DB first
    await initDb();

    // Exchange code for tokens
    const tokens = await exchangeCodeForToken(code);

    // Save tokens to DB
    await saveTokens(tokens);

    // Redirect back to app with success message
    return NextResponse.redirect(new URL("/?success=google_connected", request.url));
  } catch (error) {
    console.error("Callback error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to authenticate with Google";
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(errorMessage)}`, request.url));
  }
}
