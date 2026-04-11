/**
 * POST /api/ads/publish-videos
 *
 * Cria um novo ad set (clonando targeting de um ad set existente),
 * sobe vídeos para a Meta via file_url e cria os ads dentro do novo ad set.
 *
 * Body (JSON):
 * {
 *   "source_adset_id": "120242521315670521",
 *   "new_adset_name": "PA__LAL0-1p - VIDEO TEST 9:16",
 *   "daily_budget_cents": 50000,
 *   "model_ad_id": "120242521326410521",    // opcional se page_id+ig_user_id+account_id fornecidos (G9)
 *   "page_id": "...",                        // G9
 *   "instagram_user_id": "...",              // G9
 *   "account_id": "act_...",               // G9
 *   "link": "https://...",                   // G1: override do link do model_ad
 *   "start_paused": false,
 *   "partnership": {                         // G4: branded content para videos
 *     "sponsor_id": "17841400601834755",
 *     "testimonial": "..."
 *   },
 *   "ads": [
 *     {
 *       "name": "T7EBMX-AD026VD",
 *       "video_url": "https://files.catbox.moe/xxx.mp4",
 *       "body": "primary text",
 *       "title": "headline",
 *       "description": "description",
 *       "cta_type": "DOWNLOAD"
 *     }
 *   ]
 * }
 *
 * Protegido por x-api-key.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 300;

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ── G8: metaFetch com retry para rate limit (código 17) ──
async function metaFetch<T>(url: string, options?: RequestInit, retries = 4): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(60000, 5000 * Math.pow(2, attempt - 1));
      console.warn(`[PublishVideos] Rate limit retry ${attempt}/${retries} — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok || (data as Record<string, unknown>).error) {
      const err = (data as Record<string, unknown>).error as Record<string, unknown> | undefined;
      if (err && Number(err.code) === 17 && attempt < retries) {
        lastErr = new Error(`Meta API rate limit (code 17): ${JSON.stringify(err)}`);
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

let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 400) await new Promise((r) => setTimeout(r, 400 - diff));
  lastCall = Date.now();
}

// ── Interfaces ──

interface VideoAdSpec {
  name: string;
  video_url: string;
  body: string;
  title: string;
  description: string;
  cta_type: string;
}

interface PartnershipSpec {
  sponsor_id: string;
  testimonial?: string;
}

interface ModelAdInfo {
  link: string;
  pageId: string;
  instagramUserId: string;
  accountId: string;
  urlTags: string;
  displayLink: string;
}

// ── Helpers ──

async function fetchModelAd(adId: string, token: string): Promise<ModelAdInfo> {
  await rateLimit();
  const adData = await metaFetch<Record<string, unknown>>(
    `${META_BASE_URL}/${adId}?fields=account_id,creative{id,object_story_spec,asset_feed_spec,url_tags}&access_token=${token}`
  );
  const accountId = (adData.account_id as string) || "";
  const creative = adData.creative as Record<string, unknown>;
  let link = "", pageId = "", instagramUserId = "", urlTags = "", displayLink = "";

  const afs = creative?.asset_feed_spec as Record<string, unknown> | undefined;
  if (afs) {
    const linkUrls = afs.link_urls as Array<{ website_url: string; display_url?: string }> | undefined;
    if (linkUrls?.[0]) {
      link = linkUrls[0].website_url;
      if (linkUrls[0].display_url) displayLink = linkUrls[0].display_url;
    }
  }

  const oss = creative?.object_story_spec as Record<string, unknown> | undefined;
  if (oss) {
    pageId = (oss.page_id as string) || "";
    instagramUserId = (oss.instagram_actor_id as string) || (oss.instagram_user_id as string) || "";
    if (!link) {
      const linkData = oss.link_data as Record<string, unknown> | undefined;
      if (linkData) {
        link = (linkData.link as string) || "";
        if (!displayLink) displayLink = (linkData.caption as string) || "";
      }
    }
  }
  urlTags = (creative?.url_tags as string) || "";
  if (!displayLink && link) {
    try { displayLink = new URL(link).hostname; } catch { /* ignore */ }
  }

  return {
    link,
    pageId,
    instagramUserId,
    accountId: accountId.startsWith("act_") ? accountId : `act_${accountId}`,
    urlTags,
    displayLink,
  };
}

async function fetchAdsetCampaignId(adsetId: string, token: string): Promise<string> {
  await rateLimit();
  const data = await metaFetch<{ campaign_id: string }>(
    `${META_BASE_URL}/${adsetId}?fields=campaign_id&access_token=${token}`
  );
  return data.campaign_id;
}

