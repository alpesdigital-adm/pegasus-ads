/**
 * POST /api/videos/upload-temp
 *
 * G7: Upload de vídeo para pasta temporária na VPS.
 * Retorna URL pública acessível pela Meta API.
 * Após o Pegasus publicar o ad, o arquivo é deletado automaticamente.
 *
 * Body: multipart/form-data
 *   - file: arquivo MP4
 *   - name: nome do arquivo (ex: T4EBANP-AD09VD.mp4)
 *
 * Resposta:
 * {
 *   "url": "https://pegasus.alpesd.com.br/api/videos/temp/abc123.mp4",
 *   "filename": "abc123.mp4",
 *   "size": 12345678,
 *   "expires_in_seconds": 3600
 * }
 *
 * Protegido por x-api-key (api_keys table) ou cookie Supabase session.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

export const runtime = "nodejs";
export const maxDuration = 120;

const TEMP_DIR = "/tmp/pegasus-videos";
const TEMP_URL_BASE = process.env.NEXT_PUBLIC_APP_URL || "https://pegasus.alpesd.com.br";
const EXPIRES_SECONDS = 3600; // 1 hora

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    // Garantir que o diretório temporário existe
    await mkdir(TEMP_DIR, { recursive: true });

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "file is required (multipart/form-data with 'file' field)" },
        { status: 400 }
      );
    }
    const file = formData.get("file") as File | null;
    const name = (formData.get("name") as string | null) || "";

    if (!file) {
      return NextResponse.json({ error: "file is required (multipart/form-data)" }, { status: 400 });
    }

    // Gerar nome único para evitar colisões
    const ext = name.split(".").pop() || "mp4";
    const uniqueId = randomBytes(8).toString("hex");
    const filename = `${uniqueId}.${ext}`;
    const filepath = join(TEMP_DIR, filename);

    // Salvar arquivo
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filepath, buffer);

    const url = `${TEMP_URL_BASE}/api/videos/temp/${filename}`;
    console.log(`[VideoUploadTemp] Saved ${name} → ${filepath} (${buffer.length} bytes) | URL: ${url}`);

    // Agendar deleção automática após EXPIRES_SECONDS
    setTimeout(async () => {
      try {
        const { unlink } = await import("fs/promises");
        await unlink(filepath);
        console.log(`[VideoUploadTemp] Auto-deleted ${filepath}`);
      } catch (e) {
        console.warn(`[VideoUploadTemp] Auto-delete failed for ${filepath}:`, e);
      }
    }, EXPIRES_SECONDS * 1000);

    return NextResponse.json({
      url,
      filename,
      original_name: name,
      size: buffer.length,
      expires_in_seconds: EXPIRES_SECONDS,
    });
  } catch (err) {
    console.error("[VideoUploadTemp]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
