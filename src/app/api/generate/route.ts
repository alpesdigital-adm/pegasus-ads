import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { generateImage } from "@/lib/gemini";
import { put } from "@vercel/blob";
import { v4 as uuid } from "uuid";

export const maxDuration = 60;
import type { GenerateRequest } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const body: GenerateRequest = await request.json();

    if (!body.prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const db = await initDb();

    // Fetch reference images if provided
    const referenceImages: { base64: string; mimeType: string }[] = [];
    if (body.reference_image_ids?.length) {
      const placeholders = body.reference_image_ids.map(() => "?").join(",");
      const refs = await db.execute({
        sql: `SELECT blob_url FROM images WHERE id IN (${placeholders})`,
        args: body.reference_image_ids,
      });

      for (const row of refs.rows) {
        const blobUrl = row.blob_url as string;
        const imgResponse = await fetch(blobUrl);
        const buffer = await imgResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const mimeType = imgResponse.headers.get("content-type") || "image/png";
        referenceImages.push({ base64, mimeType });
      }
    }

    // If parent creative provided, also include it as reference
    if (body.parent_creative_id) {
      const parent = await db.execute({
        sql: "SELECT blob_url FROM creatives WHERE id = ?",
        args: [body.parent_creative_id],
      });
      if (parent.rows.length > 0) {
        const blobUrl = parent.rows[0].blob_url as string;
        const imgResponse = await fetch(blobUrl);
        const buffer = await imgResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const mimeType = imgResponse.headers.get("content-type") || "image/png";
        referenceImages.unshift({ base64, mimeType });
      }
    }

    // Call Gemini API
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
        { status: 500 }
      );
    }

    // Store generated image in Vercel Blob
    const generatedImage = result.images[0];
    const ext = generatedImage.mimeType.includes("png") ? "png" : "jpg";
    const creativeId = uuid();
    const creativeName = body.name || `creative-${Date.now()}`;

    const imageBuffer = Buffer.from(generatedImage.base64, "base64");

    const blob = await put(`creatives/${creativeId}.${ext}`, imageBuffer, {
      access: "public",
      contentType: generatedImage.mimeType,
    });

    // Determine generation number
    let generation = 0;
    if (body.parent_creative_id) {
      const parentRow = await db.execute({
        sql: "SELECT generation FROM creatives WHERE id = ?",
        args: [body.parent_creative_id],
      });
      if (parentRow.rows.length > 0) {
        generation = (parentRow.rows[0].generation as number) + 1;
      }
    }

    // Save creative to DB
    await db.execute({
      sql: `INSERT INTO creatives (id, name, blob_url, prompt, prompt_json, model, parent_id, generation, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated')`,
      args: [
        creativeId,
        creativeName,
        blob.url,
        body.prompt,
        body.prompt_format === "json" ? body.prompt : null,
        result.model,
        body.parent_creative_id || null,
        generation,
      ],
    });

    // Save prompt history
    const promptId = uuid();
    await db.execute({
      sql: `INSERT INTO prompts (id, creative_id, prompt_text, prompt_format, model, reference_image_ids, response_raw)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        promptId,
        creativeId,
        body.prompt,
        body.prompt_format || "text",
        result.model,
        JSON.stringify(body.reference_image_ids || []),
        result.text || null,
      ],
    });

    // Create edge if parent exists
    const edges = [];
    if (body.parent_creative_id) {
      const edgeId = uuid();
      await db.execute({
        sql: `INSERT INTO creative_edges (id, source_id, target_id, relationship, variable_isolated)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          edgeId,
          body.parent_creative_id,
          creativeId,
          body.relationship || "variation",
          body.variable_isolated || null,
        ],
      });
      edges.push({
        id: edgeId,
        source_id: body.parent_creative_id,
        target_id: creativeId,
        relationship: body.relationship || "variation",
        variable_isolated: body.variable_isolated,
      });
    }

    // Save reference image associations
    if (body.reference_image_ids?.length) {
      for (const imgId of body.reference_image_ids) {
        await db.execute({
          sql: `INSERT INTO creative_ref_images (id, creative_id, image_id, role)
                VALUES (?, ?, ?, 'reference')`,
          args: [uuid(), creativeId, imgId],
        });
      }
    }

    const creative = {
      id: creativeId,
      name: creativeName,
      blob_url: blob.url,
      prompt: body.prompt,
      model: result.model,
      parent_id: body.parent_creative_id || null,
      generation,
      status: "generated",
      created_at: new Date().toISOString(),
    };

    return NextResponse.json({ creative, edges }, { status: 201 });
  } catch (error) {
    console.error("Generate error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
