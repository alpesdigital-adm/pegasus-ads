/**
 * POST /api/ads/publish-carousel
 *
 * Publica carrosséis em ad sets EXISTENTES de uma campanha, usando um ad modelo
 * como referência para link, page_id, instagram_actor_id, display_link, url_tags.
 *
 * Body (JSON):
 * {
 *   "campaign_id": "120242550231280521",
 *   "model_ad_id": "120242550231240521",
 *   "carousels": [
 *     {
 *       "name": "T7EBMX-CA-030",
 *       "body": "Copy primário (legenda)...",
 *       "headline": "Headline abaixo de cada card",
 *       "description": "Descrição complementar",
 *       "cta_type": "DOWNLOAD",
 *       "cards": [
 *         { "image_base64": "iVBOR...", "image_filename": "T7EBMX-CA-030A.png" },
 *         { "image_base64": "iVBOR...", "image_filename": "T7EBMX-CA-030B.png" },
 *         { "image_base64": "iVBOR...", "image_filename": "T7EBMX-CA-030C.png" }
 *       ]
 *     }
 *   ]
 * }
 *
 * O endpoint:
 * 1. Busca o ad modelo para extrair link, page_id, instagram_actor_id, account_id, display_link
 * 2. Lista TODOS os ad sets da campanha
 * 3. Para cada carrossel: upload imagens → cria creative com child_attachments → cria ad em CADA ad set
 *
 * Protegido por x-api-key (TEST_LOG_API_KEY).
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

function getToken(): string {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) throw new Error("META_SYSTEM_USER_TOKEN env var is required");
  return token;
}

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  const expected = process.env.TEST_LOG_API_KEY;
  if (!expected) return false;
  return key === expected;
}

async function metaFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || (data as Record<string, unknown>).error) {
    const err = (data as Record<string, unknown>).error as Record<string, unknown> | undefined;
    throw new Error(`Meta API error: ${JSON.stringify(err)}`);
  }
  return data as T;
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// Rate limit helper
let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 500) await new Promise((r) => setTimeout(r, 500 - diff));
  lastCall = Date.now();
}

interface CardSpec {
  image_base64: string;
  image_filename: string;
}

interface CarouselSpec {
  name: string;
  body: string;
  headline: string;
  description: string;
  cta_type: string;
  cards: CardSpec[];
}

interface ModelAdInfo {
  link: string;
  pageId: string;
  instagramUserId: string;
  accountId: string;
  urlTags: string;
  displayLink: string;
}

/**
 * Busca informações do ad modelo: creative spec + account.
 */
async function fetchModelAd(adId: string): Promise<ModelAdInfo> {
  await rateLimit();
  const token = getToken();

  const adData = await metaFetch<Record<string, unknown>>(
    `${META_BASE_URL}/${adId}?fields=account_id,creative{id,object_story_spec,asset_feed_spec,effective_object_story_spec,url_tags}&access_token=${token}`
  );

  const accountId = (adData.account_id as string) || "";
  const creative = adData.creative as Record<string, unknown>;

  let link = "";
  let pageId = "";
  let instagramUserId = "";
  let urlTags = "";
  let displayLink = "";

  // Extract from asset_feed_spec
  const afs = creative?.asset_feed_spec as Record<string, unknown> | undefined;
  if (afs) {
    const linkUrls = afs.link_urls as Array<{ website_url: string; display_url?: string }> | undefined;
    if (linkUrls?.[0]) {
      link = linkUrls[0].website_url;
      if (linkUrls[0].display_url) displayLink = linkUrls[0].display_url;
    }
  }

  // Extract page_id and instagram from object_story_spec
  const oss = creative?.object_story_spec as Record<string, unknown> | undefined;
  if (oss) {
    pageId = (oss.page_id as string) || "";
    instagramUserId =
      (oss.instagram_actor_id as string) ||
      (oss.instagram_user_id as string) ||
      "";
  }

  // Fallback: effective_object_story_spec always has the resolved fields
  const eoss = creative?.effective_object_story_spec as Record<string, unknown> | undefined;
  if (eoss) {
    if (!pageId) pageId = (eoss.page_id as string) || "";
    if (!instagramUserId) {
      instagramUserId =
        (eoss.instagram_actor_id as string) ||
        (eoss.instagram_user_id as string) ||
        "";
    }
    const eLinkData = eoss.link_data as Record<string, unknown> | undefined;
    if (eLinkData) {
      if (!link) link = (eLinkData.link as string) || "";
      if (!displayLink) displayLink = (eLinkData.caption as string) || "";
    }
  }

  urlTags = (creative?.url_tags as string) || "";

  if (!link && oss) {
    const linkData = oss.link_data as Record<string, unknown> | undefined;
    if (linkData) {
      link = (linkData.link as string) || "";
      if (!displayLink) displayLink = (linkData.caption as string) || "";
    }
  }

  if (!displayLink && link) {
    try { displayLink = new URL(link).hostname; } catch { /* ignore */ }
  }

  console.log(`[PublishCarousel] Model ad: page=${pageId}, ig=${instagramUserId}, link=${link}, displayLink=${displayLink}`);

  return {
    link,
    pageId,
    instagramUserId,
    accountId: accountId.startsWith("act_") ? accountId : `act_${accountId}`,
    urlTags,
    displayLink,
  };
}

