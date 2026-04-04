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
 * Uso via script local: ver scripts/fix-control-blob.mjs
 */

import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";
export const maxDuration = 60;

// ── GET — Diagnóstico ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const db = getDb();

  // Criativo com URL fora do Vercel Blob = candidato a ter overlay da Meta
  const result = await db.execute(
    `SELECT id, name, blob_url, status, created_at
     FROM creatives
     WHERE blob_url NOT LIKE 'https://%.public.blob.vercel-storage.com/%'
     ORDER BY created_at DESC`
  );

  return NextResponse.json({
    candidates: result.rows,
    count: result.rowCount,
    note: "Criativos com blob_url fora do Vercel Blob — provavelmente CDN da Meta com overlay 'Conteúdo Sensível'.",
  });
}

// ── POST — Fix ───────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const db = getDb();
  const contentType = req.headers.get("content-type") || "";

  let creativeName: string;
  let imageBuffer: Buffer;
  let mimeType = "image/png";

  // Suporta multipart/form-data (para uso via cURL/Postman/script)
  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const nameField = formData.get("name");
    const imageFile = formData.get("image") as File | null;

    if (!nameField || !imageFile) {
      return NextResponse.json(
        { error: "Campos obrigatórios faltando: 'name' (string) e 'image' (File)" },
        { status: 400 }
      );
    }

    creativeName = nameField.toString();
    mimeType = imageFile.type || "image/png";
    imageBuffer = Buffer.from(await imageFile.arrayBuffer());
  } else {
    // JSON com base64 — usado pelo scripts/fix-control-blob.mjs
    interface FixBody {
      name?: string;
      imageBase64?: string;
      mimeType?: string;
    }
    const body = (await req.json()) as FixBody;

    if (!body.name || !body.imageBase64) {
      return NextResponse.json(
        { error: "Campos obrigatórios faltando: 'name' e 'imageBase64'" },
        { status: 400 }
      );
    }

    creativeName = body.name;
    mimeType = body.mimeType || "image/png";
    imageBuffer = Buffer.from(body.imageBase64, "base64");
  }

  // Verificar existência no DB
  const existing = await db.execute({
    sql: `SELECT id, name, blob_url FROM creatives WHERE name = ?`,
    args: [creativeName],
  });

  if (existing.rows.length === 0) {
    return NextResponse.json(
      { error: `Criativo '${creativeName}' não encontrado no DB` },
      { status: 404 }
    );
  }

  const row = existing.rows[0];
  const oldUrl = row.blob_url as string;

  // Upload para Vercel Blob (substitui URL antiga)
  const blob = await put(`creatives/${uuid()}.png`, imageBuffer, {
    access: "public",
    contentType: mimeType,
  });

  // Atualizar blob_url no DB
  await db.execute({
    sql: `UPDATE creatives SET blob_url = ? WHERE name = ?`,
    args: [blob.url, creativeName],
  });

  console.log(`[fix-control-blob] ${creativeName}: ${oldUrl} → ${blob.url}`);

  return NextResponse.json({
    success: true,
    creative: {
      id: row.id,
      name: creativeName,
      old_blob_url: oldUrl,
      new_blob_url: blob.url,
    },
  });
}
