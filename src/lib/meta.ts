/**
 * MetaService — Integração direta com a Meta Marketing API v25.0
 *
 * Todas as operações de escrita no Meta Ads (upload, creative, adset, ad)
 * estão centralizadas aqui. Camada fina sobre HTTP, sem SDK.
 */

import { KNOWN_CAMPAIGNS } from "@/config/campaigns";

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ── Helpers ──

/**
 * Mapa accountId → token, construído a partir de KNOWN_CAMPAIGNS.
 * Permite usar tokens distintos por conta Meta (Tarefa 4.2).
 */
function buildAccountTokenMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const campaign of Object.values(KNOWN_CAMPAIGNS)) {
    const { metaAccountId, metaTokenEnvVar } = campaign;
    if (metaTokenEnvVar && metaAccountId) {
      const token = process.env[metaTokenEnvVar];
      if (token) map[metaAccountId] = token;
    }
  }
  return map;
}

/**
 * Retorna o access token correto para uma conta Meta.
 * Ordem de prioridade:
 *  1. Token específico da conta (via metaTokenEnvVar em campaigns.ts)
 *  2. META_SYSTEM_USER_TOKEN (token padrão / legado)
 */
function getToken(accountId?: string): string {
  if (accountId) {
    const map = buildAccountTokenMap();
    if (map[accountId]) return map[accountId];
  }
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
    const safeUrl = url.replace(/access_token=[^&]+/, "access_token=***");
    const errJson = JSON.stringify(err);
    const message = err
      ? `Meta API Error ${err.code}: ${err.message} (subcode: ${err.error_subcode}) | URL: ${safeUrl} | Detail: ${errJson}`
      : `Meta API HTTP ${response.status}: ${response.statusText} | URL: ${safeUrl}`;
    console.error("[MetaService]", message);
    throw new Error(message);
  }

  return data as T;
}