/**
 * Lista ad sets de uma campanha.
 */
async function fetchAdSets(campaignId: string): Promise<Array<{ id: string; name: string; status: string }>> {
  await rateLimit();
  const token = getToken();

  const data = await metaFetch<{ data: Array<{ id: string; name: string; status: string }> }>(
    `${META_BASE_URL}/${campaignId}/adsets?fields=id,name,status&limit=50&access_token=${token}`
  );

  return data.data || [];
}

/**
 * Upload de imagem para a conta de anúncios.
 */
async function uploadImage(accountId: string, imageBuffer: Buffer, filename: string): Promise<{ hash: string }> {
  await rateLimit();
  const token = getToken();

  const data = await metaFetch<{ images: Record<string, { hash: string }> }>(
    `${META_BASE_URL}/${accountId}/adimages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        access_token: token,
        filename,
        bytes: imageBuffer.toString("base64"),
      }),
    }
  );

  const imageInfo = Object.values(data.images)[0];
  if (!imageInfo?.hash) throw new Error(`Image upload failed for ${filename}`);
  return { hash: imageInfo.hash };
}

/**
 * Cria creative de carrossel com child_attachments no link_data.
 *
 * Formato padrão (não-dinâmico): object_story_spec → link_data → child_attachments[].
 * Cada child_attachment é um card com image_hash, link, name, description, call_to_action.
 */
async function createCarouselCreative(params: {
  accountId: string;
  name: string;
  pageId: string;
  instagramUserId: string;
  imageHashes: string[];
  body: string;
  headline: string;
  description: string;
  link: string;
  ctaType: string;
  urlTags: string;
  displayLink: string;
}): Promise<{ id: string }> {
  await rateLimit();
  const token = getToken();

  const {
    accountId, name, pageId, instagramUserId,
    imageHashes, body: bodyText, headline, description,
    link, ctaType, urlTags, displayLink,
  } = params;

  // Build child_attachments — one per card image
  const childAttachments = imageHashes.map((hash) => {
    const child: Record<string, unknown> = {
      image_hash: hash,
      link: link,
      name: headline,
      description: description,
      call_to_action: {
        type: ctaType,
        value: { link: link },
      },
    };
    return child;
  });

  // Build link_data with child_attachments
  const linkData: Record<string, unknown> = {
    message: bodyText,
    link: link,
    child_attachments: childAttachments,
  };

  if (displayLink) {
    linkData.caption = displayLink;
  }

  // Build object_story_spec
  const objectStorySpec: Record<string, unknown> = {
    page_id: pageId,
    link_data: linkData,
  };

  if (instagramUserId) {
    objectStorySpec.instagram_actor_id = instagramUserId;
  }

  const formParams: Record<string, string> = {
    name,
    object_story_spec: JSON.stringify(objectStorySpec),
    access_token: token,
  };

  if (urlTags) formParams.url_tags = urlTags;

  console.log(`[PublishCarousel] Creating carousel creative: ${name} with ${imageHashes.length} cards`);

  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${accountId}/adcreatives`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(formParams),
    }
  );

  return { id: data.id };
}

/**
 * Cria ad em um ad set.
 */
async function createAd(params: {
  accountId: string;
  adSetId: string;
  creativeId: string;
  name: string;
}): Promise<{ id: string }> {
  await rateLimit();
  const token = getToken();

  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${params.accountId}/ads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        name: params.name,
        adset_id: params.adSetId,
        creative: JSON.stringify({ creative_id: params.creativeId }),
        status: "ACTIVE",
        access_token: token,
      }),
    }
  );

  return { id: data.id };
}

