// Registry de handlers da Staging Queue v2.
// Spec: docs/staging-queue-v2.md §8.
//
// Cada handler recebe (input, workspaceId) e retorna outputData. Sem side
// effects no banco local além do estritamente necessário (load_context
// muta test_rounds.status='publishing' no início; persist_results escreve
// no final). O worker cuida da escrita em publication_steps/events.
//
// Multi-tenancy: usa dbAdmin (BYPASSRLS) + filtro manual de workspace em
// queries que retornam dados (pattern CRM validado).
//
// Idempotência: handlers que fazem POST na Meta seguem estratégia:
//  - upload_image: re-upload é seguro (mesmo hash retornado, sem duplicata
//    de custo). Accept retry.
//  - create_ad_label: GET-before-POST (nome único na conta).
//  - create_creative/adset/ad: ainda não têm verify — retry pode criar
//    duplicata (<1/mês). Reconciliation semanal (Fase 5) cobre.
//
// FASE 2A (este arquivo): load_context + upload_image + create_ad_label.
// Demais handlers reais virão em commits incrementais.

import { dbAdmin } from "@/lib/db";
import {
  testRounds,
  testRoundVariants,
  publishedAds as publishedAdsTable,
  creatives as creativesTable,
  publicationSteps,
} from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as meta from "@/lib/meta";
import {
  verifyPrePublish as runVerifyPrePublish,
  verifyPostPublish as runVerifyPostPublish,
} from "@/lib/ai-verify";
import { generateMetaAdName } from "@/lib/creative-naming";
import { UTM_TEMPLATE } from "@/config/campaigns";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "staging-queue/handlers" });

export type StepHandler = (
  input: Record<string, unknown>,
  workspaceId: string,
) => Promise<Record<string, unknown>>;

// ─── Shapes compartilhados ────────────────────────────────────────────────

interface VariantPair {
  adName: string;
  adNumber: number;
  feed?: { variantId: string; creativeId: string; blobUrl: string };
  stories?: { variantId: string; creativeId: string; blobUrl: string };
}

interface AdSetTemplate {
  name: string;
  dailyBudgetCents: string;
  bidStrategy: string;
  billingEvent: string;
  optimizationGoal: string;
  targeting: Record<string, unknown>;
  promotedObject: Record<string, unknown>;
}

interface AdContent {
  body: string;
  title: string;
  link: string;
  callToAction: string;
}

// ─── load_context ─────────────────────────────────────────────────────────
/**
 * Root step do DAG pro batch type 'test_round_publish'.
 *
 * Input:  { testRoundId: string }
 * Output: {
 *   testRoundId, metaCampaignId, accountId, pageId, instagramUserId,
 *   variantPairs: VariantPair[],
 *   adSetTemplate: AdSetTemplate,
 *   adContent: AdContent,
 *   urlTags: string,
 * }
 *
 * Responsabilidades:
 *  1. Carregar test_round + campaign (SELECT dbAdmin + filter workspace)
 *  2. Carregar variantes (variant role, status generated|verified)
 *  3. Buscar adSetTemplate na Meta (primeiro ad set ACTIVE da campanha)
 *  4. Resolver ad content via fallback (DB config → Meta API → cache write).
 *     Faz parte desse step pra falhar rápido (step 0) antes de upload/create.
 *  5. Mutar test_rounds.status='publishing'.
 *
 * Side-effects:
 *  - UPDATE test_rounds SET status='publishing' (marca início do batch)
 *  - UPDATE campaigns SET config.ad_content (cache do fallback, só se Meta
 *    API foi consultada)
 */
