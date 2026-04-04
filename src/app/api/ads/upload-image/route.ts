/**
 * POST /api/ads/upload-image
 *
 * Upload de uma única imagem para a conta Meta, retornando o hash.
 * Útil para carrosséis grandes que excedem o limite de payload do Vercel (~4.5 MB).
 *
 * Body (JSON):
 * {
 *   "account_id": "act_3601611403432716",
 *   "image_base64": "iVBOR...",
 *   "filename": "T7EBMX-CA-038A.png"
 * }
 *
 * Response:
 * { "hash": "abc123...", "filename": "T7EBMX-CA-038A.png" }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 120;

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { account_id, image_base64, filename } = body as {
      account_id: string;
      image_base64: string;
      filename: string;
    };

    if (!account_id || !image_base64 || !filename) {
      return NextResponse.json(
        { error: "account_id, image_base64, and filename are required" },
        { status: 400 }
      );
    }

    const token = await getTokenForWorkspace(auth.workspace_id);
    const imageBuffer = Buffer.from(image_base64, "base64");
    console.log(`[UploadImage] Uploading ${filename} (${imageBuffer.length} bytes) to ${account_id}`);

    const formParams = Object.entries({
      access_token: token,
      filename,
      bytes: image_base64,
    })
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const resp = await fetch(`${META_BASE_URL}/${account_id}/adimages`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formParams,
    });

    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error(`Meta API error: ${JSON.stringify(data.error)}`);
    }

    const imageInfo = Object.values(data.images as Record<string, { hash: string }>)[0];
    if (!imageInfo?.hash) throw new Error(`Upload failed for ${filename}`);

    console.log(`[UploadImage] Success: ${filename} → hash=${imageInfo.hash}`);

    return NextResponse.json({
      hash: imageInfo.hash,
      filename,
    });
  } catch (err) {
    console.error("[UploadImage]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
