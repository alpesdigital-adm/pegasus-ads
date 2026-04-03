/**
 * POST /api/setup/test-log-sheet
 * GET  /api/setup/test-log-sheet
 *
 * Cria (primeira chamada) ou sincroniza (chamadas subsequentes) o
 * "T7 - Registro de Testes de Criativos" no Google Sheets via Sheets API.
 *
 * Fluxo:
 *   GET  → retorna status: { deployed, spreadsheet_id, spreadsheet_url, last_sync }
 *   POST → cria ou atualiza planilha:
 *     1. Busca dados do banco (mesmo payload de /api/export/test-log)
 *     2a. Se nova: cria spreadsheet com 3 abas + headers + formatação
 *     2b. Se existente: lê aba Criativos para preservar campos manuais
 *     3. Escreve métricas (batchUpdate values)
 *     4. Implanta/atualiza Apps Script automaticamente
 *     5. Salva spreadsheet_id + last_sync no banco
 *
 * Retorna: { ok, action, spreadsheet_id, spreadsheet_url, summary }
 */

import { NextRequest, NextResponse } from "next/server";
import { getValidAccessToken, getSelectedFolderId } from "@/lib/google-drive";
import { getDb, initDb } from "@/lib/db";
import { evaluateKillRules } from "@/config/kill-rules";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { buildAppsScript } from "@/config/apps-script-template";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCRIPT_API = "https://script.googleapis.com/v1";
const DEFAULT_CPL_TARGET = KNOWN_CAMPAIGNS["T7_0003_RAT"]?.cplTarget ?? 25;

// ── Tipos internos ─────────────────────────────────────────────────────────────

interface SheetRow {
  nome: string;
  tipo: string;
  ia: string;
  parceria: string;
  campanhas: string;
  adsets: string;
  spend: number;
  impressoes: number;
  cpm: number;
  ctr: number;
  cliques: number;
  leads: number;
  cpl: number | null;
  veredito: string;
  hipotese: string;
  aprendizado: string;
  killRule: { level: string; name: string; action: string } | null;
}

const VEREDICTOS_AUTO = ["Kill L0", "Kill L1", "Kill L2", "Kill L3", "Kill L4", "Em teste"];

const CRIATIVOS_HEADERS = [
  "Nome", "Tipo", "IA", "Parceria", "Campanhas", "Ad Sets",
  "Spend (R$)", "Impressões", "CPM", "CTR", "Cliques", "LPVs", "Connect",
  "Leads", "CPL (R$)", "Conv", "Veredicto", "Hipótese", "Aprendizado",
];

const BRUTOS_HEADERS = [
  "Campanha", "Nome", "Meta Ad ID", "Data", "Spend (R$)", "Impressões",
  "CPM", "CTR", "Cliques", "Leads", "CPL (R$)",
];

// ── Helpers DB ─────────────────────────────────────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
  const db = getDb();
  const res = await db.execute({ sql: "SELECT value FROM settings WHERE key = ?", args: [key] });
  return res.rows.length > 0 ? (res.rows[0].value as string) : null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  const exists = await db.execute({ sql: "SELECT key FROM settings WHERE key = ?", args: [key] });
  if (exists.rows.length > 0) {
    await db.execute({ sql: "UPDATE settings SET value = ?, updated_at = NOW() WHERE key = ?", args: [value, key] });
  } else {
    await db.execute({ sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, NOW())", args: [key, value] });
  }
}

// ── Helpers de data ────────────────────────────────────────────────────────────

function getAdBaseName(name: string): string {
  return name.replace(/\.\w+$/, "").replace(/[FS]$/, "");
}

function dateRange(daysBack = 90): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { from: fmt(from), to: fmt(to) };
}

