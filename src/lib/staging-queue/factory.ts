// Factory de batches da Staging Queue v2.
// Spec: docs/staging-queue-v2.md §2.1 + §6 + §8.
//
// Chamado síncronamente pela API (sob flag USE_STAGING_QUEUE). Faz
// pre-loading completo de contexto (DB + Meta API) e cria publication_batch
// + N publication_steps + M step_dependencies atômicamente numa transação.
//
// Trade-off arquitetural: factory síncrono chama Meta API (getAdSetTemplate
// + getAdContentFromCampaign) — usuário espera ~1-3s na request. Ganho:
// erros de validação aparecem imediatamente (ad set template ausente,
// ad content vazio) em vez de depois de 30s no worker. Alinha com o
// princípio "fail-fast" do mantra casa-de-tijolos.

import { dbAdmin } from "@/lib/db";
import {
  publicationBatches,
  publicationSteps,
  stepDependencies,
} from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import * as meta from "@/lib/meta";
import { generateMetaAdName } from "@/lib/creative-naming";
import { UTM_TEMPLATE } from "@/config/campaigns";
import { logger } from "@/lib/logger";
import type { VariantPair, AdSetTemplate, AdContent } from "./handlers";

const log = logger.child({ mod: "staging-queue/factory" });

const VALID_PUBLISHABLE_STATUSES = new Set(["reviewing", "generating", "failed"]);

export interface CreateTestRoundBatchInput {
  testRoundId: string;
  workspaceId: string;
  activationMode?: "after_all" | "immediate";
  /**
   * Prefixo aplicado em todos os nomes criados na Meta (ad, adset, creative,
   * labels). Default: "" (sem prefixo). Usado principalmente em smoke tests
   * pra identificar entities facilmente no Ads Manager (ex: "TEST__").
   * Propaga pro persist_results → published_ads.ad_name/adset_name.
   */
  namePrefix?: string;
}

export interface CreateTestRoundBatchResult {
  batchId: string;
  stepsTotal: number;
  variantPairCount: number;
}

