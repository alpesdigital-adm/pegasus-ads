/**
 * MetaService — Integração direta com a Meta Marketing API v25.0
 *
 * Todas as operações de escrita no Meta Ads (upload, creative, adset, ad)
 * estão centralizadas aqui. Camada fina sobre HTTP, sem SDK.
 */

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ── Helpers ──

function getToken(): string {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) throw new Error("META_SYSTEM_USER_TOKEN env var is required");
  return token;
}

async function metaFetch<T = Record<string, unknown>>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok || (data as Record<string, unknown>).error) {
    const err = (data as Record<string, unknown>).error as Record<string, unknown> | undefined;
    const message = err
      ? `Meta API Error ${err.code}: ${err.message} (subcode: ${err.error_subcode})`
      : `Meta API HTTP ${response.status}: ${response.statusText}`;
    console.error("[MetaService]", message, "| URL:", url.replace(/access_token=[^&]+/, "access_token=***"), "| Full error:", JSON.stringify(err));
    throw new Error(message);
  }

  return data as T;
}

function formBody(params: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  body.append("access_token", getToken());
  for (const [key, value] of Object.entries(params)) {
    body.append(key, value);
  }
  return body;
}

// Rate limiting: min 500ms between calls
let lastCallTime = 0;
async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < 500) {
    await new Promise((resolve) => setTimeout(resolve, 500 - elapsed));
  }
  lastCallTime = Date.now();
}

// ── Image Upload ──

interface ImageUploadResult {
  hash: string;
  url: string;
}

/**
 * Upload image to Meta Ads via multipart form (campo "filename").
 * Retorna image hash para uso em criativos.
 */
export async function uploadImage(
  accountId: string,
  imageBuffer: Buffer,
  fileName: string
): Promise<ImageUploadResult> {
  await rateLimit();

  const boundary = `----MetaUpload${Date.now()}`;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`;
  const tokenPart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${getToken()}\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(header),
    imageBuffer,
    Buffer.from(tokenPart),
  ]);

  const data = await metaFetch<Record<string, unknown>>(
    `${META_BASE_URL}/${accountId}/adimages`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    }
  );

  // Response: { images: { "filename": { hash, url } } }
  const images = data.images as Record<string, { hash: string; url: string }>;
  const key = Object.keys(images)[0];
  return { hash: images[key].hash, url: images[key].url };
}

// ── Ad Labels ──

interface AdLabelResult {
  id: string;
  name: string;
}

export async function createAdLabel(
  accountId: string,
  name: string
): Promise<AdLabelResult> {
  await rateLimit();

  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${accountId}/adlabels`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ name }),
    }
  );

  return { id: data.id, name };
}

// ── Creatives ──

interface CreateCreativeParams {
  accountId: string;
  name: string;
  pageId: string;
  instagramUserId: string;
  feedImageHash: string;
  storiesImageHash: string;
  feedLabelId: string;
  storiesLabelId: string;
  body: string;
  title: string;
  link: string;
  callToAction?: string;
  urlTags?: string;
}

interface CreativeResult {
  id: string;
}