function nowBR(): string {
  return new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// ── Buscar dados do banco ──────────────────────────────────────────────────────

async function fetchData(cplTarget: number) {
  const db = await initDb();
  const { from, to } = dateRange(90);

  const creativesResult = await db.execute(`
    SELECT
      c.name, c.status, c.generation,
      SUM(m.spend)           AS total_spend,
      SUM(m.impressions)     AS total_impressions,
      SUM(m.clicks)          AS total_clicks,
      SUM(m.leads)           AS total_leads,
      AVG(m.cpm)             AS avg_cpm,
      AVG(m.ctr)             AS avg_ctr,
      COUNT(DISTINCT m.date) AS days_count
    FROM creatives c
    LEFT JOIN metrics m ON m.creative_id = c.id
      AND m.date BETWEEN '${from}' AND '${to}'
    GROUP BY c.id, c.name, c.status, c.generation
    ORDER BY c.generation ASC, c.created_at ASC
  `);

  let controlCpl: number | null = null;
  for (const row of creativesResult.rows) {
    if ((row.generation as number) === 0) {
      const spend = Number(row.total_spend ?? 0);
      const leads = Number(row.total_leads ?? 0);
      if (leads > 0) { controlCpl = spend / leads; break; }
    }
  }

  const criativos: SheetRow[] = creativesResult.rows.map((row) => {
    const spend    = Number(row.total_spend ?? 0);
    const leads    = Number(row.total_leads ?? 0);
    const impressions = Number(row.total_impressions ?? 0);
    const clicks   = Number(row.total_clicks ?? 0);
    const cpm      = Number(row.avg_cpm ?? 0);
    const ctr      = Number(row.avg_ctr ?? 0);
    const days     = Number(row.days_count ?? 0);
    const cpl      = leads > 0 ? spend / leads : null;

    const killRule = spend > 0
      ? evaluateKillRules({ spend, leads, cpl, impressions, ctr, cplTarget, controlCpl, daysRunning: days })
      : null;

    const veredito = killRule
      ? (killRule.action === "kill" ? `Kill ${killRule.level}` : killRule.action === "promote" ? "Vencedor" : "Em teste")
      : "";

    return {
      nome:        getAdBaseName(row.name as string),
      tipo:        "Imagem",
      ia:          "",
      parceria:    "",
      campanhas:   "",
      adsets:      "",
      spend:       Math.round(spend * 100) / 100,
      impressoes:  impressions,
      cpm:         Math.round(cpm * 100) / 100,
      ctr:         Math.round(ctr * 1e6) / 1e6,
      cliques:     clicks,
      leads,
      cpl:         cpl !== null ? Math.round(cpl * 100) / 100 : null,
      veredito,
      hipotese:    "",
      aprendizado: "",
      killRule:    killRule ? { level: killRule.level, name: killRule.name, action: killRule.action } : null,
    };
  });

  const rawResult = await db.execute(`
    SELECT c.name, m.date, m.spend, m.impressions, m.cpm, m.ctr, m.clicks, m.leads, m.cpl, m.meta_ad_id
    FROM creatives c
    JOIN metrics m ON m.creative_id = c.id
    WHERE m.date BETWEEN '${from}' AND '${to}'
    ORDER BY c.name ASC, m.date ASC
  `);

  const dadosBrutos = rawResult.rows.map((row) => ({
    nome:       getAdBaseName(row.name as string),
    date:       row.date as string,
    spend:      Math.round(Number(row.spend ?? 0) * 100) / 100,
    impressoes: Number(row.impressions ?? 0),
    cpm:        Math.round(Number(row.cpm ?? 0) * 100) / 100,
    ctr:        Number(row.ctr ?? 0),
    cliques:    Number(row.clicks ?? 0),
    leads:      Number(row.leads ?? 0),
    cpl:        row.cpl !== null ? Math.round(Number(row.cpl) * 100) / 100 : null,
    metaAdId:   row.meta_ad_id as string | null,
  }));

  return { criativos, dadosBrutos, controlCpl };
}

// ── Criar planilha nova ────────────────────────────────────────────────────────

async function createSpreadsheet(accessToken: string, title: string): Promise<{ spreadsheetId: string; sheets: { properties: { sheetId: number; title: string } }[] }> {
  const res = await fetch(SHEETS_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title },
      sheets: [
        { properties: { title: "Criativos",    sheetId: 0 } },
        { properties: { title: "Dados Brutos", sheetId: 1 } },
        { properties: { title: "Aprendizados", sheetId: 2 } },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Sheets create error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Mover planilha para a pasta dos criativos ──────────────────────────────────

async function moveToFolder(accessToken: string, fileId: string, folderId: string) {
  // Primeiro obtém os parents atuais para removê-los
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = metaRes.ok ? (await metaRes.json()) as { parents?: string[] } : { parents: [] };
  const removeParents = (meta.parents ?? []).join(",");

  const params = new URLSearchParams({ addParents: folderId, supportsAllDrives: "true", fields: "id" });
  if (removeParents) params.set("removeParents", removeParents);

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
    { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: "{}" }
  );
  if (!res.ok) {
    console.warn("[Drive] moveToFolder error:", res.status, await res.text());
  }
}

// ── Formatar header rows ───────────────────────────────────────────────────────

async function formatHeaders(accessToken: string, spreadsheetId: string) {
  const headerBg = { red: 0.067, green: 0.098, blue: 0.157 };
  const requests = [0, 1, 2].flatMap((sheetId) => [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: headerBg,
            textFormat: { bold: true, foregroundColor: { red: 0.88, green: 0.91, blue: 0.94 } },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
  ]);

  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) console.error("[Sheets] formatHeaders error:", await res.text());
}

// ── Ler linhas existentes da aba Criativos ─────────────────────────────────────

async function readExistingCriativos(accessToken: string, spreadsheetId: string): Promise<Map<string, string[]>> {
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent("Criativos!A2:S")}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return new Map();
  const data = (await res.json()) as { values?: string[][] };
  const map = new Map<string, string[]>();
  for (const row of data.values ?? []) {
    const nome = (row[0] ?? "").trim();
    if (nome) map.set(nome, row);
  }
  return map;
}

