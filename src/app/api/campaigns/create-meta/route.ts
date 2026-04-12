/**
 * POST /api/campaigns/create-meta
 *
 * Cria uma campanha no Meta Ads e opcionalmente registra no banco local.
 *
 * Body (JSON):
 * {
 *   "account_id": "act_3601611403432716",
 *   "name": "T7__0008__CAP__LP__EB",
 *   "objective": "OUTCOME_LEADS",        // opcional, default OUTCOME_LEADS
 *   "status": "PAUSED",                  // opcional, default PAUSED
 *   "special_ad_categories": [],          // opcional, default []
 *   "buying_type": "AUCTION"             // opcional, default AUCTION
 * }
 *
 * Retorna:
 * {
 *   "campaign_id": "120242...",
 *   "name": "T7__0008__CAP__LP__EB",
 *   "status": "PAUSED"
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";

export const runtime = "nodejs";

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const {
      account_id,
      name,
      objective = "OUTCOME_LEADS",
      status = "PAUSED",
      special_ad_categories = [],
      buying_type = "AUCTION",
    } = body as {
      account_id: string;
      name: string;
      objective?: string;
      status?: string;
      special_ad_categories?: string[];
      buying_type?: string;
    };

    if (!account_id || !name) {
      return NextResponse.json(
        { error: "account_id and name are required" },
        { status: 400 }
      );
    }

    const token = await getTokenForWorkspace(auth.workspace_id);

    // Create campaign on Meta
    const params = new URLSearchParams({
      name,
      objective,
      status,
      buying_type,
      special_ad_categories: JSON.stringify(special_ad_categories),
      access_token: token,
    });

    const resp = await fetch(`${META_BASE_URL}/${account_id}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await resp.json();

    if (!resp.ok || data.error) {
      console.error("[CreateMetaCampaign] Meta API error:", JSON.stringify(data.error));
      return NextResponse.json(
        { error: data.error?.message || "Failed to create campaign on Meta", detail: data.error },
        { status: 500 }
      );
    }

    console.log(`[CreateMetaCampaign] Created: ${data.id} (${name})`);

    return NextResponse.json({
      campaign_id: data.id,
      name,
      objective,
      status,
    });
  } catch (err) {
    console.error("[CreateMetaCampaign]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
