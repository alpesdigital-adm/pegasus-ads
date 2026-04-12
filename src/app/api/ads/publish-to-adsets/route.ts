/**
 * POST /api/ads/publish-to-adsets
 *
 * Publica criativos em ad sets de uma campanha, usando um ad modelo
 * como referência para link, page_id, instagram_user_id, etc.
 *
 * COMPORTAMENTO DE PAREAMENTO F/S (G10):
 * Quando dois ads têm o mesmo nome base com sufixo F (Feed) e S (Stories),
 * eles são automaticamente agrupados em UM único ad onde:
 *   - A imagem F é usada no placement Feed
 *   - A imagem S é usada no placement Stories (via placement_customizations)
 * Exemplo: "T4EBANP-AD01F" + "T4EBANP-AD01S" → um ad "T4EBANP-AD01"
 *
 * TESTIMONIAL AUTO (G11):
 * Quando partnership.sponsor_id está set mas partnership.testimonial está vazio,
 * um testimonial persuasivo é gerado automaticamente com base no conteúdo do ad.
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
 *   "source_adset_id": "...",              // G3: se fornecido, clona novo adset
 *   "new_adset_name": "...",               // G3: nome do novo adset clonado
 *   "daily_budget_cents": 50000,           // G3: orçamento do novo adset
 *   "ads": [
 *     {
 *       "name": "T4EBANP-AD01F",           // sufixo F = Feed
 *       "image_hash": "abc123...",          // G5: alternativa a image_base64
 *       "image_base64": "iVBOR...",
 *       "image_filename": "T4EBANP-AD01F.png",
 *       "body": "Texto principal...",
 *       "title": "Headline...",
 *       "description": "",
 *       "cta_type": "DOWNLOAD"
 *     },
 *     {
 *       "name": "T4EBANP-AD01S",           // sufixo S = Stories — será pareado com AD01F
 *       "image_hash": "def456...",
 *       "image_filename": "T4EBANP-AD01S.png",
 *       ...
 *     }
 *   ],
 *   "partnership": {
 *     "sponsor_id": "17841400601834755",
 *     "testimonial": ""                     // G11: auto-gerado se vazio
 *   }
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
      const wait = Math.min(60000, 5000 * Math.pow(2, attempt - 1));
      console.warn(`[PublishToAdSets] Rate limit retry ${attempt}/${retries} — waiting ${wait}ms`);
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

// ── Interfaces ──

interface AdSpec {
  name: string;
  image_base64?: string;
  image_hash?: string;     // G5: alternativa a image_base64
  image_filename: string;
  body: string;
  title: string;
  description: string;
  cta_type: string;
}

interface PartnershipSpec {
  sponsor_id: string;
  testimonial?: string;    // G11: auto-gerado se vazio
}

interface ModelAdInfo {
  link: string;
  pageId: string;
  instagramUserId: string;
  accountId: string;
  urlTags: string;
  displayLink: string;
}

// ── G10: Agrupamento de imagens F/S em pares ──

interface AdGroup {
  name: string;       // Nome base sem sufixo F/S
  feed?: AdSpec;      // Imagem Feed (sufixo F)
  stories?: AdSpec;   // Imagem Stories (sufixo S)
  single?: AdSpec;    // Imagem sem par (sem sufixo F/S)
}

/**
 * Detecta pares F/S e agrupa em AdGroup.
 * Qualquer nome terminando em maiúsculo F ou S é candidato a par.
 * Pares com o mesmo nome base (sem o sufixo) são agrupados.
 * Imagens sem sufixo F/S ficam como single.
 */
function groupAdsByPlacement(ads: AdSpec[]): AdGroup[] {
  const groups = new Map<string, AdGroup>();

  for (const ad of ads) {
    // Detecta sufixo F ou S no final do nome (case-sensitive)
    const match = ad.name.match(/^(.+?)([FS])$/);
    if (match) {
      const baseName = match[1];
      const placement = match[2] as "F" | "S";

      if (!groups.has(baseName)) {
        groups.set(baseName, { name: baseName });
      }
      const group = groups.get(baseName)!;
      if (placement === "F") {
        group.feed = ad;
      } else {
        group.stories = ad;
      }
    } else {
      // Sem sufixo F/S — ad individual
      groups.set(ad.name, { name: ad.name, single: ad });
    }
  }

  return Array.from(groups.values());
}