// ── Montar linhas para a aba Criativos ─────────────────────────────────────────

function buildCriativosRows(
  criativos: SheetRow[],
  existing: Map<string, string[]>
): (string | number | null)[][] {
  return criativos.map((c) => {
    const prev = existing.get(c.nome);

    // Campos manuais: preservar se já existirem
    const tipo        = prev?.[1] || c.tipo;
    const ia          = prev?.[2] || c.ia;
    const parceria    = prev?.[3] || c.parceria;
    const campanhas   = prev?.[4] || c.campanhas;
    const adsets      = prev?.[5] || c.adsets;
    const hipotese    = prev?.[17] || c.hipotese || (prev ? "" : "— (novo)");
    const aprendizado = prev?.[18] || c.aprendizado || (prev ? "" : "—");

    // Veredicto: manter se foi definido manualmente (não é auto-gerado)
    const prevVeredito = (prev?.[16] ?? "").trim();
    const veredito = prevVeredito && !VEREDICTOS_AUTO.includes(prevVeredito)
      ? prevVeredito
      : (c.veredito || "Em teste");

    return [
      c.nome, tipo, ia, parceria, campanhas, adsets,
      c.spend, c.impressoes, c.cpm, c.ctr, c.cliques,
      "", "",  // LPVs, Connect (não temos)
      c.leads, c.cpl ?? "", "",  // Conv
      veredito, hipotese, aprendizado,
    ];
  });
}

// ── Montar linhas para Dados Brutos ───────────────────────────────────────────

function buildBrutosRows(dadosBrutos: ReturnType<Awaited<ReturnType<typeof fetchData>>["dadosBrutos"]["map"]>) {
  return (dadosBrutos as { nome: string; date: string; spend: number; impressoes: number; cpm: number; ctr: number; cliques: number; leads: number; cpl: number | null; metaAdId: string | null }[]).map((d) => [
    "T7__0003", d.nome, d.metaAdId ?? "", d.date,
    d.spend, d.impressoes, d.cpm, d.ctr, d.cliques,
    d.leads, d.cpl ?? "",
  ]);
}

// ── Gravar dados via batchUpdate ───────────────────────────────────────────────

async function writeData(
  accessToken: string,
  spreadsheetId: string,
  criativosRows: (string | number | null)[][],
  brutosRows: (string | number | null)[][],
  cplTarget: number
) {
  const hoje = nowBR();
  const aprendizadosInfo = [`CPL Meta: R$${cplTarget.toFixed(2)} | Última atualização: ${hoje}`];

  const data = [
    { range: "Criativos!A1",    values: [CRIATIVOS_HEADERS] },
    { range: "Dados Brutos!A1", values: [BRUTOS_HEADERS] },
    { range: "Aprendizados!A1", values: [aprendizadosInfo] },
  ];

  if (criativosRows.length > 0) {
    data.push({ range: `Criativos!A2`, values: criativosRows as string[][] });
  }

  if (brutosRows.length > 0) {
    data.push({ range: `Dados Brutos!A2`, values: brutosRows as string[][] });
  }

  const res = await fetch(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  if (!res.ok) throw new Error(`Sheets batchUpdate error ${res.status}: ${await res.text()}`);
}

// ── Limpar Dados Brutos antes de reescrever ────────────────────────────────────

async function clearBrutos(accessToken: string, spreadsheetId: string) {
  await fetch(`${SHEETS_API}/${spreadsheetId}/values:batchClear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ranges: ["Dados Brutos!A2:Z"] }),
  });
}

// ── Deploy / update Apps Script ────────────────────────────────────────────────

async function deployOrUpdateScript(accessToken: string, spreadsheetId: string) {
  const apiKey    = process.env.TEST_LOG_API_KEY ?? "";
  const scriptSource = buildAppsScript({ spreadsheetId, apiKey });

  const manifest = JSON.stringify({
    timeZone: "America/Sao_Paulo",
    dependencies: {},
    exceptionLogging: "STACKDRIVER",
    runtimeVersion: "V8",
    oauthScopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/script.scriptapp",
      "https://www.googleapis.com/auth/script.external_request",
    ],
  });

  const files = [
    { name: "sync_test_log", type: "SERVER_JS", source: scriptSource },
    { name: "appsscript",    type: "JSON",       source: manifest },
  ];

  let scriptId = await getSetting("apps_script_id");

  if (!scriptId) {
    const createRes = await fetch(`${SCRIPT_API}/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pegasus Ads — Log de Testes", parentId: spreadsheetId }),
    });
    if (createRes.ok) {
      const created = (await createRes.json()) as { scriptId: string };
      scriptId = created.scriptId;
      await setSetting("apps_script_id", scriptId);
    } else {
      const errText = await createRes.text();
      console.warn("[Apps Script] Could not create project:", createRes.status, errText);
      return null;
    }
  }

  const contentRes = await fetch(`${SCRIPT_API}/projects/${scriptId}/content`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
  });

  if (!contentRes.ok) {
    console.warn("[Apps Script] Could not update content:", contentRes.status, await contentRes.text());
    // Se 404, script foi deletado — limpar ID para recriar na próxima chamada
    if (contentRes.status === 404) await setSetting("apps_script_id", "");
    return null;
  }

  return scriptId;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

