/**
 * POST /api/ads/publish-external
 *
 * Publica criativos externos (não gerados pelo Pegasus) no Meta Ads.
 * Aceita imagens via multipart form ou base64.
 *
 * Body (JSON):
 * {
 *   "ads": [
 *     {
 *       "name": "T4EBMX-AD05",
 *       "feed_image_base64": "...",
 *       "stories_image_base64": "..."
 *     }
 *   ],
 *   "campaign_key": "T7_0003_RAT"
 * }
 *
 * Protegido por x-api-key (TEST_LOG_API_KEY).
 */
import { NextRequest, NextResponse } from "next/server";
import * as meta from "@/lib/meta";
import { KNOWN_CAMPAIGNS, UTM_TEMPLATE } from "@/config/campaigns";

export const runtime = "nodejs";
export const maxDuration = 120;

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  const expected = process.env.TEST_LOG_API_KEY;
  if (!expected) return false;
  return key === expected;
}

interface ExternalAd {
  name: string;
  feed_image_base64: string;
  stories_image_base64: string;
}

interface PublishResult {
  ad_name: string;
  success: boolean;
  ad_id?: string;
  adset_id?: string;
  creative_id?: string;
  error?: string;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const campaignKey = body.campaign_key || "T7_0003_RAT";
    const ads: ExternalAd[] = body.ads;

    if (!ads || !Array.isArray(ads) || ads.length === 0) {
      return NextResponse.json({ error: "ads array required" }, { status: 400 });
    }

    const campaign = KNOWN_CAMPAIGNS[campaignKey];
    if (!campaign) {
      return NextResponse.json({ error: `Campaign ${campaignKey} not found` }, { status: 400 });
    }

    // Buscar ad set template e conteúdo existente
    console.log("[PublishExternal] Fetching ad set template...");
    const adSetTemplate = await meta.getAdSetTemplate(campaign.metaCampaignId);
    if (!adSetTemplate) {
      return NextResponse.json({ error: "No ad set template found" }, { status: 500 });
    }

    console.log("[PublishExternal] Fetching ad content from campaign...");
    const adContent = await meta.getAdContentFromCampaign(campaign.metaCampaignId);
    if (!adContent || !adContent.link) {
      return NextResponse.json({ error: "No ad content (body/title/link) found in campaign" }, { status: 500 });
    }

    const results: PublishResult[] = [];

    for (const ad of ads) {
      try {
        console.log(`[PublishExternal] Publishing ${ad.name}...`);

        // 1. Upload imagens
        const feedBuffer = Buffer.from(ad.feed_image_base64, "base64");
        const storiesBuffer = Buffer.from(ad.stories_image_base64, "base64");

        console.log(`[PublishExternal] Uploading feed (${feedBuffer.length} bytes)...`);
        const feedUpload = await meta.uploadImage(
          campaign.metaAccountId, feedBuffer, `${ad.name}F.png`
        );

        console.log(`[PublishExternal] Uploading stories (${storiesBuffer.length} bytes)...`);
        const storiesUpload = await meta.uploadImage(
          campaign.metaAccountId, storiesBuffer, `${ad.name}S.png`
        );

        // 2. Criar labels
        const feedLabel = await meta.createAdLabel(campaign.metaAccountId, `${ad.name}_feed`);
        const storiesLabel = await meta.createAdLabel(campaign.metaAccountId, `${ad.name}_stories`);

        // 3. Criar creative
        const creative = await meta.createCreative({
          accountId: campaign.metaAccountId,
          name: ad.name,
          pageId: campaign.pageId,
          instagramUserId: campaign.instagramUserId,
          feedImageHash: feedUpload.hash,
          storiesImageHash: storiesUpload.hash,
          feedLabelId: feedLabel.id,
          storiesLabelId: storiesLabel.id,
          body: adContent.body,
          title: adContent.title,
          link: adContent.link,
          callToAction: adContent.callToAction,
          urlTags: UTM_TEMPLATE,
        });

        // 4. Criar ad set (nome idêntico ao template)
        const adSet = await meta.createAdSet({
          accountId: campaign.metaAccountId,
          campaignId: campaign.metaCampaignId,
          name: adSetTemplate.name as string,
          dailyBudgetCents: campaign.dailyBudgetCents,
          bidStrategy: campaign.bidStrategy,
          billingEvent: campaign.billingEvent,
          optimizationGoal: campaign.optimizationGoal,
          targeting: adSetTemplate.targeting as Record<string, unknown>,
          promotedObject: campaign.promotedObject,
          attributionSpec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
          status: "ACTIVE",
        });

        // 5. Criar ad
        const adResult = await meta.createAd({
          accountId: campaign.metaAccountId,
          adSetId: adSet.id,
          creativeId: creative.id,
          name: ad.name,
          status: "ACTIVE",
        });

        console.log(`[PublishExternal] ${ad.name} published! ad_id=${adResult.id}`);

        results.push({
          ad_name: ad.name,
          success: true,
          ad_id: adResult.id,
          adset_id: adSet.id,
          creative_id: creative.id,
        });

      } catch (err) {
        console.error(`[PublishExternal] Failed to publish ${ad.name}:`, err);
        results.push({
          ad_name: ad.name,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return NextResponse.json({
      campaign: campaignKey,
      total: ads.length,
      succeeded,
      failed,
      results,
    });
  } catch (err) {
    console.error("[PublishExternal]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
