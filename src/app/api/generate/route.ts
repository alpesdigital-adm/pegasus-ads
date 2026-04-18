/**
 * POST /api/generate
 *
 * Gera uma imagem via Gemini e persiste como creative + prompt + edges.
 *
 * MIGRADO NA FASE 1C (Wave 7):
 *  - getDb() → withWorkspace (RLS escopa images/creatives/prompts/edges/refs)
 *  - uuid() removido (defaultRandom no schema para PKs)
 *  - Vercel Blob path usa timestamp (creativeId real só existe após INSERT)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import {
  images,
  creatives,
  prompts,
  creativeEdges,
  creativeRefImages,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { generateImage } from "@/lib/gemini";
import { uploadToGoogleDrive, getSelectedFolderId } from "@/lib/google-drive";
import { put } from "@vercel/blob";
import { eq, inArray } from "drizzle-orm";
import type { GenerateRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body: GenerateRequest = await request.json();
    if (!body.prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const ws = auth.workspace_id;

    // ── Coleta de reference images (RLS escopa images/creatives) ──
    const { referenceBlobs, parentGeneration } = await withWorkspace(ws, async (tx) => {
      const refBlobUrls: string[] = [];

      if (body.reference_image_ids?.length) {
        const refRows = await tx
          .select({ blobUrl: images.blobUrl })
          .from(images)
          .where(inArray(images.id, body.reference_image_ids));
        for (const r of refRows) refBlobUrls.push(r.blobUrl);
      }

      let parentBlobUrl: string | null = null;
      let parentGen = 0;
      if (body.parent_creative_id) {
        const parentRow = await tx
          .select({ blobUrl: creatives.blobUrl, generation: creatives.generation })
          .from(creatives)
          .where(eq(creatives.id, body.parent_creative_id))
          .limit(1);
        if (parentRow.length > 0) {
          parentBlobUrl = parentRow[0].blobUrl;
          parentGen = (parentRow[0].generation ?? 0) + 1;
        }
      }

      return {
        referenceBlobs: { refs: refBlobUrls, parent: parentBlobUrl },
        parentGeneration: parentGen,
      };
    });

    // ── Fetch blobs para base64 (HTTP, fora da transação) ──
    const referenceImages: { base64: string; mimeType: string }[] = [];
    for (const url of referenceBlobs.refs) {
      const imgResponse = await fetch(url);
      const buffer = await imgResponse.arrayBuffer();
      referenceImages.push({
        base64: Buffer.from(buffer).toString("base64"),
        mimeType: imgResponse.headers.get("content-type") || "image/png",
      });
    }
    if (referenceBlobs.parent) {
      const imgResponse = await fetch(referenceBlobs.parent);
      const buffer = await imgResponse.arrayBuffer();
      referenceImages.unshift({
        base64: Buffer.from(buffer).toString("base64"),
        mimeType: imgResponse.headers.get("content-type") || "image/png",
      });
    }

    // ── Gemini call ──
    const result = await generateImage({
      prompt: body.prompt,
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      aspectRatio: body.aspect_ratio,
      imageSize: body.image_size,
      model: body.model,
    });

    if (result.error || result.images.length === 0) {
      return NextResponse.json(
        { error: result.error || "No images generated" },
        { status: 500 },
      );
    }

    // ── Blob upload ──
    const generatedImage = result.images[0];
    const ext = generatedImage.mimeType.includes("png") ? "png" : "jpg";
    const creativeName = body.name || `creative-${Date.now()}`;
    const imageBuffer = Buffer.from(generatedImage.base64, "base64");

    const blob = await put(`creatives/${Date.now()}-${creativeName}.${ext}`, imageBuffer, {
      access: "public",
      contentType: generatedImage.mimeType,
    });

    // ── Persistência ──
    const { creative, edges } = await withWorkspace(ws, async (tx) => {
      const [c] = await tx
        .insert(creatives)
        .values({
          workspaceId: ws,
          name: creativeName,
          blobUrl: blob.url,
          prompt: body.prompt,
          promptJson: body.prompt_format === "json" ? body.prompt : null,
          model: result.model,
          parentId: body.parent_creative_id || null,
          generation: parentGeneration,
          status: "generated",
        })
        .returning();

      await tx.insert(prompts).values({
        creativeId: c.id,
        promptText: body.prompt,
        promptFormat: body.prompt_format || "text",
        model: result.model,
        referenceImageIds: body.reference_image_ids || [],
        responseRaw: result.text || null,
      });

      const edgeList: Array<{
        id: string;
        source_id: string;
        target_id: string;
        relationship: string;
        variable_isolated: string | null;
      }> = [];

      if (body.parent_creative_id) {
        const [edge] = await tx
          .insert(creativeEdges)
          .values({
            workspaceId: ws,
            sourceId: body.parent_creative_id,
            targetId: c.id,
            relationship: body.relationship || "variation",
            variableIsolated: body.variable_isolated || null,
          })
          .returning();
        edgeList.push({
          id: edge.id,
          source_id: edge.sourceId,
          target_id: edge.targetId,
          relationship: edge.relationship ?? "variation",
          variable_isolated: edge.variableIsolated,
        });
      }

      if (body.reference_image_ids?.length) {
        await tx.insert(creativeRefImages).values(
          body.reference_image_ids.map((imgId) => ({
            workspaceId: ws,
            creativeId: c.id,
            imageId: imgId,
            role: "reference",
          })),
        );
      }

      return {
        creative: {
          id: c.id,
          name: c.name,
          blob_url: c.blobUrl,
          prompt: c.prompt,
          model: c.model,
          parent_id: c.parentId,
          generation: c.generation,
          status: c.status,
          created_at: c.createdAt,
        },
        edges: edgeList,
      };
    });

    // ── Google Drive (não-crítico) ──
    try {
      const folderId = await getSelectedFolderId(ws);
      if (folderId) {
        await uploadToGoogleDrive(
          ws,
          `creative-${creative.id}.${ext}`,
          imageBuffer,
          generatedImage.mimeType,
          folderId,
        );
      }
    } catch (driveError) {
      console.error("Failed to auto-upload to Google Drive:", driveError);
    }

    return NextResponse.json({ creative, edges }, { status: 201 });
  } catch (error) {
    console.error("Generate error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