export async function GET() {
  const spreadsheetId = await getSetting("test_log_spreadsheet_id");
  const lastSync      = await getSetting("test_log_last_sync");

  if (!spreadsheetId) {
    return NextResponse.json({ deployed: false });
  }

  return NextResponse.json({
    deployed: true,
    spreadsheet_id:  spreadsheetId,
    spreadsheet_url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    last_sync:       lastSync ?? null,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { cpl_target?: number };
  const cplTarget = body.cpl_target ?? DEFAULT_CPL_TARGET;

  // ── 1. Auth ──
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Google não conectado. Reconecte em /api/auth/google.", details: String(err) },
      { status: 401 }
    );
  }

  // ── 2. Dados do banco ──
  let data: Awaited<ReturnType<typeof fetchData>>;
  try {
    data = await fetchData(cplTarget);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "Erro ao buscar dados do banco.", details: String(err) },
      { status: 500 }
    );
  }

  // ── 3. Criar ou reutilizar planilha ──
  let spreadsheetId = await getSetting("test_log_spreadsheet_id");
  let action: "created" | "updated" = "updated";

  try {
    if (!spreadsheetId) {
      // Criar planilha nova
      const created = await createSpreadsheet(accessToken, "T7 - Registro de Testes de Criativos");
      spreadsheetId = created.spreadsheetId;
      action = "created";

      // Mover para a pasta dos criativos (se configurada)
      const folderId = await getSelectedFolderId();
      if (folderId) {
        await moveToFolder(accessToken, spreadsheetId, folderId);
      }

      // Formatar headers (bold + freeze)
      await formatHeaders(accessToken, spreadsheetId);

      // Salvar ID
      await setSetting("test_log_spreadsheet_id", spreadsheetId);
    }

    // ── 4. Ler dados existentes (para preservar campos manuais) ──
    const existingCriativos = await readExistingCriativos(accessToken, spreadsheetId);

    // ── 5. Montar linhas ──
    const criativosRows = buildCriativosRows(data.criativos, existingCriativos);
    const brutosRows    = buildBrutosRows(data.dadosBrutos);

    // ── 6. Limpar Dados Brutos (será reescrito) ──
    if (action === "updated") {
      await clearBrutos(accessToken, spreadsheetId);
    }

    // ── 7. Gravar dados ──
    await writeData(accessToken, spreadsheetId, criativosRows, brutosRows, cplTarget);

  } catch (err) {
    const msg = String(err);
    // Planilha pode ter sido deletada manualmente
    if (msg.includes("404") || msg.includes("not found")) {
      await setSetting("test_log_spreadsheet_id", "");
      return NextResponse.json(
        { ok: false, error: "Planilha não encontrada (pode ter sido deletada). Chame novamente para criar uma nova.", details: msg },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { ok: false, error: "Erro ao escrever na planilha.", details: msg },
      { status: 500 }
    );
  }

  // ── 8. Deploy / update Apps Script ──
  let scriptId: string | null = null;
  let scriptWarning: string | undefined;
  try {
    scriptId = await deployOrUpdateScript(accessToken, spreadsheetId);
    if (!scriptId) scriptWarning = "Apps Script não pôde ser implantado (scope script.projects necessário). Reconecte o Google para habilitar.";
  } catch (err) {
    scriptWarning = `Apps Script skipped: ${String(err)}`;
  }

  // ── 9. Salvar last_sync ──
  const now = new Date().toISOString();
  await setSetting("test_log_last_sync", now);

  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  return NextResponse.json({
    ok: true,
    action,
    spreadsheet_id:  spreadsheetId,
    spreadsheet_url: spreadsheetUrl,
    script_id:       scriptId,
    last_sync:       now,
    summary: {
      total_criativos: data.criativos.length,
      total_brutos:    data.dadosBrutos.length,
    },
    ...(scriptWarning && { script_warning: scriptWarning }),
  });
}