async function copyAdset(sourceAdsetId: string, token: string): Promise<string> {
  await rateLimit();
  const data = await metaFetch<{ copied_adset_id?: string; ad_object_ids?: Array<{ copied_ad_object_id: string }> }>(
    `${META_BASE_URL}/${sourceAdsetId}/copies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ deep_copy: "false", status_option: "PAUSED", access_token: token }),
    }
  );
  const newId = data.copied_adset_id || data.ad_object_ids?.[0]?.copied_ad_object_id || "";
  if (!newId) throw new Error("Adset copy returned no id: " + JSON.stringify(data));
  return newId;
}

async function updateAdset(adsetId: string, params: Record<string, string>, token: string): Promise<void> {
  await rateLimit();
  await metaFetch(
    `${META_BASE_URL}/${adsetId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ ...params, access_token: token }),
    }
  );
}

async function uploadVideoFromUrl(accountId: string, videoUrl: string, name: string, token: string): Promise<string> {
  await rateLimit();
  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${accountId}/advideos`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ file_url: videoUrl, name, access_token: token }),
    }
  );
  return data.id;
}

async function pollVideoReady(videoId: string, token: string, maxWaitMs = 240000): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    attempt++;
    await new Promise((r) => setTimeout(r, attempt < 3 ? 5000 : 8000));
    const data = await metaFetch<{ status?: { video_status?: string; processing_progress?: number } }>(
      `${META_BASE_URL}/${videoId}?fields=status&access_token=${token}`
    );
    const vs = data.status?.video_status;
    console.log(`[PublishVideos] poll video=${videoId} attempt=${attempt} status=${vs}`);
    if (vs === "ready") return;
    if (vs === "error") throw new Error(`Video processing failed: ${videoId}`);
  }
  throw new Error(`Video ${videoId} not ready after ${maxWaitMs}ms`);
}

async function fetchVideoThumbnail(videoId: string, token: string): Promise<string> {
  await rateLimit();
  const data = await metaFetch<{ data: Array<{ uri: string; is_preferred?: boolean }> }>(
    `${META_BASE_URL}/${videoId}/thumbnails?fields=uri,is_preferred&access_token=${token}`
  );
  const thumbs = data.data || [];
  const preferred = thumbs.find((t) => t.is_preferred) || thumbs[0];
  if (!preferred?.uri) throw new Error(`No thumbnail for video ${videoId}`);
  return preferred.uri;
}

// G4: createVideoCreative agora aceita partnership
async function createVideoCreative(params: {
  accountId: string;
  name: string;
  pageId: string;
  instagramUserId: string;
  videoId: string;
  thumbnailUrl: string;
  body: string;
  title: string;
  description: string;
  link: string;
  ctaType: string;
  urlTags: string;
  partnership?: PartnershipSpec;
  token: string;
}): Promise<string> {
  await rateLimit();
  const videoData: Record<string, unknown> = {
    video_id: params.videoId,
    image_url: params.thumbnailUrl,
    title: params.title,
    message: params.body,
    link_description: params.description,
    call_to_action: { type: params.ctaType, value: { link: params.link } },
  };

  const objectStorySpec: Record<string, unknown> = {
    page_id: params.pageId,
    video_data: videoData,
  };
  if (params.instagramUserId) objectStorySpec.instagram_user_id = params.instagramUserId;

  const formParams: Record<string, string> = {
    name: params.name,
    object_story_spec: JSON.stringify(objectStorySpec),
    access_token: params.token,
  };
  if (params.urlTags) formParams.url_tags = params.urlTags;

  // G4: partnership para vídeos
  if (params.partnership?.sponsor_id) {
    formParams.instagram_branded_content = JSON.stringify({ sponsor_id: params.partnership.sponsor_id });
    const brandedContent: Record<string, unknown> = { ad_format: 1 };
    if (params.partnership.testimonial) brandedContent.testimonial = params.partnership.testimonial;
    formParams.branded_content = JSON.stringify(brandedContent);
    console.log(`[PublishVideos] G4: partnership sponsor_id=${params.partnership.sponsor_id}`);
  }

  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${params.accountId}/adcreatives`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(formParams),
    }
  );
  return data.id;
}

async function createAd(params: {
  accountId: string;
  adsetId: string;
  creativeId: string;
  name: string;
  status: string;
  token: string;
}): Promise<string> {
  await rateLimit();
  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${params.accountId}/ads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        name: params.name,
        adset_id: params.adsetId,
        creative: JSON.stringify({ creative_id: params.creativeId }),
        status: params.status,
        access_token: params.token,
      }),
    }
  );
  return data.id;
}