// ── G11: Auto-testimonial ──

/**
 * Gera testimonial persuasivo baseado no conteúdo do ad.
 * Chamado quando partnership.sponsor_id está set mas testimonial está vazio.
 */
function generateTestimonial(body: string, title: string): string {
  const combined = (body + " " + title).toLowerCase();

  if (combined.includes("anamnese") || combined.includes("diagnóst") || combined.includes("paciente capilar")) {
    return "Esse guia mudou a qualidade da minha anamnese capilar. Não consigo guardar isso só pra mim.";
  }
  if (combined.includes("minoxidil") || combined.includes("prescrever") || combined.includes("posologia")) {
    return "Prescrevemos Minoxidil todo dia — esse guia organiza o que a faculdade nunca ensinou de forma prática.";
  }
  if (combined.includes("tricolog") || combined.includes("capilar") || combined.includes("protocolo")) {
    return "Esse é o tipo de material que eu gostaria de ter tido no início da minha prática. Acesso gratuito enquanto dura.";
  }
  if (combined.includes("gratuit") || combined.includes("grátis") || combined.includes("ebook") || combined.includes("guia")) {
    return "Nem acredito que esse conteúdo está gratuito. Baixa agora — você vai entender por quê quando ver o material.";
  }
  if (combined.includes("formação") || combined.includes("curso") || combined.includes("aula")) {
    return "Me convenceram a liberar esse material da formação. Oportunidade única — não vai durar muito.";
  }
  // Default persuasivo genérico
  return "Tem ouro nesse material. Fico feliz de poder disponibilizar gratuitamente para colegas.";
}

// ── Helpers Meta ──

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
    link, pageId, instagramUserId,
    accountId: accountId.startsWith("act_") ? accountId : `act_${accountId}`,
    urlTags, displayLink,
  };
}

async function fetchAdSets(campaignId: string, token: string): Promise<Array<{ id: string; name: string; status: string }>> {
  await rateLimit();
  const data = await metaFetch<{ data: Array<{ id: string; name: string; status: string }> }>(
    `${META_BASE_URL}/${campaignId}/adsets?fields=id,name,status&limit=50&access_token=${token}`
  );
  return data.data || [];
}