// ── Main Handler ──

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    const { campaign_id, model_ad_id, carousels } = body as {
      campaign_id: string;
      model_ad_id: string;
      carousels: CarouselSpec[];
    };

    if (!campaign_id || !model_ad_id || !carousels || carousels.length === 0) {
      return NextResponse.json(
        { error: "campaign_id, model_ad_id, and carousels[] are required" },
        { status: 400 }
      );
    }

    console.log(`[PublishCarousel] Starting: ${carousels.length} carousels → campaign ${campaign_id}`);

    // 1. Fetch model ad info
    console.log(`[PublishCarousel] Fetching model ad ${model_ad_id}...`);
    const modelAd = await fetchModelAd(model_ad_id);

    // 2. Fetch ad sets
    console.log(`[PublishCarousel] Fetching ad sets for campaign ${campaign_id}...`);
    const allAdSets = await fetchAdSets(campaign_id);
    console.log(`[PublishCarousel] Found ${allAdSets.length} ad sets`);

    if (allAdSets.length === 0) {
      return NextResponse.json({ error: "No ad sets found in campaign" }, { status: 400 });
    }

    // 3. Publish each carousel to each ad set
    const results: Array<{
      carousel_name: string;
      creative_id: string;
      image_hashes: string[];
      ads_created: Array<{ ad_id: string; adset_id: string; adset_name: string }>;
      errors: string[];
    }> = [];

    for (const carousel of carousels) {
      console.log(`[PublishCarousel] Processing ${carousel.name} (${carousel.cards.length} cards)...`);
      const result = {
        carousel_name: carousel.name,
        creative_id: "",
        image_hashes: [] as string[],
        ads_created: [] as Array<{ ad_id: string; adset_id: string; adset_name: string }>,
        errors: [] as string[],
      };

      try {
        // Upload all card images
        const imageHashes: string[] = [];
        for (const card of carousel.cards) {
          const imageBuffer = Buffer.from(card.image_base64, "base64");
          console.log(`[PublishCarousel] Uploading ${card.image_filename} (${imageBuffer.length} bytes)...`);
          const upload = await uploadImage(modelAd.accountId, imageBuffer, card.image_filename);
          imageHashes.push(upload.hash);
          console.log(`[PublishCarousel] Uploaded: hash=${upload.hash}`);
        }
        result.image_hashes = imageHashes;

        // Create carousel creative
        const creative = await createCarouselCreative({
          accountId: modelAd.accountId,
          name: carousel.name,
          pageId: modelAd.pageId,
          instagramUserId: modelAd.instagramUserId,
          imageHashes,
          body: carousel.body,
          headline: carousel.headline,
          description: carousel.description,
          link: modelAd.link,
          ctaType: carousel.cta_type,
          urlTags: modelAd.urlTags,
          displayLink: modelAd.displayLink,
        });
        result.creative_id = creative.id;
        console.log(`[PublishCarousel] Creative created: ${creative.id}`);

        // Create ad in each ad set
        for (const adSet of allAdSets) {
          try {
            const adCreated = await createAd({
              accountId: modelAd.accountId,
              adSetId: adSet.id,
              creativeId: creative.id,
              name: carousel.name,
            });
            result.ads_created.push({
              ad_id: adCreated.id,
              adset_id: adSet.id,
              adset_name: adSet.name,
            });
            console.log(`[PublishCarousel] Ad created: ${adCreated.id} in adset ${adSet.name}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Failed in adset ${adSet.id}: ${msg}`);
            console.error(`[PublishCarousel] Failed creating ad in adset ${adSet.id}:`, msg);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(msg);
        console.error(`[PublishCarousel] Failed processing ${carousel.name}:`, msg);
      }

      results.push(result);
    }

    const totalAdsCreated = results.reduce((sum, r) => sum + r.ads_created.length, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    return NextResponse.json({
      campaign_id,
      model_ad_id,
      ad_sets: allAdSets.map((s) => ({ id: s.id, name: s.name, status: s.status })),
      total_ads_created: totalAdsCreated,
      total_errors: totalErrors,
      results,
    });
  } catch (err) {
    console.error("[PublishCarousel]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