// ── Main Handler ──

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const {
      source_adset_id,
      new_adset_name,
      daily_budget_cents,
      model_ad_id,
      // G9: campos diretos
      page_id: directPageId,
      instagram_user_id: directInstagramUserId,
      account_id: directAccountId,
      // G1: link override
      link: linkOverride,
      ads,
      start_paused = true,
      // G4: partnership
      partnership,
    } = body as {
      source_adset_id: string;
      new_adset_name: string;
      daily_budget_cents: number;
      model_ad_id?: string;
      page_id?: string;
      instagram_user_id?: string;
      account_id?: string;
      link?: string;
      ads: VideoAdSpec[];
      start_paused?: boolean;
      partnership?: PartnershipSpec;
    };

    if (!source_adset_id || !new_adset_name || !daily_budget_cents || !ads?.length) {
      return NextResponse.json(
        { error: "source_adset_id, new_adset_name, daily_budget_cents, ads[] are required" },
        { status: 400 }
      );
    }

    // G9: model_ad_id OR (page_id + instagram_user_id + account_id)
    const hasDirectFields = directPageId && directInstagramUserId && directAccountId;
    if (!model_ad_id && !hasDirectFields) {
      return NextResponse.json(
        { error: "model_ad_id OR (page_id + instagram_user_id + account_id) are required" },
        { status: 400 }
      );
    }

    const token = await getTokenForWorkspace(auth.workspace_id);
    console.log(`[PublishVideos] start: ${ads.length} videos → new adset cloned from ${source_adset_id}`);

    // 1. Model ad info
    let modelAd: ModelAdInfo;
    if (hasDirectFields) {
      const accountId = directAccountId!.startsWith("act_") ? directAccountId! : `act_${directAccountId!}`;
      modelAd = {
        link: linkOverride || "",
        pageId: directPageId!,
        instagramUserId: directInstagramUserId!,
        accountId,
        urlTags: "",
        displayLink: linkOverride ? (() => { try { return new URL(linkOverride).hostname; } catch { return ""; } })() : "",
      };
      console.log(`[PublishVideos] G9: direto page=${modelAd.pageId}, ig=${modelAd.instagramUserId}`);
    } else {
      modelAd = await fetchModelAd(model_ad_id!, token);
      // G1: override link
      if (linkOverride) {
        console.log(`[PublishVideos] G1: link override: ${modelAd.link} → ${linkOverride}`);
        modelAd.link = linkOverride;
        try { modelAd.displayLink = new URL(linkOverride).hostname; } catch { /* ignore */ }
      }
    }
    console.log(`[PublishVideos] model: account=${modelAd.accountId} page=${modelAd.pageId} ig=${modelAd.instagramUserId} link=${modelAd.link}`);

    // 2. Get campaign id
    const campaignId = await fetchAdsetCampaignId(source_adset_id, token);

    // 3. Copy source adset
    const newAdsetId = await copyAdset(source_adset_id, token);
    console.log(`[PublishVideos] copied adset: ${newAdsetId}`);

    // 4. Update name + budget
    await updateAdset(newAdsetId, {
      name: new_adset_name,
      daily_budget: String(daily_budget_cents),
    }, token);
    console.log(`[PublishVideos] adset updated: name="${new_adset_name}" budget=${daily_budget_cents}`);

    // 5. Process videos sequentially (evitar rate limit)
    const results: Record<string, unknown>[] = [];
    for (const ad of ads) {
      const result: Record<string, unknown> = { name: ad.name };
      try {
        const videoId = await uploadVideoFromUrl(modelAd.accountId, ad.video_url, ad.name, token);
        result.video_id = videoId;
        console.log(`[PublishVideos] ${ad.name} uploaded as video_id=${videoId}`);

        await pollVideoReady(videoId, token);
        console.log(`[PublishVideos] ${ad.name} video ready`);

        const thumbnailUrl = await fetchVideoThumbnail(videoId, token);
        result.thumbnail = thumbnailUrl;

        // G4: passa partnership para createVideoCreative
        const creativeId = await createVideoCreative({
          accountId: modelAd.accountId,
          name: ad.name,
          pageId: modelAd.pageId,
          instagramUserId: modelAd.instagramUserId,
          videoId,
          thumbnailUrl,
          body: ad.body,
          title: ad.title,
          description: ad.description,
          link: modelAd.link,
          ctaType: ad.cta_type,
          urlTags: modelAd.urlTags,
          partnership,
          token,
        });
        result.creative_id = creativeId;
        console.log(`[PublishVideos] ${ad.name} creative=${creativeId}`);

        const adId = await createAd({
          accountId: modelAd.accountId,
          adsetId: newAdsetId,
          creativeId,
          name: ad.name,
          status: start_paused ? "PAUSED" : "ACTIVE",
          token,
        });
        result.ad_id = adId;
        result.success = true;
        console.log(`[PublishVideos] ${ad.name} ad=${adId}`);
      } catch (err) {
        result.success = false;
        result.error = err instanceof Error ? err.message : String(err);
        console.error(`[PublishVideos] ${ad.name} FAILED:`, result.error);
      }
      results.push(result);
    }

    // Ativar adset se todos ok e não start_paused
    const allOk = results.every((r) => r.success);
    if (allOk && !start_paused) {
      try {
        await updateAdset(newAdsetId, { status: "ACTIVE" }, token);
        console.log(`[PublishVideos] adset activated`);
      } catch (err) {
        console.error(`[PublishVideos] failed activating adset:`, err);
      }
    }

    return NextResponse.json({
      campaign_id: campaignId,
      new_adset_id: newAdsetId,
      new_adset_name,
      total_ads: ads.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (err) {
    console.error("[PublishVideos]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
