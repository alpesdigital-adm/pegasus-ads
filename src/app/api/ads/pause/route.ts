/**
 * POST /api/ads/pause
 * Body: { ad_ids: string[], reason?: string }
 *
 * Pausa ads via Meta API (status → PAUSED).
 * Protegido por API key simples (header x-api-key).
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const META_API = "https://graph.facebook.com/v25.0";

function getToken(): string {
  const t = process.env.META_SYSTEM_USER_TOKEN;
  if (!t) throw new Error("META_SYSTEM_USER_TOKEN not set");
  return t;
}

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  const expected = process.env.TEST_LOG_API_KEY;
  if (!expected) return false;
  return key === expected;
}

interface PauseResult {
  ad_id: string;
  success: boolean;
  error?: string;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const adIds: string[] = body.ad_ids;
    const reason: string = body.reason || "kill_rule";

    if (!adIds || !Array.isArray(adIds) || adIds.length === 0) {
      return NextResponse.json({ error: "ad_ids array required" }, { status: 400 });
    }

    if (adIds.length > 50) {
      return NextResponse.json({ error: "Max 50 ads per request" }, { status: 400 });
    }

    const token = getToken();
    const results: PauseResult[] = [];

    // Pausar cada ad via POST /{ad_id}?status=PAUSED
    for (const adId of adIds) {
      try {
        const url = `${META_API}/${adId}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            status: "PAUSED",
            access_token: token,
          }),
        });

        if (res.ok) {
          results.push({ ad_id: adId, success: true });
        } else {
          const err = await res.json();
          results.push({ ad_id: adId, success: false, error: JSON.stringify(err) });
        }
      } catch (err) {
        results.push({ ad_id: adId, success: false, error: String(err) });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`[AdsPause] reason=${reason} total=${adIds.length} ok=${succeeded} fail=${failed}`);

    return NextResponse.json({
      reason,
      total: adIds.length,
      succeeded,
      failed,
      results,
    });
  } catch (err) {
    console.error("[AdsPause]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