async function handleLoadContext(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const testRoundId = input.testRoundId as string | undefined;
  if (!testRoundId) {
    throw new Error("META_VALIDATION: load_context requires testRoundId in input");
  }

  // 1. test_round + campaign (JOIN)
  const roundRes = await dbAdmin.execute<{
    id: string;
    workspace_id: string;
    campaign_id: string;
    status: string;
    ai_verification: unknown;
    meta_campaign_id: string;
    meta_account_id: string;
    page_id: string;
    instagram_user_id: string;
    config: unknown;
    cpl_target: unknown;
  }>(sql`
    SELECT tr.id, tr.workspace_id, tr.campaign_id, tr.status, tr.ai_verification,
           c.meta_campaign_id, c.meta_account_id, c.page_id, c.instagram_user_id,
           c.config, c.cpl_target
    FROM test_rounds tr
    JOIN campaigns c ON tr.campaign_id = c.id
    WHERE tr.id = ${testRoundId}
      AND tr.workspace_id = ${workspaceId}
    LIMIT 1
  `);
  if (roundRes.length === 0) {
    throw new Error(
      `load_context: test_round ${testRoundId} not found in workspace ${workspaceId}`,
    );
  }
  const round = roundRes[0];

  const metaCampaignId = round.meta_campaign_id;
  const accountId = round.meta_account_id;
  const pageId = round.page_id;
  const instagramUserId = round.instagram_user_id;
  const campaignConfig: Record<string, unknown> =
    typeof round.config === "string"
      ? JSON.parse(round.config)
      : ((round.config as Record<string, unknown>) ?? {});

  if (!metaCampaignId || !accountId || !pageId || !instagramUserId) {
    throw new Error(
      `META_VALIDATION: load_context — campaign ${round.campaign_id} missing meta_campaign_id/account_id/page_id/instagram_user_id`,
    );
  }

  // 2. variants (feed + stories rows)
  const variantRes = await dbAdmin.execute<{
    id: string;
    creative_id: string;
    placement: string;
    blob_url: string;
    creative_name: string;
  }>(sql`
    SELECT trv.id, trv.creative_id, trv.placement,
           cr.blob_url, cr.name AS creative_name
    FROM test_round_variants trv
    JOIN creatives cr ON trv.creative_id = cr.id
    JOIN test_rounds tr ON trv.test_round_id = tr.id
    WHERE trv.test_round_id = ${testRoundId}
      AND tr.workspace_id = ${workspaceId}
      AND trv.role = 'variant'
      AND trv.status IN ('generated', 'verified')
    ORDER BY cr.name
  `);

  if (variantRes.length === 0) {
    throw new Error(
      `META_VALIDATION: load_context — no variants found for test_round ${testRoundId} in status generated|verified`,
    );
  }

  const variantPairs = groupVariantsByAd(variantRes);
  if (variantPairs.length === 0) {
    throw new Error(
      `META_VALIDATION: load_context — variants present but zero VariantPairs after grouping (regex mismatch?)`,
    );
  }

  // 3. adSetTemplate (Meta API)
  const adSetTemplateRaw = await meta.getAdSetTemplate(metaCampaignId, workspaceId);
  if (!adSetTemplateRaw) {
    throw new Error(
      `META_VALIDATION: load_context — no ad set template found for campaign ${metaCampaignId}`,
    );
  }
  const adSetTemplate: AdSetTemplate = {
    name: String(adSetTemplateRaw.name ?? ""),
    dailyBudgetCents: String(
      campaignConfig.daily_budget ??
        adSetTemplateRaw.daily_budget ??
        "8000",
    ),
    bidStrategy: String(
      campaignConfig.bid_strategy ??
        adSetTemplateRaw.bid_strategy ??
        "LOWEST_COST_WITHOUT_CAP",
    ),
    billingEvent: String(adSetTemplateRaw.billing_event ?? "IMPRESSIONS"),
    optimizationGoal: String(
      adSetTemplateRaw.optimization_goal ?? "OFFSITE_CONVERSIONS",
    ),
    targeting: (adSetTemplateRaw.targeting as Record<string, unknown>) ?? {},
    promotedObject:
      (adSetTemplateRaw.promoted_object as Record<string, unknown>) ?? {},
  };

  // 4. ad content — DB config → Meta API → cache (moved from legacy pipeline)
  const adContent = await resolveAdContent(
    metaCampaignId,
    accountId,
    workspaceId,
    campaignConfig,
  );

  // 5. Muta status → 'publishing'
  await dbAdmin
    .update(testRounds)
    .set({ status: "publishing", updatedAt: sql`NOW()` })
    .where(eq(testRounds.id, testRoundId));

  log.info(
    {
      testRoundId,
      variantPairs: variantPairs.length,
      adSetTemplateName: adSetTemplate.name,
      dailyBudget: adSetTemplate.dailyBudgetCents,
    },
    "context loaded",
  );

  return {
    testRoundId,
    metaCampaignId,
    accountId,
    pageId,
    instagramUserId,
    variantPairs,
    adSetTemplate,
    adContent,
    urlTags: UTM_TEMPLATE,
  };
}

function groupVariantsByAd(
  rows: Array<{
    id: string;
    creative_id: string;
    placement: string;
    blob_url: string;
    creative_name: string;
  }>,
): VariantPair[] {
  const map = new Map<string, VariantPair>();

  for (const row of rows) {
    const matched = row.creative_name?.match(/AD(\d+)/i);
    if (!matched) continue;
    const adNumber = parseInt(matched[1], 10);
    const adName = generateMetaAdName(adNumber);

    if (!map.has(adName)) {
      map.set(adName, { adName, adNumber });
    }

    const pair = map.get(adName)!;
    const data = {
      variantId: row.id,
      creativeId: row.creative_id,
      blobUrl: row.blob_url,
    };

    if (row.placement === "feed") pair.feed = data;
    else if (row.placement === "stories") pair.stories = data;
  }

  // Remove pares incompletos (sem feed OU sem stories) — AdSetTemplate
  // espera ambos placements. Se faltar um, skip (evita criar ad quebrado).
  const complete: VariantPair[] = [];
  for (const pair of map.values()) {
    if (pair.feed && pair.stories) complete.push(pair);
    else {
      log.warn(
        { adName: pair.adName, hasFeed: !!pair.feed, hasStories: !!pair.stories },
        "incomplete variant pair skipped",
      );
    }
  }
  return complete;
}

