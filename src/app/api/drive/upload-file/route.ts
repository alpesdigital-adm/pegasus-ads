import { NextRequest, NextResponse } from "next/server";
import { uploadToGoogleDrive, getSelectedFolderId } from "@/lib/google-drive";
import { initDb } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    await initDb();

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const fileName = formData.get("file_name") as string | null;

    if (!file) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const folderId = await getSelectedFolderId();
    if (!folderId) {
      return NextResponse.json({ error: "No Google Drive folder selected" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const name = fileName || file.name;
    const mimeType = file.type || "image/png";

    const fileId = await uploadToGoogleDrive(name, buffer, mimeType, folderId);

    return NextResponse.json({ success: true, file_id: fileId, file_name: name });
  } catch (error) {
    console.error("Upload file error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload" },
      { status: 500 }
    );
  }
}
