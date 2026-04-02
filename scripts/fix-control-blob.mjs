#!/usr/bin/env node
/**
 * scripts/fix-control-blob.mjs
 * Tarefa 1.5 — Imagem controle limpa (execução local)
 *
 * Re-faz upload das imagens T7EBMX-AD006F.png e T7EBMX-AD006S.png
 * (versões limpas, sem overlay "Conteúdo Sensível" da Meta) para
 * o Vercel Blob e atualiza o blob_url no Neon DB.
 *
 * ── Pré-requisitos ──────────────────────────────────────────────
 * 1. Node 18+
 * 2. Instale os pacotes (já estão no package.json do projeto):
 *      npm install
 * 3. As imagens limpas devem estar em uma das pastas abaixo:
 *      - ../Documents/Pegasus Ads/   (pasta padrão)
 *      - Informe IMAGES_DIR se estiver em outro local
 *
 * ── Como executar ───────────────────────────────────────────────
 * Na raiz do projeto pegasus-ads:
 *
 *   DATABASE_URL="postgres://..." \
 *   BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..." \
 *   node scripts/fix-control-blob.mjs
 *
 * Ou com dotenv-cli:
 *   npx dotenv -e .env.local -- node scripts/fix-control-blob.mjs
 *
 * Para alterar a pasta das imagens:
 *   IMAGES_DIR="/caminho/para/pasta" node scripts/fix-control-blob.mjs
 * ────────────────────────────────────────────────────────────────
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuração ──────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// Pasta onde estão as imagens limpas
const IMAGES_DIR =
  process.env.IMAGES_DIR ||
  resolve(__dirname, "../../Documents/Pegasus Ads");

const CREATIVES = [
  { name: "T7EBMX-AD006F", file: "T7EBMX-AD006F.png", mimeType: "image/png" },
  { name: "T7EBMX-AD006S", file: "T7EBMX-AD006S.png", mimeType: "image/png" },
];

// ── Validação ─────────────────────────────────────────────────────────────────

function validate() {
  const missing = [];
  if (!DATABASE_URL) missing.push("DATABASE_URL (ou POSTGRES_URL)");
  if (!BLOB_TOKEN) missing.push("BLOB_READ_WRITE_TOKEN");

  if (missing.length > 0) {
    console.error("❌  Variáveis de ambiente faltando:");
    missing.forEach((v) => console.error(`   • ${v}`));
    console.error("\nExemplo:");
    console.error(
      `  DATABASE_URL="postgres://..." BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..." node scripts/fix-control-blob.mjs`
    );
    process.exit(1);
  }

  for (const c of CREATIVES) {
    const filePath = resolve(IMAGES_DIR, c.file);
    if (!existsSync(filePath)) {
      console.error(`❌  Arquivo não encontrado: ${filePath}`);
      console.error(`   Defina IMAGES_DIR com o caminho correto.`);
      process.exit(1);
    }
  }

  console.log(`📂  Pasta de imagens: ${IMAGES_DIR}`);
}

// ── Upload Vercel Blob ────────────────────────────────────────────────────────

async function uploadToBlob(creative) {
  const filePath = resolve(IMAGES_DIR, creative.file);
  const buffer = readFileSync(filePath);
  const sizeKb = (buffer.length / 1024).toFixed(0);

  console.log(`⬆️   Upload: ${creative.name} (${sizeKb} KB)...`);

  // Usar a API REST do Vercel Blob diretamente (sem import dinâmico do SDK)
  // PUT https://blob.vercel-storage.com/<filename>
  const filename = `creatives/ctrl-clean-${creative.name}-${Date.now()}.png`;
  const response = await fetch(`https://blob.vercel-storage.com/${filename}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${BLOB_TOKEN}`,
      "Content-Type": creative.mimeType,
      "x-content-type": creative.mimeType,
      "x-add-random-suffix": "0",
    },
    body: buffer,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vercel Blob upload falhou (${response.status}): ${text}`);
  }

  const data = await response.json();
  const newUrl = data.url || data.downloadUrl;
  console.log(`✅  Upload OK → ${newUrl}`);
  return newUrl;
}

// ── Update Neon DB ────────────────────────────────────────────────────────────

async function updateDb(creativeName, newUrl) {
  // Usar a API REST do Neon diretamente via fetch (sem SDK)
  // Endpoint: https://console.neon.tech/api/v2/ — não, vamos usar o driver nativo
  // Na prática, o melhor é usar @neondatabase/serverless que suporta Node via WebSocket

  const { Pool } = await import("@neondatabase/serverless");
  const { neonConfig } = await import("@neondatabase/serverless");

  // Em ambiente Node (fora da Edge), precisamos do ws
  try {
    const ws = await import("ws");
    neonConfig.webSocketConstructor = ws.default || ws;
  } catch {
    // ws pode não estar instalado; tentar sem
    console.warn("   [aviso] pacote 'ws' não encontrado — tentando sem WebSocket polyfill");
  }

  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    // Verificar existência
    const check = await pool.query(
      `SELECT id, name, blob_url FROM creatives WHERE name = $1`,
      [creativeName]
    );

    if (check.rows.length === 0) {
      console.warn(`⚠️   Criativo '${creativeName}' não encontrado no DB.`);
      // Diagnóstico: mostrar AD006 existentes
      const diag = await pool.query(
        `SELECT id, name, blob_url FROM creatives WHERE name LIKE '%AD006%'`
      );
      if (diag.rows.length > 0) {
        console.log("   AD006 encontrados:");
        diag.rows.forEach((r) => console.log(`   • ${r.name} | ${r.blob_url}`));
      } else {
        console.warn("   Nenhum criativo com 'AD006' encontrado. Verifique o nome no DB.");
      }
      return;
    }

    const row = check.rows[0];
    const oldUrl = row.blob_url;

    await pool.query(
      `UPDATE creatives SET blob_url = $1 WHERE name = $2`,
      [newUrl, creativeName]
    );

    console.log(`✅  DB atualizado`);
    console.log(`   id  : ${row.id}`);
    console.log(`   name: ${creativeName}`);
    console.log(`   old : ${oldUrl}`);
    console.log(`   new : ${newUrl}`);
  } finally {
    await pool.end();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🚀  fix-control-blob.mjs — Tarefa 1.5 — Pegasus Ads\n");
  validate();
  console.log();

  let successCount = 0;

  for (const creative of CREATIVES) {
    console.log(`── ${creative.name} ──`);
    try {
      const newUrl = await uploadToBlob(creative);
      await updateDb(creative.name, newUrl);
      successCount++;
    } catch (err) {
      console.error(`❌  Erro em ${creative.name}:`, err.message);
    }
    console.log();
  }

  if (successCount === CREATIVES.length) {
    console.log("✅  Tarefa 1.5 concluída com sucesso!");
    console.log("   → Teste uma geração para confirmar que o controle está limpo.");
  } else {
    console.warn(`⚠️  ${successCount}/${CREATIVES.length} criativos atualizados. Verifique os erros acima.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