async function resolveAdContent(
  metaCampaignId: string,
  accountId: string,
  workspaceId: string,
  campaignConfig: Record<string, unknown>,
): Promise<AdContent> {
  // 1. DB config (override manual, mais prioritário)
  const cached = campaignConfig.ad_content as AdContent | undefined;
  if (cached?.link && cached?.body && cached?.title) {
    log.info("using ad_content from campaign config (DB)");
    return {
      body: cached.body,
      title: cached.title,
      link: cached.link,
      callToAction: cached.callToAction ?? "LEARN_MORE",
    };
  }

  // 2. Meta API
  log.info({ metaCampaignId }, "fetching ad content from meta api");
  const metaContent = await meta.getAdContentFromCampaign(
    metaCampaignId,
    workspaceId,
  );
  if (!metaContent?.link || !metaContent?.body || !metaContent?.title) {
    throw new Error(
      `META_VALIDATION: No ad content (body/title/link) for campaign ${metaCampaignId}. ` +
        `Configure ad_content in campaign.config or ensure the campaign has at least one ACTIVE ad with creative content.`,
    );
  }

  // 3. Cache write (best-effort — falha de cache não derruba o step)
  try {
    await dbAdmin.execute(sql`
      UPDATE campaigns SET config = jsonb_set(
        COALESCE(config::jsonb, '{}'::jsonb),
        '{ad_content}',
        ${JSON.stringify(metaContent)}::jsonb
      )
      WHERE meta_campaign_id = ${metaCampaignId}
        AND meta_account_id = ${accountId}
    `);
    log.info("cached ad_content in campaign.config");
  } catch (err) {
    log.warn({ err }, "failed to cache ad_content (non-fatal)");
  }

  return {
    body: metaContent.body,
    title: metaContent.title,
    link: metaContent.link,
    callToAction: metaContent.callToAction ?? "LEARN_MORE",
  };
}

// ─── upload_image ─────────────────────────────────────────────────────────
/**
 * Input:  { accountId, blobUrl, filename }
 * Output: { imageHash, imageUrl, metaEntityId: imageHash }
 *
 * Idempotência: Meta retorna o MESMO hash pra mesma imagem (dedup server-side
 * por bytes). Re-upload não gera custo nem duplicata. Accept retry.
 */
