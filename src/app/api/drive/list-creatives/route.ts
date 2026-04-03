/**
 * GET /api/drive/list-creatives
 *
 * Lista criativos disponíveis no Google Drive, agrupa em pares Feed+Stories
 * e cruza com os ads já publicados na campanha Meta.
 *
 * Query params:
 *   - campaign_key   (opcional, default T7_0003_RAT)
 *   - folder_id      (opcional, usa pasta selecionada nas settings)
 *   - drive_id       (opcional, para Shared Drives)
 *
 * Resposta:
 * {
 *   folder_id, campaign_key, total, published, unpublished, missing_pair,
 *   creatives: [{
 *     name, has_pair, published, meta_ad_id?, meta_ad_status?,
 *     feed?:    { drive_id, drive_name, width, height },
 *     stories?: { drive_id, drive_name, width, height },
 *   }]
 * }
 *
 * Protegido por x-api-key (TEST_LOG_API_KEY).
 */
import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { listFilesInFolder, getSelectedFolderId, DriveFile } from "@/lib/google-drive";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";

export const runtime = "nodejs";
export const maxDuration = 60;

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  const expected = process.env.TEST_LOG_API_KEY;
  if (!expected) return false;
  return key === expected;
}

// ── Tipos ──

interface DriveCreativeFile {
  drive_id: string;
  drive_name: string;
  width: number;
  height: number;
}

interface CreativeListItem {
  name: string;
  has_pair: boolean;
  published: boolean;
  meta_ad_id?: string;
  meta_ad_status?: string;
  feed?: DriveCreativeFile;
  stories?: DriveCreativeFile;
}

// ── Helpers ──

/**
 * Agrupa arquivos do Drive por código de ad (ex: T4EBMX-AD05).
 * Determina Feed vs Stories por dimensões reais: ratio(h/w) > 1.5 = Stories.
 */
function groupFilesByAd(
  files: DriveFile[]
): Map<string, { feed?: DriveFile; stories?: DriveFile }> {
  const groups = new Map<string, { feed?: DriveFile; stories?: DriveFile }>();

  for (const file of files) {
    // Suporta: T4EBMX-AD05F.png, T4EBMXAD05F.png, T7EBMX-AD011S.png
    const match = file.name.match(/^(T\d+EBMX-?AD\d+)[FS]?\./i);
    if (!match) continue;

    const code = match[1].toUpperCase();
    if (!groups.has(code)) groups.set(code, {});
    const group = groups.get(code)!;

    const w = file.imageMediaMetadata?.width ?? 0;
    const h = file.imageMediaMetadata?.height ?? 0;
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
 * Busca ads da campanha no Meta com nome, id e status.
 * Retorna mapa: baseName → { id, status }
 */
async function getMetaAdsMap(
  campaignId: string,
  token: string
): Promise<Map<string, { id: string; status: string; effective_status: string }>> {
  const map = new Map<string, { id: string; status: string; effective_status: string }>();

  let url: string | null =
    `https://graph.facebook.com/v25.0/${campaignId}/ads` +
    `?fields=name,id,status,effective_status&limit=200&access_token=${token}`;

  while (url) {
    const res = await fetch(url);
    if (!res.ok) break;

    const data = (await res.json()) as {
      data?: Array<{ name: string; id: string; status: string; effective_status: string }>;
      paging?: { next?: string };
    };

    for (const ad of data.data ?? []) {
      // Normalizar nome: remover sufixo -IA e maiúsculo
      const baseName = ad.name.replace(/-IA$/i, "").toUpperCase();
      map.set(baseName, { id: ad.id, status: ad.status, effective_status: ad.effective_status });
    }

    url = data.paging?.next ?? null;
  }

  return map;
}

// ── Handler ──

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await initDb();

    const { searchParams } = new URL(req.url);
    const campaignKey = searchParams.get("campaign_key") ?? "T7_0003_RAT";
    const queryFolderId = searchParams.get("folder_id");
    const queryDriveId = searchParams.get("drive_id") ?? undefined;

    // ── Validar campanha ──
    const campaign = KNOWN_CAMPAIGNS[campaignKey];
    if (!campaign) {
      return NextResponse.json({ error: `Campaign ${campaignKey} not found` }, { status: 400 });
    }

    // ── Resolver folder_id ──
    const folderId = queryFolderId ?? (await getSelectedFolderId());
    if (!folderId) {
      return NextResponse.json(
        { error: "folder_id not provided and no folder selected in settings" },
        { status: 400 }
      );
    }

    // ── Resolver token Meta ──
    const tokenEnvVar = campaign.metaTokenEnvVar ?? "META_SYSTEM_USER_TOKEN";
    const metaToken = process.env[tokenEnvVar] ?? process.env.META_SYSTEM_USER_TOKEN ?? "";
    if (!metaToken) {
      return NextResponse.json({ error: "Meta token not configured" }, { status: 500 });
    }

    // ── 1. Listar arquivos no Drive ──
    const files = await listFilesInFolder(folderId, queryDriveId);
    const groups = groupFilesByAd(files);

    // ── 2. Buscar ads publicados na campanha ──
    const metaAdsMap = await getMetaAdsMap(campaign.metaCampaignId, metaToken);

    // ── 3. Montar lista de criativos ──
    const creatives: CreativeListItem[] = [];

    for (const [name, group] of Array.from(groups.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      const metaAd = metaAdsMap.get(name);

      const item: CreativeListItem = {
        name,
        has_pair: !!(group.feed && group.stories),
        published: !!metaAd,
        ...(metaAd && {
          meta_ad_id: metaAd.id,
          meta_ad_status: metaAd.effective_status,
        }),
        ...(group.feed && {
          feed: {
            drive_id: group.feed.id,
            drive_name: group.feed.name,
            width: group.feed.imageMediaMetadata?.width ?? 0,
            height: group.feed.imageMediaMetadata?.height ?? 0,
          },
        }),
        ...(group.stories && {
          stories: {
            drive_id: group.stories.id,
            drive_name: group.stories.name,
            width: group.stories.imageMediaMetadata?.width ?? 0,
            height: group.stories.imageMediaMetadata?.height ?? 0,
          },
        }),
      };

      creatives.push(item);
    }

    // ── 4. Adicionar ads publicados que não estão no Drive ──
    for (const [metaName, metaAd] of metaAdsMap.entries()) {
      if (!groups.has(metaName)) {
        creatives.push({
          name: metaName,
          has_pair: false,
          published: true,
          meta_ad_id: metaAd.id,
          meta_ad_status: metaAd.effective_status,
        });
      }
    }

    // Ordenar: não publicados primeiro, depois publicados
    creatives.sort((a, b) => {
      if (a.published !== b.published) return a.published ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    const published = creatives.filter((c) => c.published).length;
    const unpublished = creatives.filter((c) => !c.published).length;
    const missingPair = creatives.filter((c) => !c.published && !c.has_pair).length;

    return NextResponse.json({
      folder_id: folderId,
      campaign_key: campaignKey,
      total: creatives.length,
      published,
      unpublished,
      missing_pair: missingPair,
      creatives,
    });
  } catch (err) {
    console.error("[ListCreatives]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
