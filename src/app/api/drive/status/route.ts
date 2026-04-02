import { NextRequest, NextResponse } from "next/server";
import { getConnectionStatus } from "@/lib/google-drive";
import { initDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    await initDb();
    const status = await getConnectionStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error("Status error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get connection status" },
      { status: 500 }
    );
  }
}
