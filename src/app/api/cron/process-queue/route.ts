/**
 * POST /api/cron/process-queue — worker HTTP entry point da Staging Queue v2.
 *
 * Invocado pelo cron externo a cada 60s. Auth via Bearer CRON_SECRET
 * (mesmo pattern de /api/cron/sync-all). Retorna JSON com o status
 * do tick (idle|processed|evaluated|paused|cancelled|error) + telemetria.
 *
 * Paralelismo: múltiplas invocações simultâneas são seguras — SKIP LOCKED
 * garante que cada worker pegue um batch distinto. Para escalar basta
 * reduzir o intervalo do cron ou cunhar múltiplos invocadores.
 *
 * Spec: docs/staging-queue-v2.md §7.1.
 */
import { NextRequest, NextResponse } from "next/server";
import { processQueueTick } from "@/lib/staging-queue/worker";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

const log = logger.child({ route: "/api/cron/process-queue" });

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // dev: sem secret, aberto
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${cronSecret}`;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const result = await processQueueTick();
    log.info(
      { ...result, durationMs: Date.now() - startedAt },
      "tick completed",
    );
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ error: msg }, "tick threw");
    return NextResponse.json(
      { status: "error", error: msg },
      { status: 500 },
    );
  }
}
