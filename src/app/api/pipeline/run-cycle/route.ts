/**
 * POST /api/pipeline/run-cycle
 *
 * Orquestrador end-to-end do ciclo Pegasus Ads (tarefa 3.4).
 * Encadeia internamente:
 *   1. collect    — coleta métricas da Meta + avalia kill rules
 *   2. hypotheses — gera hipóteses de teste com IA
 *
 * Retorna sumário consolidado de todas as etapas.
 *
 * Body (opcional):
 * {
 *   campaign_key?: string   (default: T7_0003_RAT)
 *   top_n?: number          (criativos analisados para hipóteses, default 10)
 *   skip_collect?: boolean  (pula coleta — útil para re-rodar só hipóteses)
 *   skip_hypotheses?: boolean
 * }
 *
 * Proteção: x-api-key = TEST_LOG_API_KEY
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  return !!process.env.TEST_LOG_API_KEY && key === process.env.TEST_LOG_API_KEY;
}

/** Chama um endpoint interno com x-api-key */
async function callInternal(
  path: string,
  method: "GET" | "POST",
  body?: object
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const apiKey = process.env.TEST_LOG_API_KEY ?? "";
  const cronSecret = process.env.CRON_SECRET ?? "";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "Authorization": `Bearer ${cronSecret}`,
  };

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 500, data: { error: String(err) } };
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const startedAt = new Date().toISOString();
  const body = await req.json().catch(() => ({}));
  const campaignKey = (body.campaign_key as string) ?? "T7_0003_RAT";
  const topN = (body.top_n as number) ?? 10;
  const skipCollect = body.skip_collect === true;
  const skipHypotheses = body.skip_hypotheses === true;

  const steps: Record<string, unknown> = {};
  const errors: string[] = [];

  // ── Etapa 1: Coletar métricas + kill rules ──
  if (!skipCollect) {
    const collectResult = await callInternal("/api/cron/collect", "GET");
    steps.collect = {
      ok: collectResult.ok,
      status: collectResult.status,
      summary: collectResult.data,
    };
    if (!collectResult.ok) {
      errors.push(`collect failed (HTTP ${collectResult.status})`);
    }
  } else {
    steps.collect = { skipped: true };
  }

  // ── Etapa 2: Gerar hipóteses com IA ──
  if (!skipHypotheses) {
    const hypResult = await callInternal("/api/hypotheses/generate", "POST", {
      campaign_key: campaignKey,
      top_n: topN,
    });
    steps.hypotheses = {
      ok: hypResult.ok,
      status: hypResult.status,
      summary: hypResult.data,
    };
    if (!hypResult.ok) {
      errors.push(`hypotheses failed (HTTP ${hypResult.status})`);
    }
  } else {
    steps.hypotheses = { skipped: true };
  }

  const finishedAt = new Date().toISOString();
  const durationMs =
    new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  // ── Extrair métricas consolidadas ──
  const collectData = steps.collect as Record<string, unknown> | undefined;
  const hypData = steps.hypotheses as Record<string, unknown> | undefined;

  const collectSummary = collectData?.summary as Record<string, unknown> | undefined;
  const hypSummary = hypData?.summary as Record<string, unknown> | undefined;

  return NextResponse.json({
    ok: errors.length === 0,
    campaign_key: campaignKey,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    errors: errors.length > 0 ? errors : undefined,

    summary: {
      metrics_collected: collectSummary?.upserted ?? null,
      kills_triggered: collectSummary?.kills_triggered ?? null,
      alerts_created: collectSummary?.alerts_created ?? null,
      hypotheses_generated: Array.isArray((hypSummary as Record<string, unknown> | undefined)?.hypotheses)
        ? ((hypSummary as Record<string, unknown>).hypotheses as unknown[]).length
        : null,
      hypotheses_source: (hypSummary as Record<string, unknown> | undefined)?.source ?? null,
    },

    steps,
  });
}
