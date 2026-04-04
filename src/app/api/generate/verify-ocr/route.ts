/**
 * POST /api/generate/verify-ocr
 *
 * Verificação pós-geração com OCR via Gemini Vision (tarefa 1.8).
 * Extrai texto do criativo e compara com os textos esperados (controlTexts).
 *
 * Body:
 *   { creative_id: string }              — carrega imagem do DB (blob_url)
 *   OR
 *   { image_base64: string, mime_type?: "image/png" | "image/jpeg" }
 *
 *   expected_phrases?: string[]          — textos obrigatórios (padrão: controlTexts da campanha)
 *   campaign_key?: string                — para inferir controlTexts (opcional)
 *
 * Resposta:
 * {
 *   creative_id?, creative_name?,
 *   ocr: { passed, score, extracted_text, found_phrases, missing_phrases, issues }
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { verifyOcr } from "@/lib/ai-verify";

export const runtime = "nodejs";
export const maxDuration = 60;

// Textos padrão por campanha (fallback quando expected_phrases não enviado)
const DEFAULT_CONTROL_TEXTS: Record<string, string[]> = {
  T7_0003_RAT: ["GRÁTIS", "MÉDICOS", "E-BOOK"],
  T4: ["GRÁTIS", "MÉDICOS", "MINOXIDIL"],
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const body = await req.json();

    let imageBase64 = body.image_base64 as string | undefined;
    let mimeType: "image/png" | "image/jpeg" = body.mime_type ?? "image/png";
    let creativeName: string | undefined;
    let creativeId: string | undefined;

    // ── Carregar imagem do DB por creative_id ──
    if (body.creative_id && !imageBase64) {
      creativeId = body.creative_id as string;
      const res = await db.execute({ sql: "SELECT name, blob_url FROM creatives WHERE id = ? AND workspace_id = ?", args: [creativeId, auth.workspace_id] });
      if (res.rows.length === 0) return NextResponse.json({ error: "Creative não encontrado" }, { status: 404 });

      creativeName = res.rows[0].name as string;
      const blobUrl = res.rows[0].blob_url as string;

      // Baixar imagem do blob URL
      const imgRes = await fetch(blobUrl);
      if (!imgRes.ok) return NextResponse.json({ error: `Falha ao baixar imagem: ${imgRes.status}` }, { status: 502 });

      const contentType = imgRes.headers.get("content-type") || "image/png";
      mimeType = contentType.includes("jpeg") || contentType.includes("jpg") ? "image/jpeg" : "image/png";

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      imageBase64 = buffer.toString("base64");
    }

    if (!imageBase64) {
      return NextResponse.json({ error: "creative_id ou image_base64 é obrigatório" }, { status: 400 });
    }

    // ── Resolver textos esperados ──
    let expectedPhrases: string[] = body.expected_phrases ?? [];
    if (expectedPhrases.length === 0 && body.campaign_key) {
      expectedPhrases = DEFAULT_CONTROL_TEXTS[body.campaign_key as string] ?? [];
    }

    // ── OCR via Gemini Vision ──
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
