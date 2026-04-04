import { NextRequest, NextResponse } from "next/server";
import { setSelectedFolderId } from "@/lib/google-drive";
import { requireAuth } from "@/lib/auth";

interface SelectFolderRequest {
  folder_id: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body: SelectFolderRequest = await req.json();

    if (!body.folder_id) {
      return NextResponse.json({ error: "folder_id is required" }, { status: 400 });
    }

    await setSelectedFolderId(auth.workspace_id, body.folder_id);

    return NextResponse.json({ success: true, folder_id: body.folder_id });
  } catch (error) {
    console.error("Select folder error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to select folder" },
      { status: 500 }
    );
  }
}
