import { NextRequest, NextResponse } from "next/server";
import { uploadToGoogleDrive, getSelectedFolderId } from "@/lib/google-drive";
import { requireAuth } from "@/lib/auth";

interface UploadRequest {
  creative_id: string;
  blob_url: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body: UploadRequest = await req.json();

    if (!body.creative_id || !body.blob_url) {
      return NextResponse.json(
        { error: "creative_id and blob_url are required" },
        { status: 400 }
      );
    }

    // Check if folder is selected
    const folderId = await getSelectedFolderId();
    if (!folderId) {
      return NextResponse.json(
        { error: "No Google Drive folder selected" },
        { status: 400 }
      );
    }

    // Fetch image from blob URL
    const imageResponse = await fetch(body.blob_url);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const mimeType = imageResponse.headers.get("content-type") || "image/png";
    const fileName = `creative-${body.creative_id}.${mimeType.split("/")[1]}`;

    // Upload to Google Drive
    const fileId = await uploadToGoogleDrive(fileName, imageBuffer, mimeType, folderId);

    return NextResponse.json({ success: true, file_id: fileId });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload to Google Drive" },
      { status: 500 }
    );
  }
}
