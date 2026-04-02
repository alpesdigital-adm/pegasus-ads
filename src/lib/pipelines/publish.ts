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
 */

import { v4 as uuid } from "uuid";
import { getDb } from "../db";
import * as meta from "../meta";
import { verifyPrePublish, verifyPostPublish } from "../ai-verify";
import { generateMetaAdName } from "../creative-naming";
import { UTM_TEMPLATE } from "@/config/campaigns";
import type { PipelineStep } from "../types";

// ── Inputs ──

export interface PublishPipelineInput {
  testRoundId: string;
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

// ── Pipeline ──

export async function runPublishPipeline(
  input: PublishPipelineInput
): Promise<PublishPipelineOutput> {
  const db = getDb();
  const steps: PipelineStep[] = [];
  const publishedAds: PublishPipelineOutput["publishedAds"] = [];

  // Registrar execução
  const executionId = uuid();
  await db.execute({
    sql: `INSERT INTO pipeline_executions (id, test_round_id, pipeline_type, status, input_data)
          VALUES (?, ?, 'publish', 'running', ?)`,
    args: [executionId, input.testRoundId, JSON.stringify(input)],
  });

  try {
    // ── Step 1: Buscar test round + campaign + variants ──
    const step1: PipelineStep = { name: "load_context", status: "running", started_at: new Date().toISOString() };
    steps.push(step1);

    const roundRow = await db.execute({
      sql: `SELECT tr.*, c.meta_campaign_id, c.meta_account_id, c.pixel_id, c.page_id,
                   c.instagram_user_id, c.config, c.cpl_target
            FROM test_rounds tr
            JOIN campaigns c ON tr.campaign_id = c.id
            WHERE tr.id = ?`,
      args: [input.testRoundId],
    });

    if (roundRow.rows.length === 0) {
      throw new Error(`Test round ${input.testRoundId} not found`);
    }

    const round = roundRow.rows[0];
    const accountId = round.meta_account_id as string;
    const campaignId = round.meta_campaign_id as string;
    const pageId = round.page_id as string;
    const instagramUserId = round.instagram_user_id as string;
    const campaignConfig = typeof round.config === "string" ? JSON.parse(round.config as string) : (round.config || {});

    // Buscar variantes geradas (status = 'generated' ou 'verified')
    const variantsRow = await db.execute({
      sql: `SELECT trv.*, cr.blob_url, cr.name as creative_name, cr.width, cr.height
            FROM test_round_variants trv
            JOIN creatives cr ON trv.creative_id = cr.id
            WHERE trv.test_round_id = ? AND trv.role = 'variant' AND trv.status IN ('generated', 'verified')
            ORDER BY cr.name`,
      args: [input.testRoundId],
    });

    // Agrupar por AD number (feed + stories compartilham mesmo AD)
    const variantPairs = groupVariantsByAd(variantsRow.rows);

    // Buscar template de ad set
    console.log("[PublishPipeline] Fetching ad set template for campaign:", campaignId);
    const adSetTemplate = await meta.getAdSetTemplate(campaignId);
    if (!adSetTemplate) {
      throw new Error(`No ad set template found for campaign ${campaignId}`);
    }
    console.log("[PublishPipeline] Ad set template:", JSON.stringify({
      name: adSetTemplate.name,
      daily_budget: adSetTemplate.daily_budget,
      bid_strategy: adSetTemplate.bid_strategy,
      targeting_keys: adSetTemplate.targeting ? Object.keys(adSetTemplate.targeting as Record<string, unknown>) : "null",
    }));

    step1.status = "completed";
    step1.completed_at = new Date().toISOString();

    // Atualizar status
    await db.execute({
      sql: "UPDATE test_rounds SET status = 'publishing', updated_at = NOW() WHERE id = ?",
      args: [input.testRoundId],
    });

    // ── Para cada par Feed+Stories ──
    for (const pair of variantPairs) {
      const adName = pair.adName;

      // ── Step 2: Pre-publish verification ──
      const step2: PipelineStep = { name: `verify_pre_publish_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step2);

      const preCheck = verifyPrePublish({
        adName,
        adSetName: adSetTemplate.name as string,
        feedImageReady: !!pair.feed,
        storiesImageReady: !!pair.stories,
        hasAttribution: true, // Nós sempre adicionamos
        hasBidStrategy: !!(campaignConfig.bid_strategy || adSetTemplate.bid_strategy),
        hasTargeting: !!adSetTemplate.targeting,
        hasPromotedObject: !!adSetTemplate.promoted_object,
        dailyBudgetCents: parseInt((campaignConfig.daily_budget || adSetTemplate.daily_budget || "8000") as string, 10),
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

      // Fetch e upload Feed
      console.log(`[PublishPipeline] Uploading feed image for ${adName}...`);
      const feedResponse = await fetch(pair.feed!.blobUrl);
      const feedBuffer = Buffer.from(await feedResponse.arrayBuffer());
      console.log(`[PublishPipeline] Feed image size: ${feedBuffer.length} bytes`);
      const feedUpload = await meta.uploadImage(accountId, feedBuffer, `${adName}F.png`);
      console.log(`[PublishPipeline] Feed upload OK: hash=${feedUpload.hash}`);

      // Fetch e upload Stories
      console.log(`[PublishPipeline] Uploading stories image for ${adName}...`);
      const storiesResponse = await fetch(pair.stories!.blobUrl);
      const storiesBuffer = Buffer.from(await storiesResponse.arrayBuffer());
      console.log(`[PublishPipeline] Stories image size: ${storiesBuffer.length} bytes`);
      const storiesUpload = await meta.uploadImage(accountId, storiesBuffer, `${adName}S.png`);
      console.log(`[PublishPipeline] Stories upload OK: hash=${storiesUpload.hash}`);

      step3.status = "completed";
      step3.completed_at = new Date().toISOString();

      // ── Step 4: Criar labels ──
      const step4: PipelineStep = { name: `create_labels_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step4);

      const feedLabel = await meta.createAdLabel(accountId, `${adName}_feed`);
      const storiesLabel = await meta.createAdLabel(accountId, `${adName}_stories`);

      step4.status = "completed";
      step4.completed_at = new Date().toISOString();

      // ── Step 5: Criar creative ──
      const step5: PipelineStep = { name: `create_creative_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step5);

      // Buscar body/title do ad controle existente na campanha (via Meta API)
      const existingAd = await getExistingAdContentWithFallback(campaignId, accountId);
      console.log(`[PublishPipeline] Ad content: body=${existingAd.body?.substring(0, 50)}... link=${existingAd.link} title=${existingAd.title} cta=${existingAd.callToAction}`);
      console.log(`[PublishPipeline] Creating creative: feedHash=${feedUpload.hash} storiesHash=${storiesUpload.hash} feedLabel=${feedLabel.id} storiesLabel=${storiesLabel.id}`);

      const metaCreative = await meta.createCreative({
        accountId,
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

      // ── Step 6: Criar ad set ──
      const step6: PipelineStep = { name: `create_adset_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step6);

      const adSetResult = await meta.createAdSet({
        accountId,
        campaignId,
        name: adSetTemplate.name as string, // Nome idêntico aos existentes
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

      // ── Step 7: Criar ad ──
      const step7: PipelineStep = { name: `create_ad_${adName}`, status: "running", started_at: new Date().toISOString() };
      steps.push(step7);

      const adResult = await meta.createAd({
        accountId,
        adSetId: adSetResult.id,
        creativeId: metaCreative.id,
        name: adName,
        status: "ACTIVE",
      });

      step7.status = "completed";
      step7.completed_at = new Date().toISOString();

      // Atualizar variantes no banco
      for (const variant of [pair.feed, pair.stories]) {
        if (variant) {
          await db.execute({
            sql: `UPDATE test_round_variants SET
                    meta_ad_id = ?, meta_adset_id = ?, meta_creative_id = ?, status = 'published'
                  WHERE id = ?`,
            args: [adResult.id, adSetResult.id, metaCreative.id, variant.variantId],
          });
        }
      }

      // Salvar published_ads (um registro por placement)
      for (const [variant, placement, imageHash] of [
        [pair.feed, "feed", feedUpload.hash],
        [pair.stories, "stories", storiesUpload.hash],
      ] as const) {
        if (variant) {
          await db.execute({
            sql: `INSERT INTO published_ads (id, variant_id, creative_id, meta_ad_id, meta_adset_id, meta_creative_id,
                    meta_image_hash, ad_name, adset_name, placement, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
            args: [
              uuid(), variant.variantId, variant.creativeId,
              adResult.id, adSetResult.id, metaCreative.id,
              imageHash, adName, adSetTemplate.name as string, placement,
            ],
          });
        }
      }

      // Atualizar status dos criativos para 'testing'
      for (const variant of [pair.feed, pair.stories]) {
        if (variant) {
          await db.execute({
            sql: "UPDATE creatives SET status = 'testing' WHERE id = ?",
            args: [variant.creativeId],
          });
        }
      }

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

    // Atualizar test round como live
    const existingVerification = typeof round.ai_verification === "string"
      ? JSON.parse(round.ai_verification as string)
      : (round.ai_verification || {});

    await db.execute({
      sql: "UPDATE test_rounds SET status = 'live', ai_verification = ?, updated_at = NOW() WHERE id = ?",
      args: [
        JSON.stringify({ ...existingVerification, post_publish: postCheck }),
        input.testRoundId,
      ],
    });

    // Atualizar pipeline execution
    await db.execute({
      sql: `UPDATE pipeline_executions SET status = 'completed', output_data = ?, steps = ?, completed_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER * 1000
            WHERE id = ?`,
      args: [JSON.stringify({ publishedAds }), JSON.stringify(steps), executionId],
    });

    return {
      testRoundId: input.testRoundId,
      publishedAds,
      steps,
      verification: { post_publish: postCheck },
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";

    await db.execute({
      sql: "UPDATE test_rounds SET status = 'failed', updated_at = NOW() WHERE id = ?",
      args: [input.testRoundId],
    });

    await db.execute({
      sql: `UPDATE pipeline_executions SET status = 'failed', error_message = ?, steps = ?, completed_at = NOW() WHERE id = ?`,
      args: [errorMsg, JSON.stringify(steps), executionId],
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
    const adNumber = parseInt((name.match(/AD(\d+)/i)?.[1]) || "0", 10);
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

/**
 * Busca body/title/link de um ad existente da campanha para reutilizar.
 *
 * Prioridade:
 * 1. config.ad_content salvo no banco (override manual)
 * 2. Meta API — lê o object_story_spec/asset_feed_spec de um ad ativo da campanha
 * 3. Erro se nenhum conteúdo encontrado (não usar strings vazias!)
 */
async function getExistingAdContentWithFallback(
  campaignId: string,
  accountId: string
): Promise<{ body: string; title: string; link: string; callToAction: string }> {
  // 1. Tentar buscar do banco primeiro (override manual)
  try {
    const db = getDb();
    const result = await db.execute({
      sql: `SELECT config FROM campaigns WHERE meta_campaign_id = ? AND meta_account_id = ?`,
      args: [campaignId, accountId],
    });

    if (result.rows.length > 0) {
      const config = typeof result.rows[0].config === "string"
        ? JSON.parse(result.rows[0].config as string)
        : result.rows[0].config;

      if (config?.ad_content?.link) {
        console.log("[PublishPipeline] Using ad_content from campaign config (DB)");
        return config.ad_content;
      }
    }
  } catch {
    // ignore DB errors, try Meta API next
  }

  // 2. Buscar da Meta API — ler ad existente da campanha
  console.log("[PublishPipeline] Fetching ad content from Meta API...");
  const metaContent = await meta.getAdContentFromCampaign(campaignId);
  if (metaContent && metaContent.link) {
    console.log("[PublishPipeline] Got ad content from Meta API");

    // Cachear no banco para próximas execuções
    try {
      const db = getDb();
      await db.execute({
        sql: `UPDATE campaigns SET config = jsonb_set(
                COALESCE(config::jsonb, '{}'::jsonb),
                '{ad_content}',
                ?::jsonb
              )
              WHERE meta_campaign_id = ? AND meta_account_id = ?`,
        args: [JSON.stringify(metaContent), campaignId, accountId],
      });
      console.log("[PublishPipeline] Cached ad_content in campaign config");
    } catch (cacheErr) {
      console.warn("[PublishPipeline] Failed to cache ad_content:", cacheErr);
    }

    return metaContent;
  }

  // 3. Nenhum conteúdo encontrado — erro, não publicar com strings vazias
  throw new Error(
    `No ad content (body/title/link) found for campaign ${campaignId}. ` +
    `Either configure ad_content in campaign config or ensure the campaign has at least one active ad with creative content.`
  );
}
