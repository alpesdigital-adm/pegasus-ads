/**
 * PublishPipeline — Orquestra a publicação de variantes no Meta Ads.
 *
 * Fluxo (por variante):
 * 1. Buscar config da campanha (template de ad set existente)
 * 2. Verificação pre_publish
 * 3. Upload imagens (Feed + Stories) → hashes
 * 4. Criar ad labels
 * 5. Criar creative (asset_feed_spec com customization rules)
 * 6. Criar ad set (copiando targeting do template, attribution 1d click)
 * 7. Criar ad
 * 8. Verificação post_publish
 * 9. Atualizar banco (published_ads, test_round_variants, test_round status)
 *
 * MIGRADO NA FASE 1C (Wave 7 libs):
 *  - getDb() → withWorkspace (RLS escopa todas as tabelas envolvidas)
 *  - Cada "sub-bloco" de DB em withWorkspace separado
 *  - uuid() manual removido (defaultRandom no schema)
 */

import { withWorkspace } from "../db";
import {
  pipelineExecutions,
  testRounds,
  testRoundVariants,
  publishedAds as publishedAdsTable,
  creatives,
  campaigns,
} from "../db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../logger";

const log = logger.child({ pipeline: "publish" });
import * as meta from "../meta";
import { verifyPrePublish, verifyPostPublish } from "../ai-verify";
import { generateMetaAdName } from "../creative-naming";
import { UTM_TEMPLATE } from "@/config/campaigns";
import type { PipelineStep } from "../types";

export interface PublishPipelineInput {
  testRoundId: string;
  workspaceId: string;
}

export interface PublishPipelineOutput {
  testRoundId: string;
  publishedAds: Array<{
    adId: string;
    adSetId: string;
    creativeId: string;
    adName: string;
    status: string;
  }>;
  steps: PipelineStep[];
  verification: Record<string, unknown>;
}