async function handleUploadImage(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const accountId = input.accountId as string | undefined;
  const blobUrl = input.blobUrl as string | undefined;
  const filename = input.filename as string | undefined;

  if (!accountId || !blobUrl || !filename) {
    throw new Error(
      "META_VALIDATION: upload_image requires accountId, blobUrl, filename",
    );
  }

  const response = await fetch(blobUrl);
  if (!response.ok) {
    throw new Error(
      `upload_image: blob fetch failed ${response.status} ${blobUrl}`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const result = await meta.uploadImage(accountId, buffer, filename, workspaceId);

  log.info({ filename, hash: result.hash }, "image uploaded");

  return {
    imageHash: result.hash,
    imageUrl: result.url,
    metaEntityId: result.hash,
    metaEntityType: "image",
  };
}

// ─── create_ad_label ──────────────────────────────────────────────────────
/**
 * Input:  { accountId, labelName }
 * Output: { labelId, labelName, metaEntityId: labelId }
 *
 * Idempotência via GET-before-POST: labels têm constraint UNIQUE(account, name)
 * na Meta. Se label com mesmo nome já existe (comum em retry), retorna o
 * existente sem criar duplicata.
 */
async function handleCreateAdLabel(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const accountId = input.accountId as string | undefined;
  const labelName = input.labelName as string | undefined;

  if (!accountId || !labelName) {
    throw new Error(
      "META_VALIDATION: create_ad_label requires accountId, labelName",
    );
  }

  // GET primeiro — busca labels da conta e filtra por nome exato
  const existing = await findAdLabelByName(accountId, labelName, workspaceId);
  if (existing) {
    log.info({ labelName, labelId: existing.id }, "reusing existing label");
    return {
      labelId: existing.id,
      labelName,
      metaEntityId: existing.id,
      metaEntityType: "label",
      reused: true,
    };
  }

  // Não existe — cria
  const created = await meta.createAdLabel(accountId, labelName, workspaceId);
  log.info({ labelName, labelId: created.id }, "label created");

  return {
    labelId: created.id,
    labelName,
    metaEntityId: created.id,
    metaEntityType: "label",
    reused: false,
  };
}

/**
 * Busca AdLabel por nome exato na conta. Retorna primeiro match ou null.
 * Ineficiente (lista até 500, filtra client-side) mas robusto e sem
 * endpoint de busca direta disponível na Graph API.
 */
async function findAdLabelByName(
  accountId: string,
  name: string,
  workspaceId: string,
): Promise<{ id: string; name: string } | null> {
  const token = await meta.getTokenForWorkspace(workspaceId, accountId);
  const params = new URLSearchParams({
    fields: "id,name",
    limit: "500",
    access_token: token,
  });
  const url = `https://graph.facebook.com/v22.0/${accountId}/adlabels?${params.toString()}`;

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) {
    const err = data.error;
    throw new Error(
      `Meta API Error ${err?.code}: ${err?.message ?? "unknown"} | GET adlabels`,
    );
  }

  const rows = (data.data ?? []) as Array<{ id: string; name: string }>;
  return rows.find((r) => r.name === name) ?? null;
}

// ─── verify_pre_publish ───────────────────────────────────────────────────
/**
 * Gate antes de uploads/creates. Reprova ads com naming inválido, imagens
 * ausentes, attribution/bid/targeting/promoted_object incompletos, budget
 * abaixo de R$5 (warning, não-crítico).
 *
 * Input: { adName, adSetName, feedImageReady, storiesImageReady,
 *          hasAttribution, hasBidStrategy, hasTargeting, hasPromotedObject,
 *          dailyBudgetCents }
 *         — tudo derivado pelo factory do load_context.output.adSetTemplate
 *           + do shape do VariantPair (feed+stories presentes = ready).
 *
 * Output: VerificationCheckpoint (passed, issues, suggestions, score).
 *
 * Se !passed → throw META_VALIDATION (non-retryable). Problema estrutural
 * (naming, falta de config) não muda em retry.
 */
async function handleVerifyPrePublish(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const adName = input.adName as string | undefined;
  const adSetName = input.adSetName as string | undefined;

  if (!adName || !adSetName) {
    throw new Error(
      "META_VALIDATION: verify_pre_publish requires adName, adSetName",
    );
  }

  const result = runVerifyPrePublish({
    adName,
    adSetName,
    feedImageReady: input.feedImageReady !== false,
    storiesImageReady: input.storiesImageReady !== false,
    hasAttribution: input.hasAttribution !== false,
    hasBidStrategy: !!input.hasBidStrategy,
    hasTargeting: !!input.hasTargeting,
    hasPromotedObject: !!input.hasPromotedObject,
    dailyBudgetCents: Number(input.dailyBudgetCents ?? 0) || undefined,
    campaignObjective: input.campaignObjective as string | undefined,
  });

  if (!result.passed) {
    throw new Error(
      `META_VALIDATION: pre_publish failed for ${adName} — ${result.issues.join("; ")}`,
    );
  }

  return {
    passed: true,
    score: result.score,
    issues: result.issues,
    suggestions: result.suggestions,
    verifiedAt: result.verified_at,
  };
}

// ─── create_creative ──────────────────────────────────────────────────────
/**
 * Cria creative Meta com asset_feed_spec (feed+stories customization rules).
 * Assinatura espelha meta.createCreative — estrutura validada em prod.
 *
 * Input (montado pelo factory via propagação do DAG):
 *   - accountId, pageId, instagramUserId  ← load_context
 *   - adName                               ← factory (nome do ad lógico)
 *   - feedImageHash                        ← upload_image feed (outputKey='imageHash')
 *   - storiesImageHash                     ← upload_image stories
 *   - feedLabelId                          ← create_ad_label feed (outputKey='labelId')
 *   - storiesLabelId                       ← create_ad_label stories
 *   - adContent: {body, title, link, callToAction}  ← load_context
 *   - urlTags                              ← load_context
 *
 * Output: { metaCreativeId, metaEntityId, metaEntityType='creative' }
 *
 * Idempotência: retry pode criar creative duplicado na Meta. Débito aceito
 * (<1/mês), reconciliation semanal cobre (Fase 5).
 */
async function handleCreateCreative(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const required = [
    "accountId",
    "pageId",
    "instagramUserId",
    "adName",
    "feedImageHash",
    "storiesImageHash",
    "feedLabelId",
    "storiesLabelId",
    "adContent",
  ];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`META_VALIDATION: create_creative requires ${key}`);
    }
  }

  const adContent = input.adContent as AdContent;
  if (!adContent.body || !adContent.title || !adContent.link) {
    throw new Error(
      "META_VALIDATION: create_creative.adContent must have body, title, link",
    );
  }

  const result = await meta.createCreative({
    accountId: input.accountId as string,
    workspaceId,
    name: input.adName as string,
    pageId: input.pageId as string,
    instagramUserId: input.instagramUserId as string,
    feedImageHash: input.feedImageHash as string,
    storiesImageHash: input.storiesImageHash as string,
    feedLabelId: input.feedLabelId as string,
    storiesLabelId: input.storiesLabelId as string,
    body: adContent.body,
    title: adContent.title,
    link: adContent.link,
    callToAction: adContent.callToAction,
    urlTags: (input.urlTags as string | undefined) ?? UTM_TEMPLATE,
  });

  log.info({ adName: input.adName, creativeId: result.id }, "creative created");

  return {
    metaCreativeId: result.id,
    metaEntityId: result.id,
    metaEntityType: "creative",
  };
}

