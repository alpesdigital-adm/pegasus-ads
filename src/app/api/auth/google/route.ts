import { NextRequest, NextResponse } from "next/server";
import { generateAuthUrl } from "@/lib/google-drive";

export async function GET(request: NextRequest) {
  try {
    const authUrl = generateAuthUrl();
    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error("Auth error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate auth URL" },
      { status: 500 }
    );
  }
}