function formBody(params: Record<string, string>, accountId?: string): URLSearchParams {
  const body = new URLSearchParams();
  body.append("access_token", getToken(accountId));
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
  const tokenPart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${getToken(accountId)}\r\n--${boundary}--`;

  const bodyWithCorrectToken = Buffer.concat([
    Buffer.from(header),
    imageBuffer,
    Buffer.from(tokenPart),
  ]);

  const data = await metaFetch<Record<string, unknown>>(
    `${META_BASE_URL}/${accountId}/adimages`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyWithCorrectToken,
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
      body: formBody({ name }, accountId),
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

/**
 * Cria criativo com asset_feed_spec — estrutura validada na publicação
 * de AD004-AD010 na campanha T7__0003 em 2026-04-01.
 *
 * Diferenças chave vs abordagem anterior que falhava:
 * - ad_formats: AUTOMATIC_FORMAT (não SINGLE_IMAGE)
 * - asset_customization_rules DENTRO do asset_feed_spec (não campo separado)
 * - image_label (com name+id) ao invés de adlabel
 * - optimization_type: PLACEMENT
 * - descriptions: campo adicional
 * - Sem link_data no object_story_spec
 * - Sem is_dynamic_creative no ad set
 */
export async function createCreative(params: CreateCreativeParams): Promise<CreativeResult> {
  await rateLimit();

  const {
    accountId, name, pageId, instagramUserId,
    feedImageHash, storiesImageHash, feedLabelId, storiesLabelId,
    body: bodyText, title, link, callToAction, urlTags,
  } = params;

  // asset_feed_spec — estrutura idêntica à validada em produção
  // asset_customization_rules ficam DENTRO do asset_feed_spec
  const assetFeedSpec = {
    ad_formats: ["AUTOMATIC_FORMAT"],
    images: [
      { hash: feedImageHash, adlabels: [{ name: `${name}_feed`, id: feedLabelId }] },
      { hash: storiesImageHash, adlabels: [{ name: `${name}_stories`, id: storiesLabelId }] },
    ],
    bodies: [{ text: bodyText }],
    titles: [{ text: title }],
    descriptions: [{ text: "" }],
    link_urls: [{ website_url: link, display_url: new URL(link).hostname }],
    call_to_action_types: [callToAction || "LEARN_MORE"],
    asset_customization_rules: [
      {
        priority: 1,
        image_label: { name: `${name}_stories`, id: storiesLabelId },
        customization_spec: {
          publisher_platforms: ["instagram"],
          instagram_positions: ["ig_search", "profile_reels", "story", "reels"],
          age_min: 13,
          age_max: 65,
        },
      },
      {
        priority: 2,
        image_label: { name: `${name}_feed`, id: feedLabelId },
        customization_spec: {
          age_min: 13,
          age_max: 65,
        },
      },
    ],
    optimization_type: "PLACEMENT",
  };

  // object_story_spec — APENAS page_id + instagram_user_id, sem link_data
  const objectStorySpec = {
    page_id: pageId,
    instagram_user_id: instagramUserId,
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
      body: formBody(formParams, accountId),
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
      body: formBody(formParams, accountId),
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
      }, params.accountId),
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

// ── Read: Ad Content from existing ads ──

interface AdContentResult {
  body: string;
  title: string;
  link: string;
  callToAction: string;
}

/**
 * Busca ads existentes de uma campanha e extrai body/title/link/CTA
 * do object_story_spec ou asset_feed_spec do primeiro ad ativo.
 * Usado para replicar o conteúdo textual em novos criativos de teste.
 */
export async function getAdContentFromCampaign(
  campaignId: string
): Promise<AdContentResult | null> {
  await rateLimit();

  // 1. Buscar ads da campanha (via ad sets)
  const adSets = await getAdSets(campaignId, "id");
  if (adSets.length === 0) return null;

  // 2. Buscar ads do primeiro ad set ativo
  for (const adSet of adSets) {
    await rateLimit();
    const params = new URLSearchParams({
      fields: "id,name,status,creative{id,name,object_story_spec,asset_feed_spec}",
      access_token: getToken(),
      limit: "10",
    });

    const data = await metaFetch<{ data: Array<Record<string, unknown>> }>(
      `${META_BASE_URL}/${adSet.id}/ads?${params.toString()}`
    );

    if (!data.data || data.data.length === 0) continue;

    // Buscar primeiro ad ativo com creative
    for (const ad of data.data) {
      const creative = ad.creative as Record<string, unknown> | undefined;
      if (!creative) continue;

      // Tentar extrair de asset_feed_spec primeiro (mais completo)
      const assetFeedSpec = creative.asset_feed_spec as Record<string, unknown> | undefined;
      if (assetFeedSpec) {
        const bodies = assetFeedSpec.bodies as Array<{ text: string }> | undefined;
        const titles = assetFeedSpec.titles as Array<{ text: string }> | undefined;
        const linkUrls = assetFeedSpec.link_urls as Array<{ website_url: string }> | undefined;
        const ctaTypes = assetFeedSpec.call_to_action_types as string[] | undefined;

        if (bodies?.[0]?.text || linkUrls?.[0]?.website_url) {
          console.log(`[MetaService] Extracted ad content from asset_feed_spec of ad ${ad.name}`);
          return {
            body: bodies?.[0]?.text || "",
            title: titles?.[0]?.text || "",
            link: linkUrls?.[0]?.website_url || "",
            callToAction: ctaTypes?.[0] || "LEARN_MORE",
          };
        }
      }

      // Fallback: extrair de object_story_spec
      const oss = creative.object_story_spec as Record<string, unknown> | undefined;
      if (oss) {
        const linkData = oss.link_data as Record<string, unknown> | undefined;
        if (linkData) {
          const cta = linkData.call_to_action as Record<string, unknown> | undefined;
          console.log(`[MetaService] Extracted ad content from object_story_spec of ad ${ad.name}`);
          return {
            body: (linkData.message as string) || "",
            title: (linkData.name as string) || "",
            link: (linkData.link as string) || "",
            callToAction: (cta?.type as string) || "LEARN_MORE",
          };
        }
      }
    }
  }

  return null;
}

// ── Utility: Extrair métricas de actions ──

export function extractLPVFromInsights(
  insights: Record<string, unknown>
): number {
  const actions = insights.actions as Array<{ action_type: string; value: string }> | undefined;
  if (!actions) return 0;
  const lpvAction = actions.find((a) => a.action_type === "landing_page_view");
  return lpvAction ? parseInt(lpvAction.value, 10) : 0;
}

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

// ── Insights: Coleta em Massa (Tarefa 2.1) ──────────────────────────────────

export interface AdInsightRecord {
  meta_ad_id: string;
  meta_adset_id?: string;
  meta_campaign_id?: string;
  ad_name?: string;
  adset_name?: string;
  date_start: string;
  date_stop: string;
  spend: number;
  impressions: number;
  cpm: number;
  ctr: number;
  clicks: number;
  cpc: number;
  leads: number;
  cpl: number | null;
  landing_page_views: number;
  /** Presente quando breakdown inclui publisher_platform */
  publisher_platform?: string;
  /** Presente quando breakdown inclui platform_position */
  platform_position?: string;
  /** Presente quando breakdown inclui age */
  age?: string;
  /** Presente quando breakdown inclui gender */
  gender?: string;
}

/**
 * Busca insights de TODOS os ads de uma campanha para um período.
 *
 * Usa o endpoint campaign-level com level=ad para obter dados
 * de todos os ads em uma única chamada — muito mais eficiente
 * que buscar ad por ad.
 *
 * @param campaignId  - Meta campaign ID
 * @param dateFrom    - YYYY-MM-DD
 * @param dateTo      - YYYY-MM-DD
 * @param breakdown   - breakdown opcional (ex: "publisher_platform,platform_position")
 */
export async function getCampaignAdsInsights(
  campaignId: string,
  dateFrom: string,
  dateTo: string,
  breakdown?: string
): Promise<AdInsightRecord[]> {
  await rateLimit();

  const fields = [
    "ad_id",
    "ad_name",
    "adset_id",
    "adset_name",
    "campaign_id",
    "date_start",
    "date_stop",
    "spend",
    "impressions",
    "cpm",
    "ctr",
    "clicks",
    "cpc",
    "actions",
    "cost_per_action_type",
    "inline_link_clicks",
  ].join(",");

  const params = new URLSearchParams({
    fields,
    level: "ad",
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    time_increment: "1",
    access_token: getToken(),
    limit: "200",
  });

  if (breakdown) {
    params.set("breakdowns", breakdown);
  }

  const results: AdInsightRecord[] = [];
  let url: string | null = `${META_BASE_URL}/${campaignId}/insights?${params.toString()}`;

  // Paginar através de todos os resultados
  while (url) {
    type PageResult = { data: Record<string, unknown>[]; paging?: { next?: string } };
    const data: PageResult = await metaFetch<PageResult>(url);

    for (const row of data.data || []) {
      const leads = extractLeadsFromInsights(row);
      const cpl = extractCPLFromInsights(row);
      const lpv = extractLPVFromInsights(row);
      const spend = parseFloat((row.spend as string) || "0");
      const impressions = parseInt((row.impressions as string) || "0", 10);
      const cpm = parseFloat((row.cpm as string) || "0");
      const ctr = parseFloat((row.ctr as string) || "0");
      const clicks = parseInt((row.clicks as string) || "0", 10);
      const cpc = parseFloat((row.cpc as string) || "0");

      results.push({
        meta_ad_id: row.ad_id as string,
        meta_adset_id: row.adset_id as string | undefined,
        meta_campaign_id: row.campaign_id as string | undefined,
        ad_name: row.ad_name as string | undefined,
        adset_name: row.adset_name as string | undefined,
        date_start: row.date_start as string,
        date_stop: row.date_stop as string,
        spend,
        impressions,
        cpm,
        ctr,
        clicks,
        cpc,
        leads,
        cpl,
        landing_page_views: lpv,
        // Campos de breakdown (presentes quando breakdowns param é utilizado)
        publisher_platform: row.publisher_platform as string | undefined,
        platform_position: row.platform_position as string | undefined,
        age: row.age as string | undefined,
        gender: row.gender as string | undefined,
      });
    }

    url = data.paging?.next || null;
    if (url) await rateLimit(); // respeitar rate limit entre páginas
  }

  console.log(`[MetaService] getCampaignAdsInsights: ${results.length} registros para campanha ${campaignId} (${dateFrom} → ${dateTo})`);
  return results;
}

/**
 * Busca insights por account — útil quando não se sabe a campanha exata.
 * Filtra por campanha se campaignId informado.
 */
export async function getAccountAdsInsights(
  accountId: string,
  dateFrom: string,
  dateTo: string,
  campaignId?: string
): Promise<AdInsightRecord[]> {
  await rateLimit();

  const fields = [
    "ad_id",
    "ad_name",
    "adset_id",
    "adset_name",
    "campaign_id",
    "campaign_name",
    "date_start",
    "date_stop",
    "spend",
    "impressions",
    "cpm",
    "ctr",
    "clicks",
    "cpc",
    "actions",
    "cost_per_action_type",
  ].join(",");

  const params = new URLSearchParams({
    fields,
    level: "ad",
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    time_increment: "1",
    access_token: getToken(accountId), // token específico por conta (Tarefa 4.2)
    limit: "200",
  });

  if (campaignId) {
    params.set("filtering", JSON.stringify([{ field: "campaign.id", operator: "EQUAL", value: campaignId }]));
  }

  const data = await metaFetch<{ data: Record<string, unknown>[] }>(
    `${META_BASE_URL}/${accountId}/insights?${params.toString()}`
  );

  const results: AdInsightRecord[] = [];
  for (const row of data.data || []) {
    const leads = extractLeadsFromInsights(row);
    const cpl = extractCPLFromInsights(row);

    results.push({
      meta_ad_id: row.ad_id as string,
      meta_adset_id: row.adset_id as string | undefined,
      meta_campaign_id: row.campaign_id as string | undefined,
      ad_name: row.ad_name as string | undefined,
      adset_name: row.adset_name as string | undefined,
      date_start: row.date_start as string,
      date_stop: row.date_stop as string,
      spend: parseFloat((row.spend as string) || "0"),
      impressions: parseInt((row.impressions as string) || "0", 10),
      cpm: parseFloat((row.cpm as string) || "0"),
      ctr: parseFloat((row.ctr as string) || "0"),
      clicks: parseInt((row.clicks as string) || "0", 10),
      cpc: parseFloat((row.cpc as string) || "0"),
      leads,
      cpl,
      landing_page_views: extractLPVFromInsights(row),
    });
  }

  return results;
}
