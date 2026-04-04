import { NextRequest, NextResponse } from "next/server";
import { getConnectionStatus } from "@/lib/google-drive";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const status = await getConnectionStatus(auth.workspace_id);
    return NextResponse.json(status);
  } catch (error) {
    console.error("Status error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get connection status" },
      { status: 500 }
    );
  }
}
