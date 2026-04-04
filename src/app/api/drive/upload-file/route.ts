import { NextRequest, NextResponse } from "next/server";
import { uploadToGoogleDrive, getSelectedFolderId } from "@/lib/google-drive";
import { requireAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const fileName = formData.get("file_name") as string | null;

    if (!file) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const folderId = await getSelectedFolderId(auth.workspace_id);
    if (!folderId) {
      return NextResponse.json({ error: "No Google Drive folder selected" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const name = fileName || file.name;
    const mimeType = file.type || "image/png";

    const fileId = await uploadToGoogleDrive(auth.workspace_id, name, buffer, mimeType, folderId);

    return NextResponse.json({ success: true, file_id: fileId, file_name: name });
  } catch (error) {
    console.error("Upload file error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload" },
      { status: 500 }
    );
  }
}
