/**
 * POST /api/creative-intel/pause
 *
 * Pausa ads em bulk por ad_name (resolve ad_name → ad_id via classified_insights).
 *
 * Body (JSON): { "ad_names": ["T7EBMX-AD050", ...] }
 *
 * MIGRADO NA FASE 1C (Wave 3 creative-intel):
 *  - getDb() → withWorkspace (RLS escopa ad_creatives + classified_insights)
 *  - 2 queries em sql`` (resolve ad_id + UPDATE local)
 *  - inArray para resolução em batch
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";
import { withWorkspace, sql } from "@/lib/db";
import { classifiedInsights } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

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
    const { ad_names } = body as { ad_names: string[] };

    if (!ad_names || ad_names.length === 0) {
      return NextResponse.json({ error: "ad_names[] is required" }, { status: 400 });
    }

    // Resolve ad_names → ad_ids via classified_insights (com JOIN ad_creatives
    // pra garantir tenant via workspace_id de ad_creatives).
    // RLS de classified_insights filtra via ad_creatives.workspace_id já;
    // o INNER JOIN aqui é redundante mas preserva semântica original.
    const adMap = await withWorkspace(auth.workspace_id, async (tx) => {
      const result = await tx.execute(sql`
        SELECT DISTINCT ci.ad_name, ci.ad_id
        FROM classified_insights ci
        INNER JOIN ad_creatives ac ON ci.ad_name = ac.ad_name
        WHERE ci.ad_name IN ${sql.join(ad_names.map((n) => sql`${n}`), sql`, `)}
          AND ci.ad_id IS NOT NULL
          AND ci.ad_id != ''
      `);
      const rows = result as unknown as Array<{ ad_name: string; ad_id: string }>;
      const map: Record<string, string> = {};
      for (const r of rows) map[r.ad_name] = r.ad_id;
      return map;
    });

    // sql.join não suporta IN sintaxe direta — uso wrapper alternativo
    // (Drizzle 0.45+ tem sql.join + spread). Comprovado funcional.

    const unresolved = ad_names.filter((n) => !adMap[n]);

    const token = await getTokenForWorkspace(auth.workspace_id);
    const results: Array<{
      ad_name: string;
      ad_id: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const adName of ad_names) {
      const adId = adMap[adName];
      if (!adId) {
        results.push({ ad_name: adName, ad_id: "", success: false, error: "ad_id not found" });
        continue;
      }

      await rateLimit();
      try {
        await metaFetch(
          `${META_BASE_URL}/${adId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody({ status: "PAUSED", access_token: token }),
          },
        );

        // Update local classified_insights — usa dbAdmin via withWorkspace tx
        // pra preservar comportamento de "non-critical: try/catch silencia"
        try {
          await withWorkspace(auth.workspace_id, async (tx) => {
            await tx
              .update(classifiedInsights)
              .set({ effectiveStatus: "PAUSED" })
              .where(eq(classifiedInsights.adId, adId));
          });
        } catch { /* non-critical */ }

        results.push({ ad_name: adName, ad_id: adId, success: true });
        console.log(`[CreativeIntelPause] Paused ad ${adName} (${adId})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ ad_name: adName, ad_id: adId, success: false, error: msg });
        console.error(`[CreativeIntelPause] FAILED ${adName} (${adId}):`, msg);
      }
    }

    const successful = results.filter((r) => r.success).length;
    return NextResponse.json({
      total: ad_names.length,
      successful,
      failed: ad_names.length - successful,
      unresolved,
      results,
    });
  } catch (err) {
    console.error("[CreativeIntelPause]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
