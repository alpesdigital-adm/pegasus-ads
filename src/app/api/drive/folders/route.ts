import { NextRequest, NextResponse } from "next/server";
import { listFolders } from "@/lib/google-drive";
import { initDb } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    await initDb();
    const folders = await listFolders();
    return NextResponse.json({ folders });
  } catch (error) {
    console.error("Folders error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list folders" },
      { status: 500 }
    );
  }
}