export async function runPublishPipeline(
  input: PublishPipelineInput,
): Promise<PublishPipelineOutput> {
  const ws = input.workspaceId;
  const steps: PipelineStep[] = [];
  const publishedAds: PublishPipelineOutput["publishedAds"] = [];

  const { executionId } = await withWorkspace(ws, async (tx) => {
    const [exec] = await tx
      .insert(pipelineExecutions)
      .values({
        workspaceId: ws,
        testRoundId: input.testRoundId,
        pipelineType: "publish",
        status: "running",
        inputData: input as unknown as Record<string, unknown>,
      })
      .returning({ id: pipelineExecutions.id });
    return { executionId: exec.id };
  });

  try {
    // ── Step 1: Buscar test round + campaign + variants ──
    const step1: PipelineStep = { name: "load_context", status: "running", started_at: new Date().toISOString() };
    steps.push(step1);

    const { round, variantRows } = await withWorkspace(ws, async (tx) => {
      const roundRes = await tx.execute(sql`
        SELECT tr.*, c.meta_campaign_id, c.meta_account_id, c.pixel_id, c.page_id,
               c.instagram_user_id, c.config, c.cpl_target
        FROM test_rounds tr
        JOIN campaigns c ON tr.campaign_id = c.id
        WHERE tr.id = ${input.testRoundId}
      `);
      const roundRows = roundRes as unknown as Array<Record<string, unknown>>;
      if (roundRows.length === 0) {
        throw new Error(`Test round ${input.testRoundId} not found`);
      }

      const variantsRes = await tx.execute(sql`
        SELECT trv.*, cr.blob_url, cr.name AS creative_name, cr.width, cr.height
        FROM test_round_variants trv
        JOIN creatives cr ON trv.creative_id = cr.id
        WHERE trv.test_round_id = ${input.testRoundId}
          AND trv.role = 'variant'
          AND trv.status IN ('generated', 'verified')
        ORDER BY cr.name
      `);

      return {
        round: roundRows[0],
        variantRows: variantsRes as unknown as Array<Record<string, unknown>>,
      };
    });

    const accountId = round.meta_account_id as string;
    const campaignId = round.meta_campaign_id as string;
    const pageId = round.page_id as string;
    const instagramUserId = round.instagram_user_id as string;
    const campaignConfig =
      typeof round.config === "string"
        ? JSON.parse(round.config as string)
        : (round.config as Record<string, unknown>) || {};

    const variantPairs = groupVariantsByAd(variantRows);

    log.info({ campaignId }, "fetching ad set template");
    const adSetTemplate = await meta.getAdSetTemplate(ws, campaignId);
    if (!adSetTemplate) {
      throw new Error(`No ad set template found for campaign ${campaignId}`);
    }
    log.info(
      {
        name: adSetTemplate.name,
        daily_budget: adSetTemplate.daily_budget,
        bid_strategy: adSetTemplate.bid_strategy,
        targeting_keys: adSetTemplate.targeting
          ? Object.keys(adSetTemplate.targeting as Record<string, unknown>)
          : null,
      },
      "ad set template",
    );

    step1.status = "completed";
    step1.completed_at = new Date().toISOString();

    await withWorkspace(ws, async (tx) => {
      await tx
        .update(testRounds)
        .set({ status: "publishing", updatedAt: sql`NOW()` })
        .where(eq(testRounds.id, input.testRoundId));
    });

    // ── Para cada par Feed+Stories ──
    for (const pair of variantPairs) {
      const adName = pair.adName;

      const step2: PipelineStep = { name: `verify_pre_publish_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step2);

      const preCheck = verifyPrePublish({
        adName,
        adSetName: adSetTemplate.name as string,
        feedImageReady: !!pair.feed,
        storiesImageReady: !!pair.stories,
        hasAttribution: true,
        hasBidStrategy: !!(campaignConfig.bid_strategy || adSetTemplate.bid_strategy),
        hasTargeting: !!adSetTemplate.targeting,
        hasPromotedObject: !!adSetTemplate.promoted_object,
        dailyBudgetCents: parseInt(
          (campaignConfig.daily_budget || adSetTemplate.daily_budget || "8000") as string,
          10,
        ),
      });

      step2.output = preCheck as unknown as Record<string, unknown>;

      if (!preCheck.passed) {
        step2.status = "failed";
        step2.error = `Pre-publish failed: ${preCheck.issues.join("; ")}`;
        throw new Error(step2.error);
      }

      step2.status = "completed";
      step2.completed_at = new Date().toISOString();

      // ── Step 3: Upload imagens ──
      const step3: PipelineStep = { name: `upload_images_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step3);

      log.info({ adName }, "uploading feed image");
      const feedResponse = await fetch(pair.feed!.blobUrl);
      const feedBuffer = Buffer.from(await feedResponse.arrayBuffer());
      const feedUpload = await meta.uploadImage(accountId, feedBuffer, `${adName}F.png`, ws);
      log.info({ adName, hash: feedUpload.hash }, "feed upload ok");

      log.info({ adName }, "uploading stories image");
      const storiesResponse = await fetch(pair.stories!.blobUrl);
      const storiesBuffer = Buffer.from(await storiesResponse.arrayBuffer());
      const storiesUpload = await meta.uploadImage(accountId, storiesBuffer, `${adName}S.png`, ws);
      log.info({ adName, hash: storiesUpload.hash }, "stories upload ok");

      step3.status = "completed";
      step3.completed_at = new Date().toISOString();

      // ── Step 4: Labels ──
      const step4: PipelineStep = { name: `create_labels_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step4);
      const feedLabel = await meta.createAdLabel(accountId, `${adName}_feed`, ws);
      const storiesLabel = await meta.createAdLabel(accountId, `${adName}_stories`, ws);
      step4.status = "completed";
      step4.completed_at = new Date().toISOString();

      // ── Step 5: Creative ──
      const step5: PipelineStep = { name: `create_creative_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step5);

      const existingAd = await getExistingAdContentWithFallback(campaignId, accountId, ws);
      log.info(
        {
          adName,
          body_preview: existingAd.body?.substring(0, 50),
          link: existingAd.link,
          title: existingAd.title,
          cta: existingAd.callToAction,
        },
        "ad content",
      );

      const metaCreative = await meta.createCreative({
        accountId,
        workspaceId: ws,
        name: adName,
        pageId,
        instagramUserId,
        feedImageHash: feedUpload.hash,
        storiesImageHash: storiesUpload.hash,
        feedLabelId: feedLabel.id,
        storiesLabelId: storiesLabel.id,
        body: existingAd.body,
        title: existingAd.title,
        link: existingAd.link,
        callToAction: existingAd.callToAction,
        urlTags: UTM_TEMPLATE,
      });

      step5.status = "completed";
      step5.completed_at = new Date().toISOString();

      // ── Step 6: Ad set ──
      const step6: PipelineStep = { name: `create_adset_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step6);

      const adSetResult = await meta.createAdSet({
        accountId,
        workspaceId: ws,
        campaignId,
        name: adSetTemplate.name as string,
        dailyBudgetCents: (campaignConfig.daily_budget || adSetTemplate.daily_budget || "8000") as string,
        bidStrategy: (campaignConfig.bid_strategy || adSetTemplate.bid_strategy || "LOWEST_COST_WITHOUT_CAP") as string,
        billingEvent: (adSetTemplate.billing_event || "IMPRESSIONS") as string,
        optimizationGoal: (adSetTemplate.optimization_goal || "OFFSITE_CONVERSIONS") as string,
        targeting: adSetTemplate.targeting as Record<string, unknown>,
        promotedObject: adSetTemplate.promoted_object as Record<string, unknown>,
        attributionSpec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
        status: "ACTIVE",
      });

      step6.status = "completed";
      step6.completed_at = new Date().toISOString();

      // ── Step 7: Ad ──
      const step7: PipelineStep = { name: `create_ad_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step7);

      const adResult = await meta.createAd({
        accountId,
        workspaceId: ws,
        adSetId: adSetResult.id,
        creativeId: metaCreative.id,
        name: adName,
        status: "ACTIVE",
      });

      step7.status = "completed";
      step7.completed_at = new Date().toISOString();

      // ── Persistência: variants + published_ads + creatives status ──
      const variantIds = [pair.feed?.variantId, pair.stories?.variantId].filter(Boolean) as string[];
      const creativeIds = [pair.feed?.creativeId, pair.stories?.creativeId].filter(Boolean) as string[];

      await withWorkspace(ws, async (tx) => {
        if (variantIds.length > 0) {
          await tx
            .update(testRoundVariants)
            .set({
              metaAdId: adResult.id,
              metaAdsetId: adSetResult.id,
              metaCreativeId: metaCreative.id,
              status: "published",
            })
            .where(inArray(testRoundVariants.id, variantIds));
        }

        for (const [variant, placement, imageHash] of [
          [pair.feed, "feed", feedUpload.hash],
          [pair.stories, "stories", storiesUpload.hash],
        ] as const) {
          if (!variant) continue;
          await tx.insert(publishedAdsTable).values({
            workspaceId: ws,
            variantId: variant.variantId,
            creativeId: variant.creativeId,
            metaAdId: adResult.id,
            metaAdsetId: adSetResult.id,
            metaCreativeId: metaCreative.id,
            metaImageHash: imageHash,
            adName,
            adsetName: adSetTemplate.name as string,
            placement,
            status: "pending_review",
          });
        }

        if (creativeIds.length > 0) {
          await tx
            .update(creatives)
            .set({ status: "testing" })
            .where(inArray(creatives.id, creativeIds));
        }
      });

      publishedAds.push({
        adId: adResult.id,
        adSetId: adSetResult.id,
        creativeId: metaCreative.id,
        adName,
        status: "ACTIVE",
      });
    }

    // ── Step 8: Post-publish verification ──
    const step8: PipelineStep = { name: "verify_post_publish", status: "running", started_at: new Date().toISOString() };
    steps.push(step8);

    const postCheck = verifyPostPublish({
      adsCreated: publishedAds.map((a) => ({ adId: a.adId, adName: a.adName, status: a.status })),
      expectedCount: variantPairs.length,
    });

    step8.status = "completed";
    step8.completed_at = new Date().toISOString();

    const existingVerification =
      typeof round.ai_verification === "string"
        ? JSON.parse(round.ai_verification as string)
        : ((round.ai_verification as Record<string, unknown>) || {});

    await withWorkspace(ws, async (tx) => {
      await tx
        .update(testRounds)
        .set({
          status: "live",
          aiVerification: { ...existingVerification, post_publish: postCheck } as unknown as Record<string, unknown>,
          updatedAt: sql`NOW()`,
        })
        .where(eq(testRounds.id, input.testRoundId));

      await tx
        .update(pipelineExecutions)
        .set({
          status: "completed",
          outputData: { publishedAds } as unknown as Record<string, unknown>,
          steps: steps as unknown as Record<string, unknown>,
          completedAt: sql`NOW()`,
          durationMs: sql`EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER * 1000`,
        })
        .where(eq(pipelineExecutions.id, executionId));
    });

    return {
      testRoundId: input.testRoundId,
      publishedAds,
      steps,
      verification: { post_publish: postCheck },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";

    await withWorkspace(ws, async (tx) => {
      await tx
        .update(testRounds)
        .set({ status: "failed", updatedAt: sql`NOW()` })
        .where(eq(testRounds.id, input.testRoundId));
      await tx
        .update(pipelineExecutions)
        .set({
          status: "failed",
          errorMessage: errorMsg,
          steps: steps as unknown as Record<string, unknown>,
          completedAt: sql`NOW()`,
        })
        .where(eq(pipelineExecutions.id, executionId));
    }).catch((dbErr) => {
      log.error({ err: dbErr }, "failed to record error state");
    });

    throw error;
  }
}

// ── Helpers ──

interface VariantPair {
  adName: string;
  adNumber: number;
  feed?: { variantId: string; creativeId: string; blobUrl: string };
  stories?: { variantId: string; creativeId: string; blobUrl: string };
}

function groupVariantsByAd(rows: Record<string, unknown>[]): VariantPair[] {
  const map = new Map<string, VariantPair>();

  for (const row of rows) {
    const name = row.creative_name as string;
    const adNumber = parseInt(name.match(/AD(\d+)/i)?.[1] || "0", 10);
    const adName = generateMetaAdName(adNumber);
    const placement = row.placement as string;

    if (!map.has(adName)) {
      map.set(adName, { adName, adNumber, feed: undefined, stories: undefined });
    }

    const pair = map.get(adName)!;
    const variantData = {
      variantId: row.id as string,
      creativeId: row.creative_id as string,
      blobUrl: row.blob_url as string,
    };

    if (placement === "feed") {
      pair.feed = variantData;
    } else if (placement === "stories") {
      pair.stories = variantData;
    }
  }

  return Array.from(map.values());
}

async function getExistingAdContentWithFallback(
  campaignId: string,
  accountId: string,
  workspaceId: string,
): Promise<{ body: string; title: string; link: string; callToAction: string }> {
  // 1. Tentar banco (override manual)
  try {
    const rows = await withWorkspace(workspaceId, async (tx) =>
      tx
        .select({ config: campaigns.config })
        .from(campaigns)
        .where(
          and(
            eq(campaigns.metaCampaignId, campaignId),
            eq(campaigns.metaAccountId, accountId),
          ),
        )
        .limit(1),
    );

    if (rows.length > 0) {
      const config =
        typeof rows[0].config === "string"
          ? JSON.parse(rows[0].config as unknown as string)
          : rows[0].config;

      if (config?.ad_content?.link) {
        log.info("using ad_content from campaign config (DB)");
        return config.ad_content;
      }
    }
  } catch {
    // ignore, try Meta API next
  }

  // 2. Meta API
  log.info("fetching ad content from meta api");
  const metaContent = await meta.getAdContentFromCampaign(workspaceId, campaignId);
  if (metaContent && metaContent.link) {
    log.info("got ad content from meta api");

    try {
      await withWorkspace(workspaceId, async (tx) => {
        await tx.execute(sql`
          UPDATE campaigns SET config = jsonb_set(
            COALESCE(config::jsonb, '{}'::jsonb),
            '{ad_content}',
            ${JSON.stringify(metaContent)}::jsonb
          )
          WHERE meta_campaign_id = ${campaignId} AND meta_account_id = ${accountId}
        `);
      });
      log.info("cached ad_content in campaign config");
    } catch (cacheErr) {
      log.warn({ err: cacheErr }, "failed to cache ad_content");
    }

    return metaContent;
  }

  throw new Error(
    `No ad content (body/title/link) found for campaign ${campaignId}. ` +
      `Either configure ad_content in campaign config or ensure the campaign has at least one active ad with creative content.`,
  );
}