async function resolveImageHash(ad: AdSpec, accountId: string, token: string): Promise<string> {
  // G5: usa hash diretamente se fornecido
  if (ad.image_hash) {
    return ad.image_hash;
  }
  if (!ad.image_base64) {
    throw new Error(`Ad ${ad.name}: neither image_hash nor image_base64 provided`);
  }
  await rateLimit();
  const imageBuffer = Buffer.from(ad.image_base64, "base64");
  const data = await metaFetch<{ images: Record<string, { hash: string }> }>(
    `${META_BASE_URL}/${accountId}/adimages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ access_token: token, filename: ad.image_filename, bytes: imageBuffer.toString("base64") }),
    }
  );
  const imageInfo = Object.values(data.images)[0];
  if (!imageInfo?.hash) throw new Error(`Image upload failed for ${ad.image_filename}`);
  return imageInfo.hash;
}

// G3: Clone adset
async function copyAdset(sourceAdsetId: string, newName: string, dailyBudgetCents: number, token: string, destinationCampaignId?: string): Promise<string> {
  await rateLimit();
  const copyParams: Record<string, string> = { deep_copy: "false", status_option: "PAUSED", access_token: token };
  if (destinationCampaignId) {
    copyParams.campaign_id = destinationCampaignId;
  }
  const data = await metaFetch<{ copied_adset_id?: string; ad_object_ids?: Array<{ copied_ad_object_id: string }> }>(
    `${META_BASE_URL}/${sourceAdsetId}/copies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(copyParams),
    }
  );
  const newId = data.copied_adset_id || data.ad_object_ids?.[0]?.copied_ad_object_id || "";
  if (!newId) throw new Error("Adset copy returned no id: " + JSON.stringify(data));

  await rateLimit();
  await metaFetch(
    `${META_BASE_URL}/${newId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ name: newName, daily_budget: String(dailyBudgetCents), access_token: token }),
    }
  );
  console.log(`[PublishToAdSets] G3: cloned adset ${sourceAdsetId} → ${newId} (${newName}) ${destinationCampaignId ? `into campaign ${destinationCampaignId}` : "(same campaign)"}`);
  return newId;
}

/**
 * Cria creative de imagem (Feed base) via object_story_spec.
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
  partnership?: PartnershipSpec;
  resolvedTestimonial: string;
  token: string;
}): Promise<{ id: string }> {
  await rateLimit();
  const {
    accountId, name, pageId, instagramUserId,
    imageHash, body: bodyText, title, description, link, ctaType, urlTags,
    displayLink, partnership, resolvedTestimonial, token,
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
    if (resolvedTestimonial) brandedContent.testimonial = resolvedTestimonial;
    formParams.branded_content = JSON.stringify(brandedContent);
    console.log(`[PublishToAdSets] Partnership: sponsor=${partnership.sponsor_id} testimonial="${resolvedTestimonial}"`);
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

/**
 * G10: Cria ad com placement_customizations quando há imagem Stories.
 * O creative base usa a imagem Feed (F).
 * A imagem Stories (S) é passada via placement_customizations.story.image_hash.
 */
async function createAd(params: {
  accountId: string;
  adSetId: string;
  creativeId: string;
  name: string;
  storiesImageHash?: string;  // G10: override para placement Stories
  token: string;
}): Promise<{ id: string }> {
  await rateLimit();

  const creativePayload: Record<string, unknown> = {
    creative_id: params.creativeId,
  };

  // G10: Se há imagem Stories, adiciona placement_customizations
  if (params.storiesImageHash) {
    creativePayload.placement_customizations = {
      story: {
        image_hash: params.storiesImageHash,
      },
    };
    console.log(`[PublishToAdSets] G10: Stories placement_customizations.story.image_hash=${params.storiesImageHash}`);
  }

  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${params.accountId}/ads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        name: params.name,
        adset_id: params.adSetId,
        creative: JSON.stringify(creativePayload),
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
      page_id: directPageId,
      instagram_user_id: directInstagramUserId,
      account_id: directAccountId,
      link: linkOverride,
      adset_ids: adsetIdsFilter,
      source_adset_id,
      new_adset_name,
      daily_budget_cents,
      ads,
      partnership,
    } = body as {
      campaign_id?: string;
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

    const hasDirectFields = directPageId && directInstagramUserId && directAccountId;
    if (!model_ad_id && !hasDirectFields) {
      return NextResponse.json(
        { error: "model_ad_id OR (page_id + instagram_user_id + account_id) are required" },
        { status: 400 }
      );
    }
    if (!campaign_id && !source_adset_id) {
      return NextResponse.json({ error: "campaign_id or source_adset_id is required" }, { status: 400 });
    }
    if (!ads || ads.length === 0) {
      return NextResponse.json({ error: "ads[] is required and must not be empty" }, { status: 400 });
    }

    const token = await getTokenForWorkspace(auth.workspace_id);

    // G11: Resolver testimonial antes de qualquer publicação
    let resolvedTestimonial = partnership?.testimonial || "";
    if (partnership?.sponsor_id && !resolvedTestimonial) {
      // Usa body/title do primeiro ad como referência para gerar testimonial
      const refAd = ads[0];
      resolvedTestimonial = generateTestimonial(refAd.body || "", refAd.title || "");
      console.log(`[PublishToAdSets] G11: auto-testimonial="${resolvedTestimonial}"`);
    }

    // 1. Obter model ad info (G9: direto se fornecido)
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
    } else {
      modelAd = await fetchModelAd(model_ad_id!, token);
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
      const budget = daily_budget_cents ?? 50000;
      const newAdsetId = await copyAdset(source_adset_id, new_adset_name, budget, token, campaign_id || undefined);
      targetAdSets = [{ id: newAdsetId, name: new_adset_name, status: "PAUSED" }];
    } else {
      const allAdSets = await fetchAdSets(campaign_id!, token);
      targetAdSets = (adsetIdsFilter && adsetIdsFilter.length > 0)
        ? allAdSets.filter((s) => adsetIdsFilter.includes(s.id))
        : allAdSets;
      console.log(`[PublishToAdSets] G2: ${targetAdSets.length}/${allAdSets.length} adsets targetados`);
    }

    if (targetAdSets.length === 0) {
      return NextResponse.json({ error: "No target ad sets found" }, { status: 400 });
    }

    // G10: Agrupar ads por pares F/S
    const adGroups = groupAdsByPlacement(ads);
    const pairedCount = adGroups.filter((g) => g.feed && g.stories).length;
    const singleCount = adGroups.filter((g) => !g.feed || !g.stories).length;
    console.log(`[PublishToAdSets] G10: ${adGroups.length} ad groups (${pairedCount} paired F+S, ${singleCount} single)`);

    // 3. Publicar cada grupo em cada adset
    const results: Array<{
      ad_name: string;
      paired: boolean;
      creative_id: string;
      feed_hash: string;
      stories_hash: string;
      ads_created: Array<{ ad_id: string; adset_id: string; adset_name: string }>;
      errors: string[];
    }> = [];

    for (const group of adGroups) {
      // Determinar spec do ad base (Feed tem prioridade, depois single)
      const baseSpec = group.feed || group.single!;
      const isPaired = !!(group.feed && group.stories);

      console.log(`[PublishToAdSets] Processing "${group.name}" (paired=${isPaired})...`);
      const adResult = {
        ad_name: group.name,
        paired: isPaired,
        creative_id: "",
        feed_hash: "",
        stories_hash: "",
        ads_created: [] as Array<{ ad_id: string; adset_id: string; adset_name: string }>,
        errors: [] as string[],
      };

      try {
        // Resolver hash(es) de imagem
        const feedHash = await resolveImageHash(baseSpec, modelAd.accountId, token);
        adResult.feed_hash = feedHash;
        console.log(`[PublishToAdSets] Feed hash: ${feedHash}`);

        let storiesHash = "";
        if (isPaired && group.stories) {
          storiesHash = await resolveImageHash(group.stories, modelAd.accountId, token);
          adResult.stories_hash = storiesHash;
          console.log(`[PublishToAdSets] Stories hash: ${storiesHash}`);
        }

        // Criar creative com imagem Feed (base)
        const creative = await createCreativeSingleImage({
          accountId: modelAd.accountId,
          name: group.name,
          pageId: modelAd.pageId,
          instagramUserId: modelAd.instagramUserId,
          imageHash: feedHash,
          body: baseSpec.body,
          title: baseSpec.title,
          description: baseSpec.description,
          link: modelAd.link,
          ctaType: baseSpec.cta_type,
          urlTags: modelAd.urlTags,
          displayLink: modelAd.displayLink,
          partnership,
          resolvedTestimonial,
          token,
        });
        adResult.creative_id = creative.id;
        console.log(`[PublishToAdSets] Creative: ${creative.id}`);

        // Criar ad em cada adset com placement_customizations (G10) se pareado
        for (const adSet of targetAdSets) {
          try {
            const adCreated = await createAd({
              accountId: modelAd.accountId,
              adSetId: adSet.id,
              creativeId: creative.id,
              name: group.name,
              storiesImageHash: storiesHash || undefined,
              token,
            });
            adResult.ads_created.push({ ad_id: adCreated.id, adset_id: adSet.id, adset_name: adSet.name });
            console.log(`[PublishToAdSets] Ad ${adCreated.id} → ${adSet.name}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            adResult.errors.push(`Failed in adset ${adSet.id}: ${msg}`);
            console.error(`[PublishToAdSets] FAILED adset ${adSet.id}:`, msg);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        adResult.errors.push(msg);
        console.error(`[PublishToAdSets] FAILED ${group.name}:`, msg);
      }

      results.push(adResult);
    }

    const totalAdsCreated = results.reduce((sum, r) => sum + r.ads_created.length, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    return NextResponse.json({
      campaign_id: campaign_id || null,
      model_ad_id: model_ad_id || null,
      ad_sets: targetAdSets.map((s) => ({ id: s.id, name: s.name, status: s.status })),
      partnership_testimonial: resolvedTestimonial || null,
      total_ad_groups: adGroups.length,
      paired_groups: pairedCount,
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
