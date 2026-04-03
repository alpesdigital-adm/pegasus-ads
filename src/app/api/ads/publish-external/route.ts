/**
 * POST /api/ads/publish-external
 *
 * Publica criativos externos (não gerados pelo Pegasus) no Meta Ads.
 * Fonte das imagens: Google Drive (folder_id) ou base64 direto.
 *
 * Modo Drive (recomendado):
 * {
 *   "folder_id": "1IHQUCK9poxwT4ip4yZfsgNrhMHnmGBXO",
 *   "drive_id": "opcional-shared-drive-id",
 *   "ad_names": ["T4EBMX-AD05", "T7EBMX-AD011"],  // opcional: filtra quais publicar
 *   "campaign_key": "T7_0003_RAT"
 * }
 *
 * Modo base64 (fallback):
 * {
 *   "ads": [{ "name": "T4EBMX-AD05", "feed_image_base64": "...", "stories_image_base64": "..." }],
 *   "campaign_key": "T7_0003_RAT"
 * }
 *
 * Auto-discovery: se ad_names não fornecido, descobre todos os pares F+S
 * na pasta e publica apenas os que NÃO existem na campanha.
 *
 * Protegido por x-api-key (TEST_LOG_API_KEY).
 */
import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import * as meta from "@/lib/meta";
import { listFilesInFolder, downloadFile, DriveFile } from "@/lib/google-drive";
import { KNOWN_CAMPAIGNS, UTM_TEMPLATE } from "@/config/campaigns";

export const runtime = "nodejs";
export const maxDuration = 300;

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  const expected = process.env.TEST_LOG_API_KEY;
  if (!expected) return false;
  return key === expected;
}

interface PublishResult {
  ad_name: string;
  success: boolean;
  ad_id?: string;
  adset_id?: string;
  creative_id?: string;
  error?: string;
}

/**
 * Agrupa arquivos do Drive por código de ad (ex: T4EBMX-AD05).
 * Determina Feed vs Stories por dimensões reais da imagem (ratio > 1.5 = Stories).
 */
function groupFilesByAd(files: DriveFile[]): Map<string, { feed?: DriveFile; stories?: DriveFile }> {
  const groups = new Map<string, { feed?: DriveFile; stories?: DriveFile }>();

  for (const file of files) {
    // Extrair código do ad: T4EBMX-AD05F.png → T4EBMX-AD05
    const match = file.name.match(/^(T\d+EBMX-AD\d+)[FS]?\./i);
    if (!match) continue;

    const code = match[1];
    if (!groups.has(code)) groups.set(code, {});
    const group = groups.get(code)!;

    // Determinar Feed vs Stories pelas dimensões (ratio > 1.5 = Stories)
    const w = file.imageMediaMetadata?.width || 0;
    const h = file.imageMediaMetadata?.height || 0;
    const ratio = w > 0 ? h / w : 0;

    if (ratio > 1.5) {
      group.stories = file;
    } else {
      group.feed = file;
    }
  }

  return groups;
}

/**
 * Busca nomes de ads já existentes na campanha (via insights).
 */
async function getExistingAdNames(campaignId: string): Promise<Set<string>> {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return new Set();

  const url = `https://graph.facebook.com/v25.0/${campaignId}/ads?fields=name&limit=200&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) return new Set();

  const data = (await res.json()) as { data?: Array<{ name: string }> };
  const names = new Set<string>();
  for (const ad of data.data || []) {
    // Normalizar: remover sufixo -IA
    const base = ad.name.replace(/-IA$/, "");
    names.add(base);
  }
  return names;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await initDb();
    const body = await req.json();
    const campaignKey = body.campaign_key || "T7_0003_RAT";

    const campaign = KNOWN_CAMPAIGNS[campaignKey];
    if (!campaign) {
      return NextResponse.json({ error: `Campaign ${campaignKey} not found` }, { status: 400 });
    }

    // ── Resolver imagens (Drive ou base64) ──
    type AdImage = { name: string; feedBuffer: Buffer; storiesBuffer: Buffer };
    const adsToPublish: AdImage[] = [];

    if (body.folder_id) {
      // Modo Drive: listar arquivos, agrupar, filtrar
      console.log(`[PublishExternal] Listing files in Drive folder ${body.folder_id}...`);
      const files = await listFilesInFolder(body.folder_id, body.drive_id);
      console.log(`[PublishExternal] Found ${files.length} image files`);

      const groups = groupFilesByAd(files);

      // Filtrar por ad_names se fornecido
      let targetAds = Array.from(groups.entries());
      if (body.ad_names && Array.isArray(body.ad_names) && body.ad_names.length > 0) {
        const nameSet = new Set(body.ad_names as string[]);
        targetAds = targetAds.filter(([code]) => nameSet.has(code));
      }

      // Auto-discovery: remover ads já publicados
      const existingNames = await getExistingAdNames(campaign.metaCampaignId);
      console.log(`[PublishExternal] Existing ads in campaign: ${existingNames.size}`);

      const newAds = targetAds.filter(([code, group]) => {
        if (existingNames.has(code)) {
          console.log(`[PublishExternal] Skipping ${code} — already published`);
          return false;
        }
        if (!group.feed || !group.stories) {
          console.log(`[PublishExternal] Skipping ${code} — missing ${!group.feed ? "Feed" : "Stories"}`);
          return false;
        }
        return true;
      });

      console.log(`[PublishExternal] ${newAds.length} new ads to publish`);

      // Download imagens do Drive
      for (const [code, group] of newAds) {
        console.log(`[PublishExternal] Downloading ${code} from Drive...`);
        const feedBuffer = await downloadFile(group.feed!.id);
        const storiesBuffer = await downloadFile(group.stories!.id);
        adsToPublish.push({ name: code, feedBuffer, storiesBuffer });
      }

    } else if (body.ads && Array.isArray(body.ads)) {
      // Modo base64 (fallback)
      for (const ad of body.ads) {
        adsToPublish.push({
          name: ad.name,
          feedBuffer: Buffer.from(ad.feed_image_base64, "base64"),
          storiesBuffer: Buffer.from(ad.stories_image_base64, "base64"),
        });
      }
    } else {
      return NextResponse.json({ error: "folder_id or ads array required" }, { status: 400 });
    }

    if (adsToPublish.length === 0) {
      return NextResponse.json({
        campaign: campaignKey,
        total: 0,
        succeeded: 0,
        failed: 0,
        message: "No new ads to publish — all are already live or missing Feed/Stories pair",
        results: [],
      });
    }

    // ── Buscar templates ──
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

    // ── Publicar cada ad ──
    const results: PublishResult[] = [];

    for (const ad of adsToPublish) {
      try {
        console.log(`[PublishExternal] Publishing ${ad.name}...`);

        // 1. Upload imagens
        const feedUpload = await meta.uploadImage(
          campaign.metaAccountId, ad.feedBuffer, `${ad.name}F.png`
        );
        const storiesUpload = await meta.uploadImage(
          campaign.metaAccountId, ad.storiesBuffer, `${ad.name}S.png`
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

        // 4. Criar ad set
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
        console.error(`[PublishExternal] Failed ${ad.name}:`, err);
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
      total: adsToPublish.length,
      succeeded,
      failed,
      results,
    });
  } catch (err) {
    console.error("[PublishExternal]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
