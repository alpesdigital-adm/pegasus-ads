/**
 * POST /api/generate/retry  — Tarefa 1.6: Retry/Regenerate individual
 *
 * Regenera um criativo específico (feed OU stories) sem refazer o par todo.
 * Reutiliza o mesmo prompt original, parent e referências.
 * Atualiza o blob_url do criativo existente no DB.
 *
 * MIGRADO NA FASE 1C (Wave 7):
 *  - getDb() → withWorkspace (RLS escopa creatives/prompts/creative_ref_images/images)
 *  - uuid() manual removido (defaultRandom)
 *  - Queries legadas duplicadas consolidadas
 */

import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { creatives, prompts, creativeRefImages, images } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { generateImage } from "@/lib/gemini";
import { uploadToGoogleDrive, getSelectedFolderId } from "@/lib/google-drive";
import { put } from "@vercel/blob";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 120;

function inferAspectRatio(width?: number | null, height?: number | null): string | undefined {
  if (!width || !height) return undefined;
  const ratio = width / height;
  if (ratio > 0.95 && ratio < 1.05) return "1:1";
  if (ratio < 0.6) return "9:16";
  if (ratio > 1.6) return "16:9";
  return undefined;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

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

  const ws = auth.workspace_id;

  // ── 1. Carrega contexto: creative + last prompt + refs ──
  const ctx = await withWorkspace(ws, async (tx) => {
    const cRows = await tx
      .select()
      .from(creatives)
      .where(eq(creatives.id, body.creative_id!))
      .limit(1);
    if (cRows.length === 0) return null;
    const creative = cRows[0];

    const pRows = await tx
      .select({ promptText: prompts.promptText, model: prompts.model })
      .from(prompts)
      .where(eq(prompts.creativeId, creative.id))
      .orderBy(desc(prompts.createdAt))
      .limit(1);
    const lastPrompt = pRows[0] ?? null;

    let parentBlobUrl: string | null = null;
    if (creative.parentId) {
      const pR = await tx
        .select({ blobUrl: creatives.blobUrl })
        .from(creatives)
        .where(eq(creatives.id, creative.parentId))
        .limit(1);
      if (pR.length > 0) parentBlobUrl = pR[0].blobUrl;
    }

    const refRows = await tx
      .select({ blobUrl: images.blobUrl })
      .from(creativeRefImages)
      .innerJoin(images, eq(images.id, creativeRefImages.imageId))
      .where(eq(creativeRefImages.creativeId, creative.id));

    return {
      creative,
      lastPrompt,
      parentBlobUrl,
      refBlobUrls: refRows.map((r) => r.blobUrl),
    };
  });

  if (!ctx) {
    return NextResponse.json({ error: "Creative not found" }, { status: 404 });
  }

  const { creative, lastPrompt, parentBlobUrl, refBlobUrls } = ctx;

  const promptText = body.prompt_override || lastPrompt?.promptText || creative.prompt;
  if (!promptText) {
    return NextResponse.json(
      { error: "No prompt found for this creative. Cannot retry." },
      { status: 422 },
    );
  }

  const oldBlobUrl = creative.blobUrl;
  const aspectRatio = body.aspect_ratio || inferAspectRatio(creative.width, creative.height);

  // ── 2. Fetch blobs (HTTP, fora de transação) ──
  const referenceImages: { base64: string; mimeType: string }[] = [];

  if (parentBlobUrl) {
    try {
      const imgResponse = await fetch(parentBlobUrl);
      const buffer = await imgResponse.arrayBuffer();
      referenceImages.push({
        base64: Buffer.from(buffer).toString("base64"),
        mimeType: imgResponse.headers.get("content-type") || "image/png",
      });
    } catch { /* ignore */ }
  }

  for (const url of refBlobUrls) {
    try {
      const imgResponse = await fetch(url);
      const buffer = await imgResponse.arrayBuffer();
      referenceImages.push({
        base64: Buffer.from(buffer).toString("base64"),
        mimeType: imgResponse.headers.get("content-type") || "image/png",
      });
    } catch { /* ignore */ }
  }

  // ── 3. Gemini ──
  const result = await generateImage({
    prompt: promptText,
    referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    aspectRatio,
    model: lastPrompt?.model || creative.model || undefined,
  });

  if (result.error || result.images.length === 0) {
    return NextResponse.json(
      { error: result.error || "No images generated" },
      { status: 500 },
    );
  }

  // ── 4. Blob upload ──
  const generatedImage = result.images[0];
  const ext = generatedImage.mimeType.includes("png") ? "png" : "jpg";
  const imageBuffer = Buffer.from(generatedImage.base64, "base64");

  const blob = await put(
    `creatives/${creative.id}-retry-${Date.now()}.${ext}`,
    imageBuffer,
    { access: "public", contentType: generatedImage.mimeType },
  );

  // ── 5. Persistência ──
  await withWorkspace(ws, async (tx) => {
    await tx
      .update(creatives)
      .set({ blobUrl: blob.url, model: result.model, status: "generated" })
      .where(eq(creatives.id, creative.id));

    await tx.insert(prompts).values({
      creativeId: creative.id,
      promptText,
      promptFormat: "text",
      model: result.model,
      referenceImageIds: [],
      responseRaw: result.text || null,
    });
  });

  // ── 6. Drive (opcional) ──
  try {
    const folderId = await getSelectedFolderId(ws);
    if (folderId) {
      await uploadToGoogleDrive(
        ws,
        `${creative.name}-retry.${ext}`,
        imageBuffer,
        generatedImage.mimeType,
        folderId,
      );
    }
  } catch { /* não falhar por Drive */ }

  console.log(`[GenerateRetry] Criativo ${creative.id} (${creative.name}) regenerado com sucesso.`);

  return NextResponse.json({
    ok: true,
    creative_id: creative.id,
    creative_name: creative.name,
    old_blob_url: oldBlobUrl,
    new_blob_url: blob.url,
    model: result.model,
    aspect_ratio: aspectRatio || null,
  });
}