// ─── create_adset ─────────────────────────────────────────────────────────
/**
 * Cria ad set Meta clonando adSetTemplate carregado pelo load_context.
 * Attribution fixa em 1d click (alinhado com lead campaigns).
 *
 * Status: sempre ACTIVE — ad set rodando permite que os ads filhos sirvam
 * quando ativados. O gate de atividade fica nos ads (via activationMode
 * do batch: after_all cria PAUSED, immediate cria ACTIVE).
 *
 * Input:
 *   - accountId, metaCampaignId  ← load_context
 *   - adSetTemplate              ← load_context (objeto consolidado)
 *
 * Output: { metaAdsetId, metaEntityId, metaEntityType='adset' }
 */
async function handleCreateAdSet(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const accountId = input.accountId as string | undefined;
  const metaCampaignId = input.metaCampaignId as string | undefined;
  const tpl = input.adSetTemplate as AdSetTemplate | undefined;

  if (!accountId || !metaCampaignId || !tpl) {
    throw new Error(
      "META_VALIDATION: create_adset requires accountId, metaCampaignId, adSetTemplate",
    );
  }

  const result = await meta.createAdSet({
    accountId,
    workspaceId,
    campaignId: metaCampaignId,
    name: tpl.name,
    dailyBudgetCents: tpl.dailyBudgetCents,
    bidStrategy: tpl.bidStrategy,
    billingEvent: tpl.billingEvent,
    optimizationGoal: tpl.optimizationGoal,
    targeting: tpl.targeting,
    promotedObject: tpl.promotedObject,
    attributionSpec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
    status: "ACTIVE",
  });

  log.info({ name: tpl.name, adSetId: result.id }, "ad set created");

  return {
    metaAdsetId: result.id,
    metaEntityId: result.id,
    metaEntityType: "adset",
  };
}

// ─── create_ad ────────────────────────────────────────────────────────────
/**
 * Cria ad na Meta vinculando adSet + creative. Status determinado por
 * activationMode do batch:
 *   - 'after_all' → PAUSED (activate_ads ativa em lote no fim, zero-spend
 *                   em cancelamento mid-batch)
 *   - 'immediate' → ACTIVE (comportamento legacy)
 *
 * Input:
 *   - accountId               ← load_context
 *   - adName                  ← factory (nome do ad lógico)
 *   - metaAdsetId             ← create_adset (outputKey='metaAdsetId')
 *   - metaCreativeId          ← create_creative
 *   - activationMode          ← factory (copiado do batch.activation_mode)
 *   - variantPairIndex        ← factory (índice pra persist_results correlacionar)
 *
 * Output: { metaAdId, metaEntityId, metaEntityType='ad', adName, status,
 *           variantPairIndex }
 */
async function handleCreateAd(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const accountId = input.accountId as string | undefined;
  const adName = input.adName as string | undefined;
  const metaAdsetId = input.metaAdsetId as string | undefined;
  const metaCreativeId = input.metaCreativeId as string | undefined;
  const activationMode =
    (input.activationMode as string | undefined) ?? "after_all";

  if (!accountId || !adName || !metaAdsetId || !metaCreativeId) {
    throw new Error(
      "META_VALIDATION: create_ad requires accountId, adName, metaAdsetId, metaCreativeId",
    );
  }

  const initialStatus: "PAUSED" | "ACTIVE" =
    activationMode === "immediate" ? "ACTIVE" : "PAUSED";

  const result = await meta.createAd({
    accountId,
    workspaceId,
    adSetId: metaAdsetId,
    creativeId: metaCreativeId,
    name: adName,
    status: initialStatus,
  });

  log.info(
    { adName, adId: result.id, initialStatus, activationMode },
    "ad created",
  );

  return {
    metaAdId: result.id,
    metaEntityId: result.id,
    metaEntityType: "ad",
    adName,
    status: initialStatus,
    variantPairIndex: input.variantPairIndex ?? null,
  };
}

// ─── activate_ads ─────────────────────────────────────────────────────────
/**
 * Ativa em lote todos os ads criados pelo batch (modo 'after_all').
 * Lista create_ad steps succeeded e chama Meta updateAdStatus('ACTIVE').
 *
 * Best-effort: falha individual de um ad não derruba o step — só zera o
 * batch inteiro se NENHUM ad conseguiu ativar (activate_ads.status='failed'
 * → test_rounds.status='failed' via finalizeBatch).
 *
 * Input: { batchId, accountId }
 * Output: { totalAds, activated, failed, failures: [{adId, error}] }
 */
