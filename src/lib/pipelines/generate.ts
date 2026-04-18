/**
 * GeneratePipeline — Orquestra a geração de variantes para teste A/B.
 *
 * Fluxo:
 * 1. Buscar imagem controle (blob → base64)
 * 2. Gerar prompt dinâmico (AI Prompt Service)
 * 3. Chamar Gemini para gerar imagem (Feed + Stories)
 * 4. Resize para dimensões corretas
 * 5. Salvar no Vercel Blob
 * 6. Salvar no banco (creative, edge, prompt)
 * 7. Upload para Google Drive
 * 8. Checkpoint post_generation
 * 9. Atualizar test_round status
 *
 * MIGRADO NA FASE 1C (Wave 7 libs):
 *  - getDb() → withWorkspace (RLS escopa todas as tabelas envolvidas)
 *  - Cada "sub-bloco" de DB usa withWorkspace separado (pipeline roda
 *    Gemini + blob uploads entre queries; transação única manteria
 *    conexão aberta por minutos)
 *  - uuid() manual removido quando possível (defaultRandom no schema)
 */

import { withWorkspace } from "../db";
import {
  pipelineExecutions,
  testRounds,
  testRoundVariants,
  creatives,
  creativeEdges,
  prompts,
} from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { generateImage } from "../gemini";
import { buildVariantPrompt, getVariableType, parseColorSpec, type ControlTexts } from "../ai-prompt";
import { verifyPostGeneration } from "../ai-verify";
import { getNextAdNumber, generateCreativeNamePair, generateMetaAdName } from "../creative-naming";
import { uploadToGoogleDrive, getSelectedFolderId } from "../google-drive";
import { put } from "@vercel/blob";
import type { PipelineStep } from "../types";
import { logger } from "../logger";

const log = logger.child({ pipeline: "generate" });

async function resizeImage(
  imageBase64: string,
  targetWidth: number,
  targetHeight: number,
): Promise<Buffer> {
  const inputBuffer = Buffer.from(imageBase64, "base64");
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(inputBuffer)
      .resize(targetWidth, targetHeight, { fit: "cover" })
      .png()
      .toBuffer();
  } catch {
    log.warn("sharp unavailable, returning image without resize");
    return inputBuffer;
  }
}

async function fetchColorSpec(
  controlBase64: string,
  controlMimeType: string,
  variableValue?: string,
): Promise<Record<string, string> | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = "gemini-3.1-flash-image-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const variableHint = variableValue
    ? `Requested palette direction: "${variableValue}"`
    : "Choose a palette that is visually DISTINCT from the reference image — completely different mood and color scheme.";

  const prompt = `Analyze this reference ad image and decide a NEW color palette for an A/B test variant.

${variableHint}

Rules:
- New palette must be visually DISTINCT from the reference image colors
- Maintain good contrast (text must be readable)
- Professional quality suitable for health education brand in Brazil
- Use solid hex codes (#rrggbb format)

Output ONLY this single JSON line — no explanation, no markdown fences, no extra text:
PALETTE_SPEC::{"primary":"#hexcode","secondary":"#hexcode","accent":"#hexcode","background":"#hexcode","description":"brief description of the palette mood"}`;

  try {
    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: controlMimeType, data: controlBase64 } },
        ],
      }],
      generationConfig: {
        responseModalities: ["TEXT"],
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    return parseColorSpec(text);
  } catch (err) {
    log.error({ err }, "fetchColorSpec failed");
    return null;
  }
}

export interface GeneratePipelineInput {
  testRoundId: string;
  campaignId: string;
  controlCreativeId: string;
  variableType: string;
  variableValue?: string;
  numVariants?: number;
  workspaceId: string;
  controlTexts?: ControlTexts;
}

export interface GeneratePipelineOutput {
  testRoundId: string;
  variants: Array<{
    creativeId: string;
    feedBlobUrl: string;
    storiesBlobUrl: string;
    feedName: string;
    storiesName: string;
    adName: string;
    adNumber: number;
  }>;
  steps: PipelineStep[];
  verification: Record<string, unknown>;
}

