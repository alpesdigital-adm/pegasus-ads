/**
 * GET /api/videos/temp/[filename]
 *
 * G7: Serve arquivos de vídeo temporários armazenados em /tmp/pegasus-videos/.
 * A Meta API acessa esta URL para baixar o vídeo durante o upload.
 *
 * NÃO requer autenticação — precisa ser pública para a Meta acessar.
 * A segurança é garantida pelos nomes de arquivo aleatórios (hex 8 bytes).
 *
 * Fase 2 PR 2c+TD-013: DELETE handler removido (usava TEST_LOG_API_KEY
 * legado, chamado pelo Apps Script que não existe mais). Cleanup de
 * arquivos temp fica por conta do TTL natural do /tmp do container
 * (restart mensal da VPS limpa) ou manual via docker exec.
 */
import { NextRequest, NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";
import { join } from "path";
import { Readable } from "stream";

export const runtime = "nodejs";
export const maxDuration = 60;

const TEMP_DIR = "/tmp/pegasus-videos";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  // Sanitize: apenas caracteres seguros (hex + extensão)
  if (!/^[a-f0-9]{16}\.(mp4|mov|avi|mkv)$/.test(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const filepath = join(TEMP_DIR, filename);

  try {
    const stat = statSync(filepath);
    const fileSize = stat.size;

    const stream = createReadStream(filepath);
    const readable = Readable.toWeb(stream) as ReadableStream;

    return new NextResponse(readable, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(fileSize),
        "Cache-Control": "no-cache, no-store",
        "Accept-Ranges": "bytes",
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found or expired" }, { status: 404 });
  }
}

