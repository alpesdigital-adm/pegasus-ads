/**
 * POST /api/adsets/pause
 *
 * Pausa um ou mais ad sets.
 *
 * Body (JSON):
 * {
 *   "adset_ids": ["120242521315670521", "..."]
 * }
 *
 * Protegido por x-api-key.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 60;

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 400) await new Promise((r) => setTimeout(r, 400 - diff));
  lastCall = Date.now();
}

async function metaFetch<T>(url: string, options?: RequestInit, retries = 3): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(30000, 3000 * Math.pow(2, attempt - 1));
      await new Promise((r) => setTimeout(r, wait));
    }
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok || (data as Record<string, unknown>).error) {
      const err = (data as Record<string, unknown>).error as Record<string, unknown> | undefined;
      if (err && Number(err.code) === 17 && attempt < retries) {
        lastErr = new Error(`Rate limit: ${JSON.stringify(err)}`);
        continue;
      }
      throw new Error(`Meta API error: ${JSON.stringify(err)}`);
    }
    return data as T;
  }
  throw lastErr ?? new Error("metaFetch failed after retries");
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { adset_ids } = body as { adset_ids: string[] };

    if (!adset_ids || adset_ids.length === 0) {
      return NextResponse.json({ error: "adset_ids[] is required" }, { status: 400 });
    }

    const token = await getTokenForWorkspace(auth.workspace_id);
    const results: Array<{ adset_id: string; success: boolean; error?: string }> = [];

    for (const adsetId of adset_ids) {
      await rateLimit();
      try {
        await metaFetch(
          `${META_BASE_URL}/${adsetId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody({ status: "PAUSED", access_token: token }),
          }
        );
        results.push({ adset_id: adsetId, success: true });
        console.log(`[AdsetsPause] Paused adset ${adsetId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ adset_id: adsetId, success: false, error: msg });
        console.error(`[AdsetsPause] FAILED ${adsetId}:`, msg);
      }
    }

    const successful = results.filter((r) => r.success).length;
    return NextResponse.json({
      total: adset_ids.length,
      successful,
      failed: adset_ids.length - successful,
      results,
    });
  } catch (err) {
    console.error("[AdsetsPause]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
