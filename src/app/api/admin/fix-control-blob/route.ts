/**
 * /api/admin/fix-control-blob
 *
 * Tarefa 1.5 — Imagem controle limpa
 *
 * Problema: o blob_url do controle pode apontar para a CDN da Meta, que
 * adiciona overlay "Conteúdo Sensível" sobre a imagem. O generate pipeline
 * faz fetch(controlBlobUrl) no Step 1, enviando essa imagem com overlay
 * para o Gemini como referência — comprometendo a qualidade das variantes.
 *
 * Solução: re-fazer upload da versão limpa (sem overlay) para o Vercel Blob
 * e atualizar o blob_url no DB.
 *
 * GET  → diagnóstico: lista criativos com blob_url fora do Vercel Blob
 * POST → fix: recebe imagem (multipart ou base64 JSON) e atualiza o DB
 *
 * MIGRADO NA FASE 1C (Wave 6 misc):
 *  - getDb() → withWorkspace (RLS escopa creatives por workspace)
 *  - Queries tipadas via Drizzle
 *  - uuid() mantido só para nome do blob (id do row via defaultRandom)
 */

import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { withWorkspace } from "@/lib/db";
import { creatives } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { eq, notLike } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 60;

// ── GET — Diagnóstico ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const rows = await withWorkspace(auth.workspace_id, async (tx) =>
    tx
      .select({
        id: creatives.id,
        name: creatives.name,
        blob_url: creatives.blobUrl,
        status: creatives.status,
        created_at: creatives.createdAt,
      })
      .from(creatives)
      .where(notLike(creatives.blobUrl, "https://%.public.blob.vercel-storage.com/%")),
  );

  return NextResponse.json({
    candidates: rows,
    count: rows.length,
    note: "Criativos com blob_url fora do Vercel Blob — provavelmente CDN da Meta com overlay 'Conteúdo Sensível'.",
  });
}

// ── POST — Fix ───────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const contentType = req.headers.get("content-type") || "";

  let creativeName: string;
  let imageBuffer: Buffer;
  let mimeType = "image/png";

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const nameField = formData.get("name");
    const imageFile = formData.get("image") as File | null;

    if (!nameField || !imageFile) {
      return NextResponse.json(
        { error: "Campos obrigatórios faltando: 'name' (string) e 'image' (File)" },
        { status: 400 },
      );
    }
    creativeName = nameField.toString();
    mimeType = imageFile.type || "image/png";
    imageBuffer = Buffer.from(await imageFile.arrayBuffer());
  } else {
    interface FixBody {
      name?: string;
      imageBase64?: string;
      mimeType?: string;
    }
    const body = (await req.json()) as FixBody;
    if (!body.name || !body.imageBase64) {
      return NextResponse.json(
        { error: "Campos obrigatórios faltando: 'name' e 'imageBase64'" },
        { status: 400 },
      );
    }
    creativeName = body.name;
    mimeType = body.mimeType || "image/png";
    imageBuffer = Buffer.from(body.imageBase64, "base64");
  }

  // Uploads go outside the tx (Vercel Blob call, não-atômico com DB)
  const blob = await put(`creatives/${uuid()}.png`, imageBuffer, {
    access: "public",
    contentType: mimeType,
  });

  const result = await withWorkspace(auth.workspace_id, async (tx) => {
    const existing = await tx
      .select({
        id: creatives.id,
        name: creatives.name,
        blobUrl: creatives.blobUrl,
      })
      .from(creatives)
      .where(eq(creatives.name, creativeName))
      .limit(1);

    if (existing.length === 0) return null;

    const row = existing[0];
    await tx
      .update(creatives)
      .set({ blobUrl: blob.url })
      .where(eq(creatives.name, creativeName));

    return { id: row.id, oldUrl: row.blobUrl };
  });

  if (!result) {
    return NextResponse.json(
      { error: `Criativo '${creativeName}' não encontrado no DB` },
      { status: 404 },
    );
  }

  console.log(`[fix-control-blob] ${creativeName}: ${result.oldUrl} → ${blob.url}`);

  return NextResponse.json({
    success: true,
    creative: {
      id: result.id,
      name: creativeName,
      old_blob_url: result.oldUrl,
      new_blob_url: blob.url,
    },
  });
}
