/**
 * Duplicate validated ads into ad sets by reusing existing creative_ids.
 *
 * GET /api/ads/duplicate-creative?campaign_id=XXX
 *   → Lists all ad sets in the campaign with their current ad count
 *     (including empty ones that insights/live doesn't show).
 *
 * POST /api/ads/duplicate-creative
 *   Body: {
 *     target_campaign_id: string,
 *     source_ad_ids: string[],          // ads whose creative will be reused
 *     target_adset_ids?: string[],      // explicit list (overrides only_empty)
 *     only_empty_adsets?: boolean,      // default true — only populate empty ad sets
 *     dry_run?: boolean                 // default false — report what would be done
 *   }
 *
 * Reutiliza o creative_id existente em vez de criar um novo — preserva
 * learning da Meta e variações Advantage+ IA. O ad criado herda o mesmo
 * nome do ad de origem.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 300;

const META_API = "https://graph.facebook.com/v25.0";

// ── rate limit ──
let lastCall = 0;
async function rateLimit() {
  const diff = Date.now() - lastCall;
  if (diff < 400) await new Promise((r) => setTimeout(r, 400 - diff));
  lastCall = Date.now();
}

async function metaFetch<T>(url: string, init?: RequestInit): Promise<T> {
  await rateLimit();
  const r = await fetch(url, init);
  const data = await r.json();
  if (!r.ok || (data as Record<string, unknown>).error) {
    throw new Error(`Meta error: ${JSON.stringify((data as Record<string, unknown>).error || data)}`);
  }
  return data as T;
}

interface AdSetMeta {
  id: string;
  name: string;
  status: string;
  effective_status: string;
}

interface AdMetaRaw {
  id: string;
  name: string;
  adset_id: string;
  status: string;
  effective_status: string;
  creative?: { id: string };
}

async function fetchAdSets(campaignId: string, token: string): Promise<AdSetMeta[]> {
  const url = `${META_API}/${campaignId}/adsets?fields=id,name,status,effective_status&limit=100&access_token=${token}`;
  const data = await metaFetch<{ data: AdSetMeta[] }>(url);
  return data.data || [];
}

async function fetchCampaignAds(campaignId: string, token: string): Promise<AdMetaRaw[]> {
  // Include all statuses (active + paused). Exclude deleted/archived.
  const statuses = JSON.stringify(["ACTIVE", "PAUSED"]);
  const url = `${META_API}/${campaignId}/ads?fields=id,name,adset_id,status,effective_status,creative{id}&effective_status=${encodeURIComponent(statuses)}&limit=500&access_token=${token}`;
  const data = await metaFetch<{ data: AdMetaRaw[] }>(url);
  return data.data || [];
}

async function fetchAdDetails(adId: string, token: string): Promise<{ id: string; name: string; account_id: string; creative_id: string }> {
  const url = `${META_API}/${adId}?fields=id,name,account_id,creative{id}&access_token=${token}`;
  const data = await metaFetch<{ id: string; name: string; account_id: string; creative?: { id: string } }>(url);
  return {
    id: data.id,
    name: data.name,
    account_id: data.account_id.startsWith("act_") ? data.account_id : `act_${data.account_id}`,
    creative_id: data.creative?.id || "",
  };
}

async function createAd(params: {
  accountId: string;
  adsetId: string;
  creativeId: string;
  name: string;
  token: string;
}): Promise<{ id: string }> {
  const url = `${META_API}/${params.accountId}/ads`;
  const body = new URLSearchParams({
    name: params.name,
    adset_id: params.adsetId,
    creative: JSON.stringify({ creative_id: params.creativeId }),
    status: "ACTIVE",
    access_token: params.token,
  });
  const data = await metaFetch<{ id: string }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return { id: data.id };
}

// ── GET ──
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const campaignId = req.nextUrl.searchParams.get("campaign_id");
  if (!campaignId) {
    return NextResponse.json({ error: "campaign_id required" }, { status: 400 });
  }

  try {
    const token = await getTokenForWorkspace(auth.workspace_id);
    const [adsets, ads] = await Promise.all([
      fetchAdSets(campaignId, token),
      fetchCampaignAds(campaignId, token),
    ]);

    const adsByAdset = new Map<string, AdMetaRaw[]>();
    for (const a of ads) {
      if (!adsByAdset.has(a.adset_id)) adsByAdset.set(a.adset_id, []);
      adsByAdset.get(a.adset_id)!.push(a);
    }

    const result = adsets.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      effective_status: s.effective_status,
      ads_count: (adsByAdset.get(s.id) || []).length,
      ad_names: (adsByAdset.get(s.id) || []).map((a) => a.name),
    }));

    return NextResponse.json({
      campaign_id: campaignId,
      total_adsets: result.length,
      empty_adsets: result.filter((r) => r.ads_count === 0).length,
      adsets: result,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// ── POST ──
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const {
      target_campaign_id,
      source_ad_ids,
      target_adset_ids,
      only_empty_adsets = true,
      dry_run = false,
    } = body as {
      target_campaign_id: string;
      source_ad_ids: string[];
      target_adset_ids?: string[];
      only_empty_adsets?: boolean;
      dry_run?: boolean;
    };

    if (!target_campaign_id || !Array.isArray(source_ad_ids) || source_ad_ids.length === 0) {
      return NextResponse.json(
        { error: "target_campaign_id and source_ad_ids[] required" },
        { status: 400 }
      );
    }

    const token = await getTokenForWorkspace(auth.workspace_id);

    // 1. Fetch source ad details (name + creative_id + account_id)
    const sourceAds = await Promise.all(source_ad_ids.map((id) => fetchAdDetails(id, token)));
    const missingCreative = sourceAds.filter((a) => !a.creative_id);
    if (missingCreative.length > 0) {
      return NextResponse.json(
        { error: `Source ads missing creative_id: ${missingCreative.map((a) => a.id).join(", ")}` },
        { status: 400 }
      );
    }

    // Determine account — assume all source ads belong to same ad account as target campaign
    const accountId = sourceAds[0].account_id;

    // 2. Determine target adsets
    const allAdsets = await fetchAdSets(target_campaign_id, token);
    let targetAdsets: AdSetMeta[];

    if (Array.isArray(target_adset_ids) && target_adset_ids.length > 0) {
      const idSet = new Set(target_adset_ids);
      targetAdsets = allAdsets.filter((s) => idSet.has(s.id));
    } else if (only_empty_adsets) {
      const campaignAds = await fetchCampaignAds(target_campaign_id, token);
      const nonEmptyIds = new Set(campaignAds.map((a) => a.adset_id));
      targetAdsets = allAdsets.filter((s) => !nonEmptyIds.has(s.id));
    } else {
      targetAdsets = allAdsets;
    }

    if (targetAdsets.length === 0) {
      return NextResponse.json(
        { error: "No target adsets found (all populated or filter mismatch)" },
        { status: 400 }
      );
    }

    const plan = sourceAds.flatMap((src) =>
      targetAdsets.map((adset) => ({
        source_ad_id: src.id,
        source_ad_name: src.name,
        creative_id: src.creative_id,
        target_adset_id: adset.id,
        target_adset_name: adset.name,
      }))
    );

    if (dry_run) {
      return NextResponse.json({
        dry_run: true,
        account_id: accountId,
        target_campaign_id,
        total_operations: plan.length,
        source_ads: sourceAds.map((s) => ({ id: s.id, name: s.name, creative_id: s.creative_id })),
        target_adsets: targetAdsets.map((s) => ({ id: s.id, name: s.name, status: s.status })),
        plan,
      });
    }

    // 3. Execute
    const results: Array<{
      source_ad_id: string;
      source_ad_name: string;
      target_adset_id: string;
      target_adset_name: string;
      new_ad_id?: string;
      error?: string;
    }> = [];

    for (const op of plan) {
      try {
        const created = await createAd({
          accountId,
          adsetId: op.target_adset_id,
          creativeId: op.creative_id,
          name: op.source_ad_name,
          token,
        });
        results.push({ ...op, new_ad_id: created.id });
        console.log(`[DuplicateCreative] ✓ ${op.source_ad_name} → ${op.target_adset_name} (${created.id})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ ...op, error: msg });
        console.error(`[DuplicateCreative] ✗ ${op.source_ad_name} → ${op.target_adset_name}: ${msg}`);
      }
    }

    const succeeded = results.filter((r) => r.new_ad_id).length;
    const failed = results.filter((r) => r.error).length;

    return NextResponse.json({
      dry_run: false,
      target_campaign_id,
      total_operations: plan.length,
      succeeded,
      failed,
      results,
    });
  } catch (err) {
    console.error("[DuplicateCreative]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
