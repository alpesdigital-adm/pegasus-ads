/**
 * POST /api/generate/verify-ocr
 *
 * Verificação pós-geração com OCR via Gemini Vision (tarefa 1.8).
 *
 * MIGRADO NA FASE 1C (Wave 7):
 *  - getDb() → withWorkspace (RLS escopa creatives)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { creatives } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { verifyOcr } from "@/lib/ai-verify";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_CONTROL_TEXTS: Record<string, string[]> = {
  T7_0003_RAT: ["GRÁTIS", "MÉDICOS", "E-BOOK"],
  T4: ["GRÁTIS", "MÉDICOS", "MINOXIDIL"],
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();

    let imageBase64 = body.image_base64 as string | undefined;
    let mimeType: "image/png" | "image/jpeg" = body.mime_type ?? "image/png";
    let creativeName: string | undefined;
    let creativeId: string | undefined;

    if (body.creative_id && !imageBase64) {
      creativeId = body.creative_id as string;
      const rows = await withWorkspace(auth.workspace_id, async (tx) =>
        tx
          .select({ name: creatives.name, blobUrl: creatives.blobUrl })
          .from(creatives)
          .where(eq(creatives.id, creativeId!))
          .limit(1),
      );

      if (rows.length === 0) {
        return NextResponse.json({ error: "Creative não encontrado" }, { status: 404 });
      }

      creativeName = rows[0].name;
      const blobUrl = rows[0].blobUrl;

      const imgRes = await fetch(blobUrl);
      if (!imgRes.ok) {
        return NextResponse.json(
          { error: `Falha ao baixar imagem: ${imgRes.status}` },
          { status: 502 },
        );
      }

      const contentType = imgRes.headers.get("content-type") || "image/png";
      mimeType = contentType.includes("jpeg") || contentType.includes("jpg") ? "image/jpeg" : "image/png";

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      imageBase64 = buffer.toString("base64");
    }

    if (!imageBase64) {
      return NextResponse.json(
        { error: "creative_id ou image_base64 é obrigatório" },
        { status: 400 },
      );
    }

    let expectedPhrases: string[] = body.expected_phrases ?? [];
    if (expectedPhrases.length === 0 && body.campaign_key) {
      expectedPhrases = DEFAULT_CONTROL_TEXTS[body.campaign_key as string] ?? [];
    }

    const ocr = await verifyOcr(imageBase64, expectedPhrases, mimeType);

    return NextResponse.json({
      ...(creativeId && { creative_id: creativeId }),
      ...(creativeName && { creative_name: creativeName }),
      ocr,
    });
  } catch (err) {
    console.error("[VerifyOcr]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
