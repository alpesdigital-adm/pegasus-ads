/**
 * POST /api/ads/publish-to-adsets
 *
 * Publica criativos em ad sets de uma campanha, usando um ad modelo
 * como referência para link, page_id, instagram_user_id, etc.
 *
 * Body (JSON):
 * {
 *   "campaign_id": "120242550231280521",
 *   "model_ad_id": "120242550231240521",   // opcional se page_id + instagram_user_id + account_id fornecidos (G9)
 *   "page_id": "...",                       // G9: direto, sem model_ad
 *   "instagram_user_id": "...",             // G9
 *   "account_id": "act_...",               // G9
 *   "link": "https://...",                  // G1: override do link do model_ad
 *   "adset_ids": ["...", "..."],            // G2: filtro de ad sets (vazio = todos)
 *   "source_adset_id": "...",              // G3: se fornecido, clona novo adset ao invés de usar existentes
 *   "new_adset_name": "...",               // G3: nome do novo adset clonado
 *   "daily_budget_cents": 50000,           // G3: orçamento do novo adset
 *   "ads": [
 *     {
 *       "name": "T7EBMX-AD026",
 *       "image_base64": "iVBOR...",         // ou image_hash (G5)
 *       "image_hash": "abc123...",          // G5: alternativa a image_base64
 *       "image_filename": "T7EBMX-AD026F.png",
 *       "body": "Texto principal...",
 *       "title": "Headline...",
 *       "description": "Descrição...",
 *       "cta_type": "DOWNLOAD"
 *     }
 *   ],
 *   "partnership": {                        // opcional
 *     "sponsor_id": "17841400601834755",
 *     "testimonial": "Texto do depoimento"
 *   }
 * }
 *
 * Protegido por x-api-key (TEST_LOG_API_KEY).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";

export const runtime = "nodejs";
export const maxDuration = 300;

const META_API_VERSION = "v25.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ── Rate limit ──
let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 500) await new Promise((r) => setTimeout(r, 500 - diff));
  lastCall = Date.now();
}

// ── G8: metaFetch com retry para rate limit (código 17) ──
async function metaFetch<T>(url: string, options?: RequestInit, retries = 4): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(60000, 5000 * Math.pow(2, attempt - 1)); // 5s, 10s, 20s, 40s
      console.warn(`[PublishToAdSets] Rate limit retry ${attempt}/${retries} — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok || (data as Record<string, unknown>).error) {
      const err = (data as Record<string, unknown>).error as Record<string, unknown> | undefined;
      // G8: detecta rate limit (código 17) e retenta
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

// ── Interfaces ──

interface AdSpec {
  name: string;
  image_base64?: string;   // G5: opcional se image_hash fornecido
  image_hash?: string;     // G5: alternativa a image_base64
  image_filename: string;
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

  return {
    link,
    pageId,
    instagramUserId,
    accountId: accountId.startsWith("act_") ? accountId : `act_${accountId}`,
    urlTags,
    displayLink,
  };
}

async function fetchAdSets(campaignId: string, token: string): Promise<Array<{ id: string; name: string; status: string }>> {
  await rateLimit();
  const data = await metaFetch<{ data: Array<{ id: string; name: string; status: string }> }>(
    `${META_BASE_URL}/${campaignId}/adsets?fields=id,name,status&limit=50&access_token=${token}`
  );
  return data.data || [];
}

// G5: uploadImage agora só é chamada se image_base64 fornecido
async function uploadImage(accountId: string, imageBuffer: Buffer, filename: string, token: string): Promise<{ hash: string }> {
  await rateLimit();
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

// G3: Clone adset
async function copyAdset(sourceAdsetId: string, newName: string, dailyBudgetCents: number, token: string): Promise<string> {
  await rateLimit();
  const data = await metaFetch<{ copied_adset_id?: string; ad_object_ids?: Array<{ copied_ad_object_id: string }> }>(
    `${META_BASE_URL}/${sourceAdsetId}/copies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        deep_copy: "false",
        status_option: "PAUSED",
        access_token: token,
      }),
    }
  );
  const newId = data.copied_adset_id || data.ad_object_ids?.[0]?.copied_ad_object_id || "";
  if (!newId) throw new Error("Adset copy returned no id: " + JSON.stringify(data));

  // Rename + budget
  await rateLimit();
  await metaFetch(
    `${META_BASE_URL}/${newId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        name: newName,
        daily_budget: String(dailyBudgetCents),
        access_token: token,
      }),
    }
  );
  console.log(`[PublishToAdSets] G3: cloned adset ${sourceAdsetId} → ${newId} (${newName})`);
  return newId;
}

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
  partnership?: PartnershipSpec;
  token: string;
}): Promise<{ id: string }> {
  await rateLimit();
  const {
    accountId, name, pageId, instagramUserId,
    imageHash, body: bodyText, title, description, link, ctaType, urlTags,
    displayLink, partnership, token,
  } = params;

  const linkData: Record<string, unknown> = {
    image_hash: imageHash,
    link,
    message: bodyText,
    name: title,
    description,
    call_to_action: { type: ctaType, value: { link } },
  };
  if (displayLink) linkData.caption = displayLink;

  const objectStorySpec: Record<string, unknown> = { page_id: pageId, link_data: linkData };
  if (instagramUserId) objectStorySpec.instagram_user_id = instagramUserId;

  const formParams: Record<string, string> = {
    name,
    object_story_spec: JSON.stringify(objectStorySpec),
    access_token: token,
  };
  if (urlTags) formParams.url_tags = urlTags;

  if (partnership?.sponsor_id) {
    formParams.instagram_branded_content = JSON.stringify({ sponsor_id: partnership.sponsor_id });
    const brandedContent: Record<string, unknown> = { ad_format: 1 };
    if (partnership.testimonial) brandedContent.testimonial = partnership.testimonial;
    formParams.branded_content = JSON.stringify(brandedContent);
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

async function createAd(params: {
  accountId: string;
  adSetId: string;
  creativeId: string;
  name: string;
  token: string;
}): Promise<{ id: string }> {
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
        status: "ACTIVE",
        access_token: params.token,
      }),
    }
  );
  return { id: data.id };
}

// ── Main Handler ──

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();

    const {
      campaign_id,
      model_ad_id,
      // G9: campos diretos sem model_ad
      page_id: directPageId,
      instagram_user_id: directInstagramUserId,
      account_id: directAccountId,
      // G1: link override
      link: linkOverride,
      // G2: filtro de adsets
      adset_ids: adsetIdsFilter,
      // G3: clone adset
      source_adset_id,
      new_adset_name,
      daily_budget_cents,
      ads,
      partnership,
    } = body as {
      campaign_id: string;
      model_ad_id?: string;
      page_id?: string;
      instagram_user_id?: string;
      account_id?: string;
      link?: string;
      adset_ids?: string[];
      source_adset_id?: string;
      new_adset_name?: string;
      daily_budget_cents?: number;
      ads: AdSpec[];
      partnership?: PartnershipSpec;
    };

    // G9: model_ad_id OR (page_id + instagram_user_id + account_id) obrigatório
    const hasDirectFields = directPageId && directInstagramUserId && directAccountId;
    if (!model_ad_id && !hasDirectFields) {
      return NextResponse.json(
        { error: "model_ad_id OR (page_id + instagram_user_id + account_id) are required" },
        { status: 400 }
      );
    }
    if (!campaign_id && !source_adset_id) {
      return NextResponse.json(
        { error: "campaign_id or source_adset_id is required" },
        { status: 400 }
      );
    }
    if (!ads || ads.length === 0) {
      return NextResponse.json({ error: "ads[] is required and must not be empty" }, { status: 400 });
    }

    const token = await getTokenForWorkspace(auth.workspace_id);

    // 1. Obter info do modelo (G9: direto se fornecido, G1: override link)
    let modelAd: ModelAdInfo;
    if (hasDirectFields) {
      const accountId = directAccountId!.startsWith("act_") ? directAccountId! : `act_${directAccountId!}`;
      modelAd = {
        link: linkOverride || "",
        pageId: directPageId!,
        instagramUserId: directInstagramUserId!,
        accountId,
        urlTags: "",
        displayLink: linkOverride ? new URL(linkOverride).hostname : "",
      };
      console.log(`[PublishToAdSets] G9: usando campos diretos page=${modelAd.pageId}, ig=${modelAd.instagramUserId}`);
    } else {
      console.log(`[PublishToAdSets] Fetching model ad ${model_ad_id}...`);
      modelAd = await fetchModelAd(model_ad_id!, token);
      // G1: override link se fornecido
      if (linkOverride) {
        console.log(`[PublishToAdSets] G1: link override: ${modelAd.link} → ${linkOverride}`);
        modelAd.link = linkOverride;
        try { modelAd.displayLink = new URL(linkOverride).hostname; } catch { /* ignore */ }
      }
    }
    console.log(`[PublishToAdSets] Model: link=${modelAd.link}, page=${modelAd.pageId}, account=${modelAd.accountId}`);

    // 2. Determinar adsets alvo
    let targetAdSets: Array<{ id: string; name: string; status: string }>;

    if (source_adset_id && new_adset_name) {
      // G3: Clonar novo adset
      const budget = daily_budget_cents ?? 50000;
      const newAdsetId = await copyAdset(source_adset_id, new_adset_name, budget, token);
      targetAdSets = [{ id: newAdsetId, name: new_adset_name, status: "PAUSED" }];
    } else {
      // Buscar adsets da campanha
      console.log(`[PublishToAdSets] Fetching ad sets for campaign ${campaign_id}...`);
      const allAdSets = await fetchAdSets(campaign_id!, token);
      console.log(`[PublishToAdSets] Found ${allAdSets.length} ad sets`);

      // G2: filtrar se adset_ids fornecido
      if (adsetIdsFilter && adsetIdsFilter.length > 0) {
        targetAdSets = allAdSets.filter((s) => adsetIdsFilter.includes(s.id));
        console.log(`[PublishToAdSets] G2: filtered to ${targetAdSets.length} adsets (from ${adsetIdsFilter.length} requested)`);
      } else {
        targetAdSets = allAdSets;
      }
    }

    if (targetAdSets.length === 0) {
      return NextResponse.json({ error: "No target ad sets found" }, { status: 400 });
    }

    console.log(`[PublishToAdSets] Publishing ${ads.length} ads to ${targetAdSets.length} adsets`);

    // 3. Publicar cada ad em cada adset
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
        // G5: usar image_hash diretamente OU fazer upload de image_base64
        let imageHash: string;
        if (ad.image_hash) {
          imageHash = ad.image_hash;
          console.log(`[PublishToAdSets] G5: usando image_hash=${imageHash} (sem upload)`);
        } else if (ad.image_base64) {
          const imageBuffer = Buffer.from(ad.image_base64, "base64");
          console.log(`[PublishToAdSets] Uploading ${ad.image_filename} (${imageBuffer.length} bytes)...`);
          const upload = await uploadImage(modelAd.accountId, imageBuffer, ad.image_filename, token);
          imageHash = upload.hash;
          console.log(`[PublishToAdSets] Uploaded: hash=${imageHash}`);
        } else {
          throw new Error(`Ad ${ad.name}: neither image_hash nor image_base64 provided`);
        }
        adResult.image_hash = imageHash;

        // Criar creative
        const creative = await createCreativeSingleImage({
          accountId: modelAd.accountId,
          name: ad.name,
          pageId: modelAd.pageId,
          instagramUserId: modelAd.instagramUserId,
          imageHash,
          body: ad.body,
          title: ad.title,
          description: ad.description,
          link: modelAd.link,
          ctaType: ad.cta_type,
          urlTags: modelAd.urlTags,
          displayLink: modelAd.displayLink,
          partnership,
          token,
        });
        adResult.creative_id = creative.id;
        console.log(`[PublishToAdSets] Creative: ${creative.id}`);

        // Criar ad em cada adset alvo
        for (const adSet of targetAdSets) {
          try {
            const adCreated = await createAd({
              accountId: modelAd.accountId,
              adSetId: adSet.id,
              creativeId: creative.id,
              name: ad.name,
              token,
            });
            adResult.ads_created.push({ ad_id: adCreated.id, adset_id: adSet.id, adset_name: adSet.name });
            console.log(`[PublishToAdSets] Ad ${adCreated.id} → adset ${adSet.name}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            adResult.errors.push(`Failed in adset ${adSet.id}: ${msg}`);
            console.error(`[PublishToAdSets] FAILED in adset ${adSet.id}:`, msg);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        adResult.errors.push(msg);
        console.error(`[PublishToAdSets] FAILED ${ad.name}:`, msg);
      }

      results.push(adResult);
    }

    const totalAdsCreated = results.reduce((sum, r) => sum + r.ads_created.length, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    return NextResponse.json({
      campaign_id: campaign_id || null,
      model_ad_id: model_ad_id || null,
      ad_sets: targetAdSets.map((s) => ({ id: s.id, name: s.name, status: s.status })),
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