export async function createCreative(params: CreateCreativeParams): Promise<CreativeResult> {
  await rateLimit();

  const {
    accountId, name, pageId, instagramUserId,
    feedImageHash, storiesImageHash, feedLabelId, storiesLabelId,
    body: bodyText, title, link, callToAction, urlTags,
  } = params;

  // asset_feed_spec com imagens mapeadas por label
  const assetFeedSpec = {
    images: [
      { hash: feedImageHash, adlabels: [{ id: feedLabelId }] },
      { hash: storiesImageHash, adlabels: [{ id: storiesLabelId }] },
    ],
    bodies: [{ text: bodyText }],
    titles: [{ text: title }],
    link_urls: [{ website_url: link }],
    call_to_action_types: [callToAction || "LEARN_MORE"],
  };

  // asset_customization_rules: Feed (default) + Stories
  const assetCustomizationRules = [
    {
      priority: 2,
      customization_spec: { adlabel: { id: feedLabelId } },
      is_default: true,
    },
    {
      priority: 1,
      customization_spec: {
        adlabel: { id: storiesLabelId },
        publisher_platforms: ["instagram"],
        instagram_positions: ["story", "reels", "ig_search", "profile_reels"],
      },
    },
  ];

  // object_story_spec (instagram_user_id, NÃO instagram_actor_id)
  const objectStorySpec = {
    page_id: pageId,
    instagram_user_id: instagramUserId,
    link_data: {
      link,
      message: bodyText,
      call_to_action: { type: callToAction || "LEARN_MORE", value: { link } },
    },
  };

  // degrees_of_freedom_spec — features individuais, sem standard_enhancements
  const degreesOfFreedomSpec = {
    creative_features_spec: {
      image_templates: { enroll_status: "OPT_IN" },
      image_touchups: { enroll_status: "OPT_IN" },
      image_brightness_and_contrast: { enroll_status: "OPT_IN" },
      inline_comment: { enroll_status: "OPT_IN" },
    },
  };

  const formParams: Record<string, string> = {
    name,
    object_story_spec: JSON.stringify(objectStorySpec),
    asset_feed_spec: JSON.stringify(assetFeedSpec),
    asset_customization_rules: JSON.stringify(assetCustomizationRules),
    degrees_of_freedom_spec: JSON.stringify(degreesOfFreedomSpec),
  };

  if (urlTags) {
    formParams.url_tags = urlTags;
  }

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

// ── Ad Sets ──

interface CreateAdSetParams {
  accountId: string;
  campaignId: string;
  name: string;
  dailyBudgetCents: string;
  bidStrategy: string;
  billingEvent: string;
  optimizationGoal: string;
  targeting: Record<string, unknown>;
  promotedObject: Record<string, unknown>;
  attributionSpec?: Array<{ event_type: string; window_days: number }>;
  status?: string;
}

interface AdSetResult {
  id: string;
}

export async function createAdSet(params: CreateAdSetParams): Promise<AdSetResult> {
  await rateLimit();

  const {
    accountId, campaignId, name, dailyBudgetCents, bidStrategy,
    billingEvent, optimizationGoal, targeting, promotedObject,
    attributionSpec, status,
  } = params;

  // attribution_spec: default 1 dia clique para lead campaigns
  const attrSpec = attributionSpec || [{ event_type: "CLICK_THROUGH", window_days: 1 }];

  const formParams: Record<string, string> = {
    campaign_id: campaignId,
    name,
    daily_budget: dailyBudgetCents,
    bid_strategy: bidStrategy,
    billing_event: billingEvent,
    optimization_goal: optimizationGoal,
    targeting: JSON.stringify(targeting),
    promoted_object: JSON.stringify(promotedObject),
    attribution_spec: JSON.stringify(attrSpec),
    status: status || "ACTIVE",
  };

  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${accountId}/adsets`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(formParams),
    }
  );

  return { id: data.id };
}

// ── Ads ──

interface CreateAdParams {
  accountId: string;
  adSetId: string;
  creativeId: string;
  name: string;
  status?: string;
}

interface AdResult {
  id: string;
}

export async function createAd(params: CreateAdParams): Promise<AdResult> {
  await rateLimit();

  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${params.accountId}/ads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        name: params.name,
        adset_id: params.adSetId,
        creative: JSON.stringify({ creative_id: params.creativeId }),
        status: params.status || "ACTIVE",
      }),
    }
  );

  return { id: data.id };
}

// ── Read Operations ──

/**
 * Busca ad sets de uma campanha para copiar targeting e config.
 */
export async function getAdSets(
  campaignId: string,
  fields: string = "id,name,daily_budget,bid_strategy,billing_event,optimization_goal,targeting,promoted_object,attribution_spec,status"
): Promise<Record<string, unknown>[]> {
  await rateLimit();

  const params = new URLSearchParams({
    fields,
    access_token: getToken(),
    limit: "50",
  });

  const data = await metaFetch<{ data: Record<string, unknown>[] }>(
    `${META_BASE_URL}/${campaignId}/adsets?${params.toString()}`
  );

  return data.data || [];
}

/**
 * Busca métricas de um ad com insights.
 */
export async function getAdInsights(
  adId: string,
  dateFrom: string,
  dateTo: string,
  fields: string = "spend,impressions,cpm,ctr,clicks,cpc,actions,cost_per_action_type"
): Promise<Record<string, unknown> | null> {
  await rateLimit();

  const params = new URLSearchParams({
    fields,
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    access_token: getToken(),
  });

  const data = await metaFetch<{ data: Record<string, unknown>[] }>(
    `${META_BASE_URL}/${adId}/insights?${params.toString()}`
  );

  return data.data?.[0] || null;
}

/**
 * Busca informações de um ad set existente para servir de template.
 */
export async function getAdSetTemplate(
  campaignId: string
): Promise<Record<string, unknown> | null> {
  const adSets = await getAdSets(campaignId);
  if (adSets.length === 0) return null;

  // Retorna o primeiro ad set ativo como template
  const active = adSets.find((s) => s.status === "ACTIVE");
  return active || adSets[0];
}

/**
 * Atualiza status de um ad (ACTIVE, PAUSED, DELETED).
 */
export async function updateAdStatus(
  adId: string,
  status: "ACTIVE" | "PAUSED" | "DELETED"
): Promise<boolean> {
  await rateLimit();

  const data = await metaFetch<{ success: boolean }>(
    `${META_BASE_URL}/${adId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ status }),
    }
  );

  return data.success;
}

/**
 * Atualiza status de um ad set.
 */
export async function updateAdSetStatus(
  adSetId: string,
  status: "ACTIVE" | "PAUSED" | "DELETED"
): Promise<boolean> {
  await rateLimit();

  const data = await metaFetch<{ success: boolean }>(
    `${META_BASE_URL}/${adSetId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ status }),
    }
  );

  return data.success;
}

// ── Utility: Extrair leads de actions ──

export function extractLeadsFromInsights(
  insights: Record<string, unknown>
): number {
  const actions = insights.actions as Array<{ action_type: string; value: string }> | undefined;
  if (!actions) return 0;

  const leadAction = actions.find(
    (a) => a.action_type === "offsite_conversion.fb_pixel_lead"
  );
  return leadAction ? parseInt(leadAction.value, 10) : 0;
}

export function extractCPLFromInsights(
  insights: Record<string, unknown>
): number | null {
  const costs = insights.cost_per_action_type as Array<{ action_type: string; value: string }> | undefined;
  if (!costs) return null;

  const leadCost = costs.find(
    (a) => a.action_type === "offsite_conversion.fb_pixel_lead"
  );
  return leadCost ? parseFloat(leadCost.value) : null;
}
