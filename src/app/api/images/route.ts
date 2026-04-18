/**
 * GET  /api/images  — lista imagens (opcionalmente filtradas por category)
 * POST /api/images  — upload multipart (file) ou download por URL para Vercel Blob
 *
 * MIGRADO NA FASE 1C (Wave 4):
 *  - getDb() → withWorkspace (RLS escopa images)
 *  - Queries tipadas via Drizzle
 *  - uuid() manual removido (defaultRandom)
 *  - Filtros workspace_id manuais removidos (RLS cobre)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { images } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { put } from "@vercel/blob";
import { v4 as uuid } from "uuid";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get("category");
    const limit = parseInt(searchParams.get("limit") || "100");

    const rows = await withWorkspace(auth.workspace_id, async (tx) =>
      tx
        .select()
        .from(images)
        .where(category ? eq(images.category, category) : undefined)
        .orderBy(desc(images.createdAt))
        .limit(limit),
    );

    return NextResponse.json({ images: rows, count: rows.length });
  } catch (error) {
    console.error("List images error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const formData = await req.formData();

    const file = formData.get("file") as File | null;
    const name = formData.get("name") as string;
    const category = formData.get("category") as string;
    const url = formData.get("url") as string | null;

    if (!name || !category) {
      return NextResponse.json(
        { error: "name and category are required" },
        { status: 400 },
      );
    }

    const validCategories = ["dra-priscila", "marca", "produto", "referencia"];
    if (!validCategories.includes(category)) {
      return NextResponse.json(
        { error: `category must be one of: ${validCategories.join(", ")}` },
        { status: 400 },
      );
    }

    // Vercel Blob usa uuid() só para path — não é o id da row (defaultRandom
    // gera o PK no insert).
    let blobUrl: string;
    if (file) {
      const ext = file.name.split(".").pop() || "png";
      const blob = await put(`images/${category}/${uuid()}.${ext}`, file, {
        access: "public",
        contentType: file.type,
      });
      blobUrl = blob.url;
    } else if (url) {
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") || "image/png";
      const ext = contentType.includes("png") ? "png" : "jpg";
      const blob = await put(
        `images/${category}/${uuid()}.${ext}`,
        Buffer.from(buffer),
        { access: "public", contentType },
      );
      blobUrl = blob.url;
    } else {
      return NextResponse.json(
        { error: "Either file or url is required" },
        { status: 400 },
      );
    }

    const image = await withWorkspace(auth.workspace_id, async (tx) => {
      const [row] = await tx
        .insert(images)
        .values({
          workspaceId: auth.workspace_id,
          name,
          category,
          blobUrl,
        })
        .returning();
      return row;
    });

    return NextResponse.json(
      {
        image: {
          id: image.id,
          name: image.name,
          category: image.category,
          blob_url: image.blobUrl,
          created_at: image.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Upload image error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
