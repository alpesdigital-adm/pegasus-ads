import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { put } from "@vercel/blob";
import { v4 as uuid } from "uuid";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const { searchParams } = new URL(req.url);

    const category = searchParams.get("category");
    const limit = parseInt(searchParams.get("limit") || "100");

    let sql = "SELECT * FROM images WHERE workspace_id = ?";
    const args: (string | number)[] = [auth.workspace_id];

    if (category) {
      sql += " AND category = ?";
      args.push(category);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    args.push(limit);

    const result = await db.execute({ sql, args });
    return NextResponse.json({ images: result.rows, count: result.rows.length });
  } catch (error) {
    console.error("List images error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const formData = await req.formData();

    const file = formData.get("file") as File | null;
    const name = formData.get("name") as string;
    const category = formData.get("category") as string;
    const url = formData.get("url") as string | null;

    if (!name || !category) {
      return NextResponse.json(
        { error: "name and category are required" },
        { status: 400 }
      );
    }

    const validCategories = ["dra-priscila", "marca", "produto", "referencia"];
    if (!validCategories.includes(category)) {
      return NextResponse.json(
        { error: `category must be one of: ${validCategories.join(", ")}` },
        { status: 400 }
      );
    }

    let blobUrl: string;

    if (file) {
      const imageId = uuid();
      const ext = file.name.split(".").pop() || "png";
      const blob = await put(`images/${category}/${imageId}.${ext}`, file, {
        access: "public",
        contentType: file.type,
      });
      blobUrl = blob.url;
    } else if (url) {
      // Download from URL and store in blob
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") || "image/png";
      const ext = contentType.includes("png") ? "png" : "jpg";
      const imageId = uuid();
      const blob = await put(
        `images/${category}/${imageId}.${ext}`,
        Buffer.from(buffer),
        { access: "public", contentType }
      );
      blobUrl = blob.url;
    } else {
      return NextResponse.json(
        { error: "Either file or url is required" },
        { status: 400 }
      );
    }

    const id = uuid();
    await db.execute({
      sql: `INSERT INTO images (id, name, category, blob_url, workspace_id) VALUES (?, ?, ?, ?, ?)`,
      args: [id, name, category, blobUrl, auth.workspace_id],
    });

    const image = { id, name, category, blob_url: blobUrl, created_at: new Date().toISOString() };
    return NextResponse.json({ image }, { status: 201 });
  } catch (error) {
    console.error("Upload image error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
