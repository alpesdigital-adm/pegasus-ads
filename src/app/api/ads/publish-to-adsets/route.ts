/**
 * POST /api/ads/publish-to-adsets
 *
 * Publica criativos em ad sets EXISTENTES de uma campanha, usando um ad modelo
 * como referência para link, page_id, instagram_user_id, etc.
 * Permite textos customizados (body, title, description, cta) por criativo.
 *
 * Body (JSON):
 * {
 *   "campaign_id": "120242550231280521",
 *   "model_ad_id": "120242550231240521",
 *   "ads": [
 *     {
 *       "name": "T7EBMX-AD026",
 *       "image_base64": "iVBOR...",
 *       "image_filename": "T7EBMX-AD026F.png",
 *       "body": "Texto principal...",
 *       "title": "Headline...",
 *       "description": "Descrição...",
 *       "cta_type": "DOWNLOAD"
 *     }
 *   ]
 * }
 *
 * O endpoint:
 * 1. Busca o ad modelo para extrair link, page_id, instagram_user_id, account_id
 * 2. Lista TODOS os ad sets da campanha
 * 3. Para cada ad: upload imagem → cria creative → cria ad em CADA ad set
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

interface AdSpec {
  name: string;
  image_base64: string;
  image_filename: string;
  body: string;
  title: string;
  description: string;
  cta_type: string;
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

  // Buscar ad com creative expandido
  const adData = await metaFetch<Record<string, unknown>>(
    `${META_BASE_URL}/${adId}?fields=account_id,creative{id,object_story_spec,asset_feed_spec,url_tags}&access_token=${token}`
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
  // Meta uses instagram_actor_id in standard creatives, instagram_user_id in asset_feed_spec ones
  const oss = creative?.object_story_spec as Record<string, unknown> | undefined;
  if (oss) {
    pageId = (oss.page_id as string) || "";
    instagramUserId =
      (oss.instagram_actor_id as string) ||
      (oss.instagram_user_id as string) ||
      "";
  }

  // url_tags
  urlTags = (creative?.url_tags as string) || "";

  // If link not found yet, try object_story_spec.link_data
  if (!link && oss) {
    const linkData = oss.link_data as Record<string, unknown> | undefined;
    if (linkData) {
      link = (linkData.link as string) || "";
      if (!displayLink) displayLink = (linkData.caption as string) || "";
    }
  }

  // Auto-generate display_link from link hostname if still empty
  if (!displayLink && link) {
    try {
      displayLink = new URL(link).hostname;
    } catch { /* ignore */ }
  }

  console.log(`[PublishToAdSets] Model ad extracted: page=${pageId}, ig=${instagramUserId}, link=${link}, displayLink=${displayLink}`);

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

  const form = new FormData();
  form.append("access_token", token);
  form.append("filename", filename);
  form.append("bytes", imageBuffer.toString("base64"));

  // Use x-www-form-urlencoded for bytes upload
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
 * Cria creative com object_story_spec + link_data (formato padrão, NÃO dinâmico).
 * Permite múltiplos ads por ad set (diferente de asset_feed_spec que força criativo dinâmico).
 */