async function handleActivateAds(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const batchId = input.batchId as string | undefined;
  if (!batchId) {
    throw new Error("META_VALIDATION: activate_ads requires batchId");
  }

  // Busca create_ad steps succeeded do batch (BYPASSRLS + filtro workspace)
  const adSteps = await dbAdmin
    .select({
      stepId: publicationSteps.id,
      outputData: publicationSteps.outputData,
    })
    .from(publicationSteps)
    .where(
      and(
        eq(publicationSteps.batchId, batchId),
        eq(publicationSteps.workspaceId, workspaceId),
        eq(publicationSteps.stepType, "create_ad"),
        eq(publicationSteps.status, "succeeded"),
      ),
    );

  if (adSteps.length === 0) {
    throw new Error(
      "activate_ads: no succeeded create_ad steps — nothing to activate",
    );
  }

  const failures: Array<{ adId: string; error: string }> = [];
  let activated = 0;

  for (const step of adSteps) {
    const output = (step.outputData ?? {}) as Record<string, unknown>;
    const adId = output.metaAdId as string | undefined;
    if (!adId) {
      failures.push({
        adId: String(step.stepId),
        error: "create_ad output missing metaAdId",
      });
      continue;
    }

    try {
      await meta.updateAdStatus(adId, "ACTIVE", workspaceId);
      activated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ adId, error: msg });
      log.warn({ adId, err: msg }, "activate_ads: ad failed to activate");
    }
  }

  log.info(
    { batchId, total: adSteps.length, activated, failed: failures.length },
    "activate_ads completed",
  );

  if (activated === 0) {
    throw new Error(
      `activate_ads: zero ads activated out of ${adSteps.length} — all failures: ${JSON.stringify(failures)}`,
    );
  }

  return {
    totalAds: adSteps.length,
    activated,
    failed: failures.length,
    failures,
  };
}

// ─── verify_post_publish ──────────────────────────────────────────────────
/**
 * Verifica pós-publicação: conta create_ad steps succeeded vs expected.
 *
 * Input:  { batchId, expectedCount }
 * Output: VerificationCheckpoint (passed, checks)
 *
 * Se !passed → throw META_VALIDATION (non-retryable: ads faltando não se
 * materializam em retry). Conservador — força batch a failed/partial.
 */
async function handleVerifyPostPublish(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const batchId = input.batchId as string | undefined;
  const expectedCount = Number(input.expectedCount ?? 0);
  if (!batchId || !expectedCount) {
    throw new Error(
      "META_VALIDATION: verify_post_publish requires batchId and expectedCount",
    );
  }

  const adSteps = await dbAdmin
    .select({
      stepId: publicationSteps.id,
      outputData: publicationSteps.outputData,
      status: publicationSteps.status,
    })
    .from(publicationSteps)
    .where(
      and(
        eq(publicationSteps.batchId, batchId),
        eq(publicationSteps.workspaceId, workspaceId),
        eq(publicationSteps.stepType, "create_ad"),
      ),
    );

  const succeeded = adSteps.filter((s) => s.status === "succeeded");
  const adsCreated = succeeded.map((s) => {
    const out = (s.outputData ?? {}) as Record<string, unknown>;
    return {
      adId: String(out.metaAdId ?? ""),
      adName: String(out.adName ?? ""),
      status: String(out.status ?? "UNKNOWN"),
    };
  });

  const result = runVerifyPostPublish({
    adsCreated,
    expectedCount,
  });

  if (!result.passed) {
    throw new Error(
      `META_VALIDATION: post_publish failed — ${result.issues.join("; ")}`,
    );
  }

  return {
    passed: true,
    score: result.score,
    issues: result.issues,
    suggestions: result.suggestions,
    adsVerified: adsCreated.length,
  };
}

// ─── persist_results ──────────────────────────────────────────────────────
/**
 * Step final: escreve os resultados do batch no banco local com atomicidade.
 * Espelha a Persistência do pipeline legacy (publish.ts:289-328) — testRoundVariants
 * marked como 'published' + publishedAds linha por feed/stories + creatives
 * status='testing'.
 *
 * Input: { testRoundId, batchId }
 * Side effects (transação dbAdmin):
 *   - UPDATE testRoundVariants SET metaAdId/metaAdsetId/metaCreativeId, status='published'
 *   - INSERT publishedAds (2 rows por pair: feed + stories)
 *   - UPDATE creatives SET status='testing'
 * Output: { variantsUpdated, publishedAdsInserted, creativesMarkedTesting }
 *
 * Reconstrução do contexto via queries nos steps do batch:
 *   - load_context → variantPairs + adSetTemplate.name
 *   - upload_image[feed/stories] (correlacionados por variantPairIndex) → imageHash
 *   - create_ad → metaAdId/metaCreativeId/variantPairIndex
 *   - create_adset → metaAdsetId (1 por pair)
 */
