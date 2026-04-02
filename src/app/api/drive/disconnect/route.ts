import { NextRequest, NextResponse } from "next/server";
import { disconnect } from "@/lib/google-drive";
import { initDb } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    await initDb();
    await disconnect();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Disconnect error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to disconnect" },
      { status: 500 }
    );
  }
}
