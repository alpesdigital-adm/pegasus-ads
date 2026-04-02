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
 */

import { getDb } from "./db";

interface NamingConfig {
  prefix: string;        // ex: "T7EBMX"
  separator: string;     // ex: "-"
  adPrefix: string;      // ex: "AD"
  padLength: number;     // ex: 3 (AD001, AD012)
  extension: string;     // ex: ".png"
}

const DEFAULT_CONFIG: NamingConfig = {
  prefix: "T7EBMX",
  separator: "-",
  adPrefix: "AD",
  padLength: 3,
  extension: ".png",
};

/**
 * Detecta sufixo de placement baseado nas dimensões reais da imagem.
 * Feed (1:1 ou próximo) → "F"
 * Stories (9:16 ou próximo vertical) → "S"
 * Vídeo → "VD" (se aplicável)
 */
export function detectPlacementSuffix(width: number, height: number): "F" | "S" {
  const ratio = width / height;
  // Stories: ratio < 0.7 (vertical)
  // Feed: ratio >= 0.7 (quadrado ou horizontal)
  return ratio < 0.7 ? "S" : "F";
}

/**
 * Busca o próximo número de AD disponível no banco de dados.
 * Analisa todos os criativos existentes e retorna max + 1.
 */
export async function getNextAdNumber(config: NamingConfig = DEFAULT_CONFIG): Promise<number> {
  const db = getDb();
  const pattern = `${config.prefix}${config.separator}${config.adPrefix}%`;

  const result = await db.execute({
    sql: "SELECT name FROM creatives WHERE name LIKE ?",
    args: [pattern],
  });

  let maxNumber = 0;
  const regex = new RegExp(`${config.adPrefix}(\\d{${config.padLength}})`, "i");

  for (const row of result.rows) {
    const name = row.name as string;
    const match = name.match(regex);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  }

  return maxNumber + 1;
}

/**
 * Gera o nome completo de um criativo.
 *
 * @param adNumber - Número do AD (ex: 14)
 * @param width - Largura da imagem
 * @param height - Altura da imagem
 * @param config - Configuração de naming (opcional)
 * @returns Nome completo (ex: "T7EBMX-AD014F.png")
 */
export function generateCreativeName(
  adNumber: number,
  width: number,
  height: number,
  config: NamingConfig = DEFAULT_CONFIG
): string {
  const suffix = detectPlacementSuffix(width, height);
  const paddedNumber = String(adNumber).padStart(config.padLength, "0");
  return `${config.prefix}${config.separator}${config.adPrefix}${paddedNumber}${suffix}${config.extension}`;
}

/**
 * Gera par de nomes (Feed + Stories) para um mesmo AD number.
 */
export function generateCreativeNamePair(
  adNumber: number,
  config: NamingConfig = DEFAULT_CONFIG
): { feedName: string; storiesName: string } {
  const paddedNumber = String(adNumber).padStart(config.padLength, "0");
  const base = `${config.prefix}${config.separator}${config.adPrefix}${paddedNumber}`;

  return {
    feedName: `${base}F${config.extension}`,
    storiesName: `${base}S${config.extension}`,
  };
}

/**
 * Gera o nome do Ad no Meta Ads (sem extensão, sem sufixo de placement).
 * Ex: "T7EBMX-AD014"
 */
export function generateMetaAdName(
  adNumber: number,
  config: NamingConfig = DEFAULT_CONFIG
): string {
  const paddedNumber = String(adNumber).padStart(config.padLength, "0");
  return `${config.prefix}${config.separator}${config.adPrefix}${paddedNumber}`;
}

/**
 * Extrai o número do AD a partir de um nome de criativo.
 */
export function extractAdNumber(name: string): number | null {
  const match = name.match(/AD(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Valida se um nome segue a convenção correta.
 */
export function isValidCreativeName(name: string): boolean {
  return /^T\d+EBMX-AD\d{3}[FS](\.png)?$/i.test(name);
}

export { DEFAULT_CONFIG, type NamingConfig };