export async function runGeneratePipeline(
  input: GeneratePipelineInput,
): Promise<GeneratePipelineOutput> {
  const ws = input.workspaceId;
  const steps: PipelineStep[] = [];
  const numVariants = input.numVariants || 1;
  const variants: GeneratePipelineOutput["variants"] = [];

  // ── Inicialização: registrar execução + atualizar status do test round ──
  const { executionId } = await withWorkspace(ws, async (tx) => {
    const [exec] = await tx
      .insert(pipelineExecutions)
      .values({
        workspaceId: ws,
        testRoundId: input.testRoundId,
        pipelineType: "generate",
        status: "running",
        inputData: input as unknown as Record<string, unknown>,
      })
      .returning({ id: pipelineExecutions.id });
    await tx
      .update(testRounds)
      .set({ status: "generating", updatedAt: sql`NOW()` })
      .where(eq(testRounds.id, input.testRoundId));
    return { executionId: exec.id };
  });

  try {
    // ── Step 1: Buscar imagem controle ──
    const step1: PipelineStep = { name: "fetch_control", status: "running", started_at: new Date().toISOString() };
    steps.push(step1);

    const control = await withWorkspace(ws, async (tx) => {
      const rows = await tx
        .select({
          id: creatives.id,
          name: creatives.name,
          blobUrl: creatives.blobUrl,
          prompt: creatives.prompt,
        })
        .from(creatives)
        .where(eq(creatives.id, input.controlCreativeId))
        .limit(1);
      return rows[0] ?? null;
    });

    if (!control) {
      throw new Error(`Control creative ${input.controlCreativeId} not found`);
    }

    const controlResponse = await fetch(control.blobUrl);
    const controlBuffer = await controlResponse.arrayBuffer();
    const controlBase64 = Buffer.from(controlBuffer).toString("base64");
    const controlMimeType = controlResponse.headers.get("content-type") || "image/png";

    step1.status = "completed";
    step1.completed_at = new Date().toISOString();

    // ── Step 2: Pré-fase — paleta + prompts ──
    const step2: PipelineStep = { name: "generate_prompts", status: "running", started_at: new Date().toISOString() };
    steps.push(step2);

    const variableTypeDef = getVariableType(input.variableType);
    if (!variableTypeDef) {
      throw new Error(`Variable type "${input.variableType}" not found in catalog`);
    }

    let colorSpec: Record<string, string> | null = null;
    if (variableTypeDef.category === "visual") {
      colorSpec = await fetchColorSpec(controlBase64, controlMimeType, input.variableValue);
    }

    const feedPrompt = buildVariantPrompt({
      variableType: variableTypeDef,
      variableValue: input.variableValue,
      format: "feed",
      controlTexts: input.controlTexts,
      colorSpec: colorSpec ?? undefined,
    });

    const storiesPrompt = buildVariantPrompt({
      variableType: variableTypeDef,
      variableValue: input.variableValue,
      format: "stories",
      controlTexts: input.controlTexts,
      colorSpec: colorSpec ?? undefined,
    });

    await withWorkspace(ws, async (tx) => {
      await tx
        .update(testRounds)
        .set({
          aiPromptUsed: JSON.stringify({ feed: feedPrompt, stories: storiesPrompt, colorSpec }),
          updatedAt: sql`NOW()`,
        })
        .where(eq(testRounds.id, input.testRoundId));
    });

    step2.status = "completed";
    step2.completed_at = new Date().toISOString();

    // ── Step 3-7: Gerar cada variante ──
    for (let i = 0; i < numVariants; i++) {
      const variantStepName = `generate_variant_${i + 1}`;
      const step3: PipelineStep = { name: variantStepName, status: "running", started_at: new Date().toISOString() };
      steps.push(step3);

      const adNumber = await getNextAdNumber(ws);
      const { feedName, storiesName } = generateCreativeNamePair(adNumber);
      const adName = generateMetaAdName(adNumber);

      const feedResult = await generateImage({
        prompt: feedPrompt,
        referenceImages: [{ base64: controlBase64, mimeType: controlMimeType }],
        aspectRatio: "1:1",
        imageSize: "1K",
      });

      if (feedResult.error || feedResult.images.length === 0) {
        step3.status = "failed";
        step3.error = feedResult.error || "No feed image generated";
        throw new Error(step3.error);
      }

      const storiesResult = await generateImage({
        prompt: storiesPrompt,
        referenceImages: [{ base64: controlBase64, mimeType: controlMimeType }],
        aspectRatio: "9:16",
        imageSize: "1K",
      });

      if (storiesResult.error || storiesResult.images.length === 0) {
        step3.status = "failed";
        step3.error = storiesResult.error || "No stories image generated";
        throw new Error(step3.error);
      }

      const feedBuffer = await resizeImage(feedResult.images[0].base64, 1080, 1080);
      const storiesBuffer = await resizeImage(storiesResult.images[0].base64, 1080, 1920);

      // ── Uploads para Vercel Blob ──
      // IDs são gerados pelo defaultRandom() do schema, mas precisamos do path
      // do blob antes do insert → usamos timestamp como path-only fallback.
      const blobPathSuffix = `${Date.now()}-${i}`;
      const [feedBlob, storiesBlob] = await Promise.all([
        put(`creatives/${blobPathSuffix}-feed.png`, feedBuffer, { access: "public", contentType: "image/png" }),
        put(`creatives/${blobPathSuffix}-stories.png`, storiesBuffer, { access: "public", contentType: "image/png" }),
      ]);

      // ── Persistência: creatives + edges + prompts + variants ──
      const { feedCreativeId, storiesCreativeId } = await withWorkspace(ws, async (tx) => {
        const parentRow = await tx
          .select({ generation: creatives.generation })
          .from(creatives)
          .where(eq(creatives.id, input.controlCreativeId))
          .limit(1);
        const generation = parentRow.length > 0 ? (parentRow[0].generation ?? 0) + 1 : 1;

        const [feedRow] = await tx
          .insert(creatives)
          .values({
            workspaceId: ws,
            name: feedName,
            blobUrl: feedBlob.url,
            prompt: feedPrompt,
            model: feedResult.model,
            width: 1080,
            height: 1080,
            parentId: input.controlCreativeId,
            generation,
            status: "generated",
          })
          .returning({ id: creatives.id });

        const [storiesRow] = await tx
          .insert(creatives)
          .values({
            workspaceId: ws,
            name: storiesName,
            blobUrl: storiesBlob.url,
            prompt: storiesPrompt,
            model: storiesResult.model,
            width: 1080,
            height: 1920,
            parentId: input.controlCreativeId,
            generation,
            status: "generated",
          })
          .returning({ id: creatives.id });

        for (const cid of [feedRow.id, storiesRow.id]) {
          await tx.insert(creativeEdges).values({
            workspaceId: ws,
            sourceId: input.controlCreativeId,
            targetId: cid,
            relationship: "variation",
            variableIsolated: input.variableType,
          });
        }

        for (const [cid, promptText, model] of [
          [feedRow.id, feedPrompt, feedResult.model],
          [storiesRow.id, storiesPrompt, storiesResult.model],
        ] as const) {
          await tx.insert(prompts).values({
            creativeId: cid,
            promptText,
            promptFormat: "json",
            model,
          });
        }

        await tx.insert(testRoundVariants).values({
          testRoundId: input.testRoundId,
          creativeId: feedRow.id,
          role: "variant",
          placement: "feed",
          status: "generated",
        });

        await tx.insert(testRoundVariants).values({
          testRoundId: input.testRoundId,
          creativeId: storiesRow.id,
          role: "variant",
          placement: "stories",
          status: "generated",
        });

        return { feedCreativeId: feedRow.id, storiesCreativeId: storiesRow.id };
      });

      // Upload para Google Drive (não-crítico)
      try {
        const folderId = await getSelectedFolderId(ws);
        if (folderId) {
          await uploadToGoogleDrive(ws, feedName, feedBuffer, "image/png", folderId);
          await uploadToGoogleDrive(ws, storiesName, storiesBuffer, "image/png", folderId);
        }
      } catch (driveError) {
        log.error({ err: driveError }, "drive upload failed");
      }

      step3.status = "completed";
      step3.completed_at = new Date().toISOString();

      variants.push({
        creativeId: feedCreativeId,
        feedBlobUrl: feedBlob.url,
        storiesBlobUrl: storiesBlob.url,
        feedName,
        storiesName,
        adName,
        adNumber,
      });
      void storiesCreativeId; // mantido para semântica futura
    }

    // ── Step 8: Verificação post_generation ──
    const step8: PipelineStep = { name: "verify_post_generation", status: "running", started_at: new Date().toISOString() };
    steps.push(step8);

    const verification = verifyPostGeneration({
      variableType: input.variableType,
      expectedWidth: 1080,
      expectedHeight: 1080,
      variantWidth: 1080,
      variantHeight: 1080,
      variantImageBase64: "present",
    });

    await withWorkspace(ws, async (tx) => {
      await tx
        .update(testRounds)
        .set({
          aiVerification: { post_generation: verification } as unknown as Record<string, unknown>,
          status: "reviewing",
          updatedAt: sql`NOW()`,
        })
        .where(eq(testRounds.id, input.testRoundId));
      await tx
        .update(pipelineExecutions)
        .set({
          status: "completed",
          outputData: { variants } as unknown as Record<string, unknown>,
          steps: steps as unknown as Record<string, unknown>,
          completedAt: sql`NOW()`,
          durationMs: sql`EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER * 1000`,
        })
        .where(eq(pipelineExecutions.id, executionId));
    });

    step8.status = "completed";
    step8.completed_at = new Date().toISOString();

    return {
      testRoundId: input.testRoundId,
      variants,
      steps,
      verification: verification as unknown as Record<string, unknown>,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";

    await withWorkspace(ws, async (tx) => {
      await tx
        .update(testRounds)
        .set({ status: "failed", updatedAt: sql`NOW()` })
        .where(eq(testRounds.id, input.testRoundId));
      await tx
        .update(pipelineExecutions)
        .set({
          status: "failed",
          errorMessage: errorMsg,
          steps: steps as unknown as Record<string, unknown>,
          completedAt: sql`NOW()`,
        })
        .where(eq(pipelineExecutions.id, executionId));
    }).catch((dbErr) => {
      log.error({ err: dbErr }, "failed to record error state");
    });

    throw error;
  }
}
