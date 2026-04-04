/**
 * POST /api/generate/retry  — Tarefa 1.6: Retry/Regenerate individual
 *
 * Regenera um criativo específico (feed OU stories) sem refazer o par todo.
 * Reutiliza o mesmo prompt original, parent e referências.
 * Atualiza o blob_url do criativo existente no DB.
 *
 * Body:
 * {
 *   creative_id: string      // ID do criativo a regenerar (feed ou stories)
 *   aspect_ratio?: string    // Override de aspect ratio (padrão: auto pelo tamanho original)
 *   prompt_override?: string // Substituir o prompt (opcional — usa o original se omitido)
 * }
 *
 * Response:
 * {
 *   ok: true,
 *   creative_id: string,
 *   old_blob_url: string,
 *   new_blob_url: string,
 *   model: string,
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { generateImage } from "@/lib/gemini";
import { uploadToGoogleDrive, getSelectedFolderId } from "@/lib/google-drive";
import { put } from "@vercel/blob";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";
export const maxDuration = 120;

// Detecta aspect ratio pelo tamanho do criativo (Feed 1:1, Stories 9:16)
function inferAspectRatio(width?: number, height?: number): string | undefined {
  if (!width || !height) return undefined;
  const ratio = width / height;
  if (ratio > 0.95 && ratio < 1.05) return "1:1";       // Feed quadrado
  if (ratio < 0.6) return "9:16";                         // Stories vertical
  if (ratio > 1.6) return "16:9";                         // Horizontal
  return undefined;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const db = getDb();

  interface Body {
    creative_id?: string;
    aspect_ratio?: string;
    prompt_override?: string;
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch { /* ok */ }

  if (!body.creative_id) {
    return NextResponse.json({ error: "creative_id is required" }, { status: 400 });
  }

  // ── 1. Buscar o criativo e seu último prompt ──
  const creativeRow = await db.execute({
    sql: `
      SELECT c.id, c.name, c.blob_url, c.prompt, c.parent_id,
             c.model, c.width, c.height, c.generation,
             p.prompt_text, p.model AS prompt_model
      FROM creatives c
      LEFT JOIN prompts p ON p.creative_id = c.id
      ORDER BY p.created_at DESC
      LIMIT 1
    `,
    args: [],
  });

  // A query acima com LEFT JOIN pode retornar múltiplas rows se houver múltiplos prompts
  // Precisamos filtrar pelo creative_id
  const creativeWithPrompt = await db.execute({
    sql: `
      SELECT c.id, c.name, c.blob_url, c.prompt, c.parent_id,
             c.model, c.width, c.height, c.generation,
             (SELECT p.prompt_text FROM prompts p WHERE p.creative_id = c.id ORDER BY p.created_at DESC LIMIT 1) AS prompt_text,
             (SELECT p.model FROM prompts p WHERE p.creative_id = c.id ORDER BY p.created_at DESC LIMIT 1) AS prompt_model
      FROM creatives c
      WHERE c.id = ? AND c.workspace_id = ?
    `,
    args: [body.creative_id, auth.workspace_id],
  });

  void creativeRow; // silence unused warning

  if (creativeWithPrompt.rows.length === 0) {
    return NextResponse.json({ error: "Creative not found" }, { status: 404 });
  }

  const creative = creativeWithPrompt.rows[0];
  const promptText = body.prompt_override
    || (creative.prompt_text as string | null)
    || (creative.prompt as string | null);

  if (!promptText) {
    return NextResponse.json({ error: "No prompt found for this creative. Cannot retry." }, { status: 422 });
  }

  const oldBlobUrl = creative.blob_url as string;
  const aspectRatio = body.aspect_ratio
    || inferAspectRatio(creative.width as number | undefined, creative.height as number | undefined);

  // ── 2. Buscar imagens de referência ──
  const referenceImages: { base64: string; mimeType: string }[] = [];

  // Incluir parent como primeira referência (igual ao generate original)
  if (creative.parent_id) {
    const parentRow = await db.execute({
      sql: `SELECT blob_url FROM creatives WHERE id = ?`,
      args: [creative.parent_id as string],
    });
    if (parentRow.rows.length > 0) {
      const blobUrl = parentRow.rows[0].blob_url as string;
      try {
        const imgResponse = await fetch(blobUrl);
        const buffer = await imgResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const mimeType = imgResponse.headers.get("content-type") || "image/png";
        referenceImages.push({ base64, mimeType });
      } catch { /* ignore fetch errors on old blobs */ }
    }
  }

  // Incluir imagens de referência cadastradas
  const refImgRows = await db.execute({
    sql: `SELECT i.blob_url FROM creative_ref_images cri JOIN images i ON i.id = cri.image_id WHERE cri.creative_id = ?`,
    args: [body.creative_id],
  });
  for (const row of refImgRows.rows) {
    try {
      const imgResponse = await fetch(row.blob_url as string);
      const buffer = await imgResponse.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      const mimeType = imgResponse.headers.get("content-type") || "image/png";
      referenceImages.push({ base64, mimeType });
    } catch { /* ignore */ }
  }

  // ── 3. Chamar Gemini ──
  const result = await generateImage({
    prompt: promptText,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    aspectRatio,
    model: (creative.prompt_model as string) || (creative.model as string) || undefined,
  });

  if (result.error || result.images.length === 0) {
    return NextResponse.json(
      { error: result.error || "No images generated" },
      { status: 500 }
    );
  }

  // ── 4. Upload novo blob ──
  const generatedImage = result.images[0];
  const ext = generatedImage.mimeType.includes("png") ? "png" : "jpg";
  const imageBuffer = Buffer.from(generatedImage.base64, "base64");

  const blob = await put(`creatives/${body.creative_id}-retry-${Date.now()}.${ext}`, imageBuffer, {
    access: "public",
    contentType: generatedImage.mimeType,
  });

  // ── 5. Atualizar DB (blob_url + model) ──
  await db.execute({
    sql: `UPDATE creatives SET blob_url = ?, model = ?, status = 'generated' WHERE id = ?`,
    args: [blob.url, result.model, body.creative_id],
  });

  // Salvar novo registro de prompt
  await db.execute({
    sql: `INSERT INTO prompts (id, creative_id, prompt_text, prompt_format, model, reference_image_ids, response_raw)
          VALUES (?, ?, ?, 'text', ?, '[]', ?)`,
    args: [uuid(), body.creative_id, promptText, result.model, result.text || null],
  });

  // ── 6. Upload para Drive (opcional) ──
  try {
    const folderId = await getSelectedFolderId(auth.workspace_id);
    if (folderId) {
      const creativeName = creative.name as string;
      await uploadToGoogleDrive(
        auth.workspace_id,
        `${creativeName}-retry.${ext}`,
        imageBuffer,
        generatedImage.mimeType,
        folderId
      );
    }
  } catch { /* não falhar por Drive */ }

  console.log(`[GenerateRetry] Criativo ${body.creative_id} (${creative.name}) regenerado com sucesso.`);

  return NextResponse.json({
    ok: true,
    creative_id: body.creative_id,
    creative_name: creative.name,
    old_blob_url: oldBlobUrl,
    new_blob_url: blob.url,
    model: result.model,
    aspect_ratio: aspectRatio || null,
  });
}
