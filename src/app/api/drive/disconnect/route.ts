import { NextRequest, NextResponse } from "next/server";
import { disconnect } from "@/lib/google-drive";
import { requireAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    await disconnect(auth.workspace_id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Disconnect error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to disconnect" },
      { status: 500 }
    );
  }
}