async function handlePersistResults(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const testRoundId = input.testRoundId as string | undefined;
  const batchId = input.batchId as string | undefined;
  if (!testRoundId || !batchId) {
    throw new Error(
      "META_VALIDATION: persist_results requires testRoundId and batchId",
    );
  }

  // 1. load_context — tira variantPairs + adSetTemplate.name
  const [loadStep] = await dbAdmin
    .select({ outputData: publicationSteps.outputData })
    .from(publicationSteps)
    .where(
      and(
        eq(publicationSteps.batchId, batchId),
        eq(publicationSteps.workspaceId, workspaceId),
        eq(publicationSteps.stepType, "load_context"),
        eq(publicationSteps.status, "succeeded"),
      ),
    )
    .limit(1);

  if (!loadStep) {
    throw new Error(
      "persist_results: load_context step not found or not succeeded",
    );
  }

  const loadOutput = (loadStep.outputData ?? {}) as Record<string, unknown>;
  const variantPairs = (loadOutput.variantPairs as VariantPair[]) ?? [];
  const adSetTemplate = loadOutput.adSetTemplate as AdSetTemplate | undefined;
  if (variantPairs.length === 0 || !adSetTemplate) {
    throw new Error(
      "persist_results: load_context output missing variantPairs or adSetTemplate",
    );
  }

  // 2. create_ad / create_adset / upload_image — indexados por variantPairIndex
  const [adSteps, adSetSteps, uploadSteps] = await Promise.all([
    dbAdmin
      .select({ inputData: publicationSteps.inputData, outputData: publicationSteps.outputData })
      .from(publicationSteps)
      .where(
        and(
          eq(publicationSteps.batchId, batchId),
          eq(publicationSteps.workspaceId, workspaceId),
          eq(publicationSteps.stepType, "create_ad"),
          eq(publicationSteps.status, "succeeded"),
        ),
      ),
    dbAdmin
      .select({ inputData: publicationSteps.inputData, outputData: publicationSteps.outputData })
      .from(publicationSteps)
      .where(
        and(
          eq(publicationSteps.batchId, batchId),
          eq(publicationSteps.workspaceId, workspaceId),
          eq(publicationSteps.stepType, "create_adset"),
          eq(publicationSteps.status, "succeeded"),
        ),
      ),
    dbAdmin
      .select({ inputData: publicationSteps.inputData, outputData: publicationSteps.outputData })
      .from(publicationSteps)
      .where(
        and(
          eq(publicationSteps.batchId, batchId),
          eq(publicationSteps.workspaceId, workspaceId),
          eq(publicationSteps.stepType, "upload_image"),
          eq(publicationSteps.status, "succeeded"),
        ),
      ),
  ]);

  // Indexa por variantPairIndex
  function indexByPair<T>(
    rows: Array<{ inputData: unknown; outputData: unknown }>,
    extract: (input: Record<string, unknown>, output: Record<string, unknown>) => T | null,
  ): Map<number, T> {
    const map = new Map<number, T>();
    for (const r of rows) {
      const inp = (r.inputData ?? {}) as Record<string, unknown>;
      const out = (r.outputData ?? {}) as Record<string, unknown>;
      const idx = inp.variantPairIndex as number | undefined;
      if (idx === undefined) continue;
      const value = extract(inp, out);
      if (value !== null) map.set(idx, value);
    }
    return map;
  }

  const adByPair = indexByPair(adSteps, (_, out) => {
    const id = out.metaAdId as string | undefined;
    return id ? { metaAdId: id } : null;
  });
  const adSetByPair = indexByPair(adSetSteps, (_, out) => {
    const id = out.metaAdsetId as string | undefined;
    return id ? { metaAdsetId: id } : null;
  });
  // upload_image tem 2 por pair (feed + stories) — chave composta
  const uploadByPairPlacement = new Map<string, string>(); // key: `${idx}:${placement}` → hash
  for (const r of uploadSteps) {
    const inp = (r.inputData ?? {}) as Record<string, unknown>;
    const out = (r.outputData ?? {}) as Record<string, unknown>;
    const idx = inp.variantPairIndex as number | undefined;
    const placement = inp.placement as string | undefined;
    const hash = out.imageHash as string | undefined;
    if (idx === undefined || !placement || !hash) continue;
    uploadByPairPlacement.set(`${idx}:${placement}`, hash);
  }

  // create_creative não é necessário pra persist (metaCreativeId vem via
  // propagação no input do create_ad). Puxa do create_ad input.
  const creativeByPair = indexByPair(adSteps, (inp) => {
    const id = inp.metaCreativeId as string | undefined;
    return id ? { metaCreativeId: id } : null;
  });

  // 3. Transação: 2 inserts publishedAds + 1 update variants + 1 update creatives por pair
  let variantsUpdated = 0;
  let publishedAdsInserted = 0;
  let creativesMarkedTesting = 0;

  await dbAdmin.transaction(async (tx) => {
    for (let i = 0; i < variantPairs.length; i++) {
      const pair = variantPairs[i];
      const ad = adByPair.get(i);
      const adSet = adSetByPair.get(i);
      const creative = creativeByPair.get(i);
      const feedHash = uploadByPairPlacement.get(`${i}:feed`);
      const storiesHash = uploadByPairPlacement.get(`${i}:stories`);

      if (!ad || !adSet || !creative || !feedHash || !storiesHash) {
        log.warn(
          { adName: pair.adName, i, hasAd: !!ad, hasAdSet: !!adSet, hasCreative: !!creative, hasFeedHash: !!feedHash, hasStoriesHash: !!storiesHash },
          "persist_results: skipping pair — incomplete step outputs",
        );
        continue;
      }

      const variantIds = [pair.feed?.variantId, pair.stories?.variantId].filter(
        Boolean,
      ) as string[];
      const creativeIds = [pair.feed?.creativeId, pair.stories?.creativeId].filter(
        Boolean,
      ) as string[];

      if (variantIds.length > 0) {
        const updated = await tx
          .update(testRoundVariants)
          .set({
            metaAdId: ad.metaAdId,
            metaAdsetId: adSet.metaAdsetId,
            metaCreativeId: creative.metaCreativeId,
            status: "published",
          })
          .where(inArray(testRoundVariants.id, variantIds))
          .returning({ id: testRoundVariants.id });
        variantsUpdated += updated.length;
      }

      for (const [variant, placement, imageHash] of [
        [pair.feed, "feed", feedHash],
        [pair.stories, "stories", storiesHash],
      ] as const) {
        if (!variant) continue;
        await tx.insert(publishedAdsTable).values({
          workspaceId,
          variantId: variant.variantId,
          creativeId: variant.creativeId,
          metaAdId: ad.metaAdId,
          metaAdsetId: adSet.metaAdsetId,
          metaCreativeId: creative.metaCreativeId,
          metaImageHash: imageHash,
          adName: pair.adName,
          adsetName: adSetTemplate.name,
          placement,
          status: "pending_review",
        });
        publishedAdsInserted++;
      }

      if (creativeIds.length > 0) {
        const updated = await tx
          .update(creativesTable)
          .set({ status: "testing" })
          .where(inArray(creativesTable.id, creativeIds))
          .returning({ id: creativesTable.id });
        creativesMarkedTesting += updated.length;
      }
    }
  });

  log.info(
    { testRoundId, batchId, variantsUpdated, publishedAdsInserted, creativesMarkedTesting },
    "persist_results completed",
  );

  return {
    variantsUpdated,
    publishedAdsInserted,
    creativesMarkedTesting,
  };
}

