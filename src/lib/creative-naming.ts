/**
 * NamingService — Convenção de nomes para criativos Pegasus Ads.
 *
 * Padrão: T{N}EBMX-AD{NNN}{SUFFIX}
 * - T7EBMX = Campanha T7, Ebook MX
 * - AD001 = número sequencial
 * - F = Feed (1080x1080)
 * - S = Stories (1080x1920)
 * - Sem hífen antes do sufixo: T7EBMX-AD012F.png
 *
 * O sufixo F/S é determinado pelas dimensões reais da imagem, não por
 * declaração manual.
 *
 * MIGRADO NA FASE 1C (Wave 7 libs):
 *  - getDb() → withWorkspace + dbAdmin
 *  - getNextAdNumber agora exige workspaceId (antes era global, risco de
 *    colisão cross-tenant)
 *  - settings (global) via dbAdmin — TD-005 overlap
 */

import { withWorkspace, dbAdmin } from "./db";
import { creatives, publishedAds, settings } from "./db/schema";
import { eq, sql } from "drizzle-orm";

interface NamingConfig {
  prefix: string;
  separator: string;
  adPrefix: string;
  padLength: number;
  extension: string;
}

const DEFAULT_CONFIG: NamingConfig = {
  prefix: "T7EBMX",
  separator: "-",
  adPrefix: "AD",
  padLength: 3,
  extension: ".png",
};

export function detectPlacementSuffix(width: number, height: number): "F" | "S" {
  const ratio = width / height;
  return ratio < 0.7 ? "S" : "F";
}

/**
 * Busca o próximo número de AD disponível DENTRO do workspace.
 *
 * Fontes (todas escopadas ao workspace exceto settings, que é global):
 * 1. creatives (workspace via RLS)
 * 2. published_ads (workspace via RLS)
 * 3. settings (global, key=last_ad_number — override manual)
 */
export async function getNextAdNumber(
  workspaceId: string,
  config: NamingConfig = DEFAULT_CONFIG,
): Promise<number> {
  const regex = /AD(\d+)/i;

  const { maxFromCreatives, maxFromAds } = await withWorkspace(
    workspaceId,
    async (tx) => {
      let maxC = 0;
      const cRows = await tx
        .select({ name: creatives.name })
        .from(creatives)
        .where(sql`${creatives.name} LIKE '%AD%'`);
      for (const row of cRows) {
        const m = row.name.match(regex);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxC) maxC = n;
        }
      }

      let maxA = 0;
      try {
        const aRows = await tx
          .select({ adName: publishedAds.adName })
          .from(publishedAds)
          .where(sql`${publishedAds.adName} LIKE '%AD%'`);
        for (const row of aRows) {
          if (!row.adName) continue;
          const m = row.adName.match(regex);
          if (m) {
            const n = parseInt(m[1], 10);
            if (n > maxA) maxA = n;
          }
        }
      } catch {
        // tabela pode não existir em testes
      }

      return { maxFromCreatives: maxC, maxFromAds: maxA };
    },
  );

  let maxNumber = Math.max(maxFromCreatives, maxFromAds);

  try {
    const rows = await dbAdmin
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "last_ad_number"))
      .limit(1);
    if (rows.length > 0) {
      const n = parseInt(rows[0].value, 10);
      if (!isNaN(n) && n > maxNumber) maxNumber = n;
    }
  } catch {
    // ignore
  }

  return maxNumber + 1;
}

export function generateCreativeName(
  adNumber: number,
  width: number,
  height: number,
  config: NamingConfig = DEFAULT_CONFIG,
): string {
  const suffix = detectPlacementSuffix(width, height);
  const paddedNumber = String(adNumber).padStart(config.padLength, "0");
  return `${config.prefix}${config.separator}${config.adPrefix}${paddedNumber}${suffix}${config.extension}`;
}

export function generateCreativeNamePair(
  adNumber: number,
  config: NamingConfig = DEFAULT_CONFIG,
): { feedName: string; storiesName: string } {
  const paddedNumber = String(adNumber).padStart(config.padLength, "0");
  const base = `${config.prefix}${config.separator}${config.adPrefix}${paddedNumber}`;
  return {
    feedName: `${base}F${config.extension}`,
    storiesName: `${base}S${config.extension}`,
  };
}

export function generateMetaAdName(
  adNumber: number,
  config: NamingConfig = DEFAULT_CONFIG,
): string {
  const paddedNumber = String(adNumber).padStart(config.padLength, "0");
  return `${config.prefix}${config.separator}${config.adPrefix}${paddedNumber}`;
}

export function extractAdNumber(name: string): number | null {
  const match = name.match(/AD(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

export function isValidCreativeName(name: string): boolean {
  return /^T\d+EBMX-AD\d{3}[FS](\.png)?$/i.test(name);
}

export { DEFAULT_CONFIG, type NamingConfig };