export async function createTestRoundBatch(
  params: CreateTestRoundBatchInput,
): Promise<CreateTestRoundBatchResult> {
  const { testRoundId, workspaceId } = params;
  const activationMode = params.activationMode ?? "after_all";
  const namePrefix = params.namePrefix ?? "";

  // ── 1. Carrega test_round + campaign (fail-fast no que é estático) ──
  const roundRows = await dbAdmin.execute<{
    id: string;
    status: string;
    campaign_id: string;
    meta_campaign_id: string;
    meta_account_id: string;
    page_id: string;
    instagram_user_id: string;
    config: unknown;
  }>(sql`
    SELECT tr.id, tr.status, tr.campaign_id,
           c.meta_campaign_id, c.meta_account_id, c.page_id, c.instagram_user_id, c.config
    FROM test_rounds tr
    JOIN campaigns c ON tr.campaign_id = c.id
    WHERE tr.id = ${testRoundId}
      AND tr.workspace_id = ${workspaceId}
    LIMIT 1
  `);
  if (roundRows.length === 0) {
    throw new Error(`test_round ${testRoundId} not found in workspace`);
  }
  const round = roundRows[0];

  if (!VALID_PUBLISHABLE_STATUSES.has(round.status)) {
    throw new Error(
      `test_round ${testRoundId} status is '${round.status}', expected one of ${[...VALID_PUBLISHABLE_STATUSES].join("|")}`,
    );
  }

  const metaCampaignId = round.meta_campaign_id;
  const accountId = round.meta_account_id;
  const pageId = round.page_id;
  const instagramUserId = round.instagram_user_id;

  if (!metaCampaignId || !accountId || !pageId || !instagramUserId) {
    throw new Error(
      `campaign ${round.campaign_id} missing meta_campaign_id/account_id/page_id/instagram_user_id`,
    );
  }

  const campaignConfig: Record<string, unknown> =
    typeof round.config === "string"
      ? JSON.parse(round.config)
      : ((round.config as Record<string, unknown>) ?? {});

  // ── 2. Carrega variants + agrupa em pairs ──
  const variantRows = await dbAdmin.execute<{
    id: string;
    creative_id: string;
    placement: string;
    blob_url: string;
    creative_name: string;
  }>(sql`
    SELECT trv.id, trv.creative_id, trv.placement, cr.blob_url, cr.name AS creative_name
    FROM test_round_variants trv
    JOIN creatives cr ON trv.creative_id = cr.id
    WHERE trv.test_round_id = ${testRoundId}
      AND trv.role = 'variant'
      AND trv.status IN ('generated', 'verified')
    ORDER BY cr.name
  `);

  if (variantRows.length === 0) {
    throw new Error(
      `test_round ${testRoundId} has no variants in status generated|verified`,
    );
  }

  const variantPairs = groupVariantsByAd(variantRows);
  if (variantPairs.length === 0) {
    throw new Error(
      `test_round ${testRoundId}: variants present but zero complete VariantPairs (each ad needs feed+stories)`,
    );
  }

  // ── 3. Meta API: adSetTemplate ──
  const tpl = await meta.getAdSetTemplate(metaCampaignId, workspaceId);
  if (!tpl) {
    throw new Error(
      `campaign ${metaCampaignId} has no ad set (template required to clone)`,
    );
  }
  const adSetTemplate: AdSetTemplate = {
    name: `${namePrefix}${String(tpl.name ?? "")}`,
    dailyBudgetCents: String(
      campaignConfig.daily_budget ?? tpl.daily_budget ?? "8000",
    ),
    bidStrategy: String(
      campaignConfig.bid_strategy ?? tpl.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP",
    ),
    billingEvent: String(tpl.billing_event ?? "IMPRESSIONS"),
    optimizationGoal: String(tpl.optimization_goal ?? "OFFSITE_CONVERSIONS"),
    targeting: (tpl.targeting as Record<string, unknown>) ?? {},
    promotedObject: (tpl.promoted_object as Record<string, unknown>) ?? {},
  };

  // ── 4. Meta API: adContent com fallback (DB → Meta → cache) ──
  const adContent = await resolveAdContent(
    metaCampaignId,
    accountId,
    workspaceId,
    campaignConfig,
  );

  // ── 5. Cria batch + steps + arestas em transação ──
  const batchId = await dbAdmin.transaction(async (tx) => {
    const [batch] = await tx
      .insert(publicationBatches)
      .values({
        workspaceId,
        batchType: "test_round_publish",
        status: "pending",
        priority: 10,
        activationMode,
        testRoundId,
        inputData: {
          testRoundId,
          activationMode,
          variantPairCount: variantPairs.length,
        },
      })
      .returning({ id: publicationBatches.id });

    const bId = batch.id;

    // Monta specs dos steps (sem IDs ainda)
    interface StepSpec {
      stepType: string;
      ordinal: number;
      isCritical: "true" | "false";
      inputData: Record<string, unknown>;
    }
    const stepSpecs: StepSpec[] = [];

    // load_context (ordinal 0)
    stepSpecs.push({
      stepType: "load_context",
      ordinal: 0,
      isCritical: "true",
      inputData: { testRoundId },
    });

    // Por pair: verify_pre_publish, upload_image*2, create_ad_label*2,
    // create_adset, create_creative, create_ad (ordinal crescente)
    let ordinal = 1;
    const pairStepOffsets: Array<{
      verify: number;
      uploadFeed: number;
      uploadStories: number;
      labelFeed: number;
      labelStories: number;
      adset: number;
      creative: number;
      ad: number;
    }> = [];

    for (let i = 0; i < variantPairs.length; i++) {
      const pair = variantPairs[i];
      const prefixedAdName = `${namePrefix}${pair.adName}`;
      const offsets = {
        verify: stepSpecs.length,
        uploadFeed: -1,
        uploadStories: -1,
        labelFeed: -1,
        labelStories: -1,
        adset: -1,
        creative: -1,
        ad: -1,
      };

      stepSpecs.push({
        stepType: "verify_pre_publish",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: {
          adName: prefixedAdName,
          adSetName: adSetTemplate.name,
          feedImageReady: true,
          storiesImageReady: true,
          hasAttribution: true,
          hasBidStrategy: !!adSetTemplate.bidStrategy,
          hasTargeting: Object.keys(adSetTemplate.targeting).length > 0,
          hasPromotedObject: Object.keys(adSetTemplate.promotedObject).length > 0,
          dailyBudgetCents: Number(adSetTemplate.dailyBudgetCents),
          variantPairIndex: i,
        },
      });

      offsets.uploadFeed = stepSpecs.length;
      stepSpecs.push({
        stepType: "upload_image",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: {
          accountId,
          blobUrl: pair.feed!.blobUrl,
          filename: `${prefixedAdName}F.png`,
          placement: "feed",
          variantPairIndex: i,
        },
      });

      offsets.uploadStories = stepSpecs.length;
      stepSpecs.push({
        stepType: "upload_image",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: {
          accountId,
          blobUrl: pair.stories!.blobUrl,
          filename: `${prefixedAdName}S.png`,
          placement: "stories",
          variantPairIndex: i,
        },
      });

      offsets.labelFeed = stepSpecs.length;
      stepSpecs.push({
        stepType: "create_ad_label",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: {
          accountId,
          labelName: `${prefixedAdName}_feed`,
          placement: "feed",
          variantPairIndex: i,
        },
      });

      offsets.labelStories = stepSpecs.length;
      stepSpecs.push({
        stepType: "create_ad_label",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: {
          accountId,
          labelName: `${prefixedAdName}_stories`,
          placement: "stories",
          variantPairIndex: i,
        },
      });

      offsets.adset = stepSpecs.length;
      stepSpecs.push({
        stepType: "create_adset",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: {
          accountId,
          metaCampaignId,
          adSetTemplate,
          variantPairIndex: i,
        },
      });

      offsets.creative = stepSpecs.length;
      stepSpecs.push({
        stepType: "create_creative",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: {
          accountId,
          pageId,
          instagramUserId,
          adName: prefixedAdName,
          adContent,
          urlTags: UTM_TEMPLATE,
          variantPairIndex: i,
          // feedImageHash, storiesImageHash, feedLabelId, storiesLabelId
          // chegam via propagação de outputs (step_dependencies).
        },
      });

      offsets.ad = stepSpecs.length;
      stepSpecs.push({
        stepType: "create_ad",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: {
          accountId,
          adName: prefixedAdName,
          activationMode,
          variantPairIndex: i,
          // metaAdsetId, metaCreativeId vêm via propagação.
        },
      });

      pairStepOffsets.push(offsets);
    }

    // Finalização: activate_ads (só se after_all), verify_post_publish, persist_results
    let activateOffset = -1;
    if (activationMode === "after_all") {
      activateOffset = stepSpecs.length;
      stepSpecs.push({
        stepType: "activate_ads",
        ordinal: ordinal++,
        isCritical: "true",
        inputData: { batchId: bId, accountId },
      });
    }

    const verifyOffset = stepSpecs.length;
    stepSpecs.push({
      stepType: "verify_post_publish",
      ordinal: ordinal++,
      isCritical: "true",
      inputData: { batchId: bId, expectedCount: variantPairs.length },
    });

    const persistOffset = stepSpecs.length;
    stepSpecs.push({
      stepType: "persist_results",
      ordinal: ordinal++,
      isCritical: "true",
      inputData: {
        testRoundId,
        batchId: bId,
        // Prefixa variantPairs.adName pra persist_results gravar com prefixo
        // nos published_ads (coerente com o que foi pra Meta).
        variantPairs: variantPairs.map((p) => ({
          ...p,
          adName: `${namePrefix}${p.adName}`,
        })),
        adSetTemplateName: adSetTemplate.name,
      },
    });

    // Bulk insert steps, retorna IDs na mesma ordem
    const inserted = await tx
      .insert(publicationSteps)
      .values(
        stepSpecs.map((s) => ({
          batchId: bId,
          workspaceId,
          stepType: s.stepType as (typeof publicationSteps.$inferInsert)["stepType"],
          ordinal: s.ordinal,
          isCritical: s.isCritical,
          inputData: s.inputData,
        })),
      )
      .returning({ id: publicationSteps.id });

    const stepIds = inserted.map((r) => r.id);

    // ── Arestas DAG ──
    const deps: Array<{
      stepId: string;
      dependsOnStepId: string;
      outputKey?: string;
      inputKey?: string;
    }> = [];
    const addDep = (
      stepIdx: number,
      depIdx: number,
      outputKey?: string,
      inputKey?: string,
    ) => {
      deps.push({
        stepId: stepIds[stepIdx],
        dependsOnStepId: stepIds[depIdx],
        outputKey,
        inputKey,
      });
    };

    const loadCtxIdx = 0;

    for (let i = 0; i < variantPairs.length; i++) {
      const o = pairStepOffsets[i];
      // Gates a partir do load_context
      addDep(o.verify, loadCtxIdx);
      addDep(o.uploadFeed, loadCtxIdx);
      addDep(o.uploadStories, loadCtxIdx);
      addDep(o.labelFeed, loadCtxIdx);
      addDep(o.labelStories, loadCtxIdx);
      addDep(o.adset, loadCtxIdx);

      // verify_pre_publish gate pros demais steps do pair
      addDep(o.uploadFeed, o.verify);
      addDep(o.uploadStories, o.verify);
      addDep(o.labelFeed, o.verify);
      addDep(o.labelStories, o.verify);
      addDep(o.adset, o.verify);

      // Propagação pro create_creative
      addDep(o.creative, o.uploadFeed, "imageHash", "feedImageHash");
      addDep(o.creative, o.uploadStories, "imageHash", "storiesImageHash");
      addDep(o.creative, o.labelFeed, "labelId", "feedLabelId");
      addDep(o.creative, o.labelStories, "labelId", "storiesLabelId");

      // Propagação pro create_ad
      addDep(o.ad, o.creative, "metaCreativeId", "metaCreativeId");
      addDep(o.ad, o.adset, "metaAdsetId", "metaAdsetId");
    }

    // Finalização
    if (activateOffset >= 0) {
      // activate_ads depende de todos os create_ad
      for (let i = 0; i < variantPairs.length; i++) {
        addDep(activateOffset, pairStepOffsets[i].ad);
      }
      addDep(verifyOffset, activateOffset);
    } else {
      // immediate: verify_post_publish depende direto dos create_ad
      for (let i = 0; i < variantPairs.length; i++) {
        addDep(verifyOffset, pairStepOffsets[i].ad);
      }
    }
    addDep(persistOffset, verifyOffset);

    if (deps.length > 0) {
      await tx.insert(stepDependencies).values(deps);
    }

    // Atualiza steps_total no batch
    await tx
      .update(publicationBatches)
      .set({ stepsTotal: stepSpecs.length })
      .where(eq(publicationBatches.id, bId));

    return bId;
  });

  log.info(
    {
      batchId,
      testRoundId,
      variantPairs: variantPairs.length,
      activationMode,
      namePrefix: namePrefix || "(none)",
    },
    "test_round batch created",
  );

  return {
    batchId,
    stepsTotal: 0, // será consultado pelo caller se precisar — stepsTotal real está no batch
    variantPairCount: variantPairs.length,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

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
    if (!map.has(adName)) map.set(adName, { adName, adNumber });
    const pair = map.get(adName)!;
    const data = {
      variantId: row.id,
      creativeId: row.creative_id,
      blobUrl: row.blob_url,
    };
    if (row.placement === "feed") pair.feed = data;
    else if (row.placement === "stories") pair.stories = data;
  }
  const complete: VariantPair[] = [];
  for (const p of map.values()) {
    if (p.feed && p.stories) complete.push(p);
    else
      log.warn(
        { adName: p.adName, hasFeed: !!p.feed, hasStories: !!p.stories },
        "incomplete pair skipped",
      );
  }
  return complete;
}

async function resolveAdContent(
  metaCampaignId: string,
  accountId: string,
  workspaceId: string,
  campaignConfig: Record<string, unknown>,
): Promise<AdContent> {
  const cached = campaignConfig.ad_content as AdContent | undefined;
  if (cached?.link && cached?.body && cached?.title) {
    log.info("ad_content from DB config");
    return {
      body: cached.body,
      title: cached.title,
      link: cached.link,
      callToAction: cached.callToAction ?? "LEARN_MORE",
    };
  }

  const metaContent = await meta.getAdContentFromCampaign(
    metaCampaignId,
    workspaceId,
  );
  if (!metaContent?.link || !metaContent?.body || !metaContent?.title) {
    throw new Error(
      `No ad content (body/title/link) for campaign ${metaCampaignId}. ` +
        `Configure ad_content in campaign.config or ensure campaign has at least one ACTIVE ad.`,
    );
  }

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
  } catch (err) {
    log.warn({ err }, "cache ad_content failed (non-fatal)");
  }

  return {
    body: metaContent.body,
    title: metaContent.title,
    link: metaContent.link,
    callToAction: metaContent.callToAction ?? "LEARN_MORE",
  };
}