async function createCreativeSingleImage(params: {
  accountId: string;
  name: string;
  pageId: string;
  instagramUserId: string;
  imageHash: string;
  body: string;
  title: string;
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
    imageHash, body: bodyText, title, description, link, ctaType, urlTags,
    displayLink,
  } = params;

  // object_story_spec com link_data — formato padrão (não-dinâmico)
  // instagram_actor_id = conta IG vinculada
  // caption = link de exibição (display link)
  const linkData: Record<string, unknown> = {
    image_hash: imageHash,
    link: link,
    message: bodyText,
    name: title,
    description: description,
    call_to_action: {
      type: ctaType,
      value: { link: link },
    },
  };

  // Incluir caption (display link) se disponível
  if (displayLink) {
    linkData.caption = displayLink;
  }

  const objectStorySpec: Record<string, unknown> = {
    page_id: pageId,
    link_data: linkData,
  };

  // Incluir instagram_user_id (NÃO instagram_actor_id — erro 100 na API v25.0)
  if (instagramUserId) {
    objectStorySpec.instagram_user_id = instagramUserId;
  }

  const formParams: Record<string, string> = {
    name,
    object_story_spec: JSON.stringify(objectStorySpec),
    access_token: token,
  };

  if (urlTags) formParams.url_tags = urlTags;

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

    const { campaign_id, model_ad_id, ads } = body as {
      campaign_id: string;
      model_ad_id: string;
      ads: AdSpec[];
    };

    if (!campaign_id || !model_ad_id || !ads || ads.length === 0) {
      return NextResponse.json(
        { error: "campaign_id, model_ad_id, and ads[] are required" },
        { status: 400 }
      );
    }

    console.log(`[PublishToAdSets] Starting: ${ads.length} ads → campaign ${campaign_id}`);

    // 1. Fetch model ad info
    console.log(`[PublishToAdSets] Fetching model ad ${model_ad_id}...`);
    const modelAd = await fetchModelAd(model_ad_id);
    console.log(`[PublishToAdSets] Model ad: link=${modelAd.link}, page=${modelAd.pageId}, account=${modelAd.accountId}`);

    // 2. Fetch ad sets
    console.log(`[PublishToAdSets] Fetching ad sets for campaign ${campaign_id}...`);
    const allAdSets = await fetchAdSets(campaign_id);
    console.log(`[PublishToAdSets] Found ${allAdSets.length} ad sets`);

    if (allAdSets.length === 0) {
      return NextResponse.json({ error: "No ad sets found in campaign" }, { status: 400 });
    }

    // 3. Publish each ad to each ad set
    const results: Array<{
      ad_name: string;
      creative_id: string;
      image_hash: string;
      ads_created: Array<{ ad_id: string; adset_id: string; adset_name: string }>;
      errors: string[];
    }> = [];

    for (const ad of ads) {
      console.log(`[PublishToAdSets] Processing ${ad.name}...`);
      const adResult = {
        ad_name: ad.name,
        creative_id: "",
        image_hash: "",
        ads_created: [] as Array<{ ad_id: string; adset_id: string; adset_name: string }>,
        errors: [] as string[],
      };

      try {
        // Upload image
        const imageBuffer = Buffer.from(ad.image_base64, "base64");
        console.log(`[PublishToAdSets] Uploading ${ad.image_filename} (${imageBuffer.length} bytes)...`);
        const upload = await uploadImage(modelAd.accountId, imageBuffer, ad.image_filename);
        adResult.image_hash = upload.hash;
        console.log(`[PublishToAdSets] Uploaded: hash=${upload.hash}`);

        // Create creative
        const creative = await createCreativeSingleImage({
          accountId: modelAd.accountId,
          name: ad.name,
          pageId: modelAd.pageId,
          instagramUserId: modelAd.instagramUserId,
          imageHash: upload.hash,
          body: ad.body,
          title: ad.title,
          description: ad.description,
          link: modelAd.link,
          ctaType: ad.cta_type,
          urlTags: modelAd.urlTags,
          displayLink: modelAd.displayLink,
        });
        adResult.creative_id = creative.id;
        console.log(`[PublishToAdSets] Creative created: ${creative.id}`);

        // Create ad in each ad set
        for (const adSet of allAdSets) {
          try {
            const adCreated = await createAd({
              accountId: modelAd.accountId,
              adSetId: adSet.id,
              creativeId: creative.id,
              name: ad.name,
            });
            adResult.ads_created.push({
              ad_id: adCreated.id,
              adset_id: adSet.id,
              adset_name: adSet.name,
            });
            console.log(`[PublishToAdSets] Ad created: ${adCreated.id} in adset ${adSet.name}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            adResult.errors.push(`Failed in adset ${adSet.id}: ${msg}`);
            console.error(`[PublishToAdSets] Failed creating ad in adset ${adSet.id}:`, msg);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        adResult.errors.push(msg);
        console.error(`[PublishToAdSets] Failed processing ${ad.name}:`, msg);
      }

      results.push(adResult);
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
    console.error("[PublishToAdSets]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
