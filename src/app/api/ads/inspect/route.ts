/**
 * GET /api/ads/inspect?ad_id=123
 *
 * Retorna o creative completo de um ad (object_story_spec, branded_content, etc.)
 * para diagnóstico. Protegido por x-api-key.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";

export const runtime = "nodejs";

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const adId = req.nextUrl.searchParams.get("ad_id");
  const adsetId = req.nextUrl.searchParams.get("adset_id");

  if (!adId && !adsetId) {
    return NextResponse.json({ error: "ad_id or adset_id is required" }, { status: 400 });
  }

  const token = await getTokenForWorkspace(auth.workspace_id);

  if (adsetId) {
    // Inspect ad set: targeting, budget, optimization, attribution
    const adsetFields = [
      "id", "name", "status", "effective_status",
      "daily_budget", "lifetime_budget", "budget_remaining",
      "bid_strategy", "bid_amount", "billing_event",
      "optimization_goal", "optimization_sub_event",
      "targeting", "promoted_object", "attribution_spec",
      "start_time", "end_time", "pacing_type",
      "destination_type", "is_dynamic_creative",
    ].join(",");

    const resp = await fetch(
      `${META_BASE_URL}/${adsetId}?fields=${adsetFields}&access_token=${token}`
    );
    const data = await resp.json();
    return NextResponse.json(data);
  }

  const fields = [
    "name",
    "status",
    "campaign_id",
    "adset_id",
    "effective_status",
    "creative{id,name,object_story_spec,asset_feed_spec,url_tags,instagram_branded_content,branded_content}",
  ].join(",");

  const resp = await fetch(
    `${META_BASE_URL}/${adId}?fields=${fields}&access_token=${token}`
  );
  const data = await resp.json();

  return NextResponse.json(data);
}