// ─── stubs ────────────────────────────────────────────────────────────────
/**
 * Stub — lança NOT_IMPLEMENTED pra forçar isNonRetryable=true → falha
 * definitiva em 1 attempt (sem desperdício de retry). Substituído 1-a-1
 * conforme as fases avançam.
 */
function notImplemented(stepType: string): StepHandler {
  return async () => {
    throw new Error(
      `NOT_IMPLEMENTED: handler for step_type='${stepType}' will be added in a later phase`,
    );
  };
}

export const stepHandlers: Record<string, StepHandler> = {
  // ── Fase 2A (implementados neste commit) ──
  load_context: handleLoadContext,
  upload_image: handleUploadImage,
  create_ad_label: handleCreateAdLabel,

  // ── Fase 2B (implementados neste commit) ──
  verify_pre_publish: handleVerifyPrePublish,
  create_creative: handleCreateCreative,
  create_adset: handleCreateAdSet,

  // ── Fase 2C (implementados neste commit) ──
  create_ad: handleCreateAd,
  activate_ads: handleActivateAds,
  verify_post_publish: handleVerifyPostPublish,
  persist_results: handlePersistResults,

  // ── Não usados por test_round_publish — implementar por demanda ──
  upload_video: notImplemented("upload_video"),
  create_carousel_creative: notImplemented("create_carousel_creative"),
  clone_adset: notImplemented("clone_adset"),
  resolve_model_ad: notImplemented("resolve_model_ad"),
  list_adsets: notImplemented("list_adsets"),
  download_drive_files: notImplemented("download_drive_files"),

  // ── Fase 6 (import pipeline) ──
  import_structure: notImplemented("import_structure"),
  import_image: notImplemented("import_image"),
  import_video: notImplemented("import_video"),
  import_insights: notImplemented("import_insights"),
};

export function getStepHandler(stepType: string): StepHandler {
  const h = stepHandlers[stepType];
  if (!h) throw new Error(`No handler for step type: ${stepType}`);
  return h;
}

/**
 * Steps que chamam Meta API — worker insere rate-limit de 2s entre eles.
 * Mantido em fonte única pra reuso na Fase 2 (handlers reais).
 */
const META_STEP_TYPES = new Set<string>([
  "upload_image",
  "upload_video",
  "create_ad_label",
  "create_creative",
  "create_carousel_creative",
  "create_adset",
  "clone_adset",
  "create_ad",
  "verify_pre_publish",
  "verify_post_publish",
  "resolve_model_ad",
  "list_adsets",
  "activate_ads",
  "import_structure",
  "import_image",
  "import_video",
  "import_insights",
]);

export function isMetaApiStep(stepType: string): boolean {
  return META_STEP_TYPES.has(stepType);
}

// Type exports pro factory/consumers criarem batches com shapes tipados.
export type { VariantPair, AdSetTemplate, AdContent };
