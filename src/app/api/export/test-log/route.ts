/**
 * GET /api/export/test-log
 *
 * Tarefa 2.7 — Log de testes (planilha controle)
 *
 * Retorna JSON com todos os dados para o Apps Script sincronizar o Google Sheets
 * "T7 - Registro de Testes de Criativos" diretamente, sem download/upload de arquivo.
 *
 * Consumido por:
 * - scripts/sync_test_log.gs  (Apps Script container-bound na planilha)
 *
 * Query params:
 *   format?        - "json" (padrão) | "summary"
 *   cpl_target?    - CPL target em R$ (padrão: 25)
 *   date_from?     - YYYY-MM-DD (padrão: 90 dias atrás)
 *   date_to?       - YYYY-MM-DD (padrão: hoje)
 *
 * Resposta JSON:
 * {
 *   generated_at:   string
 *   cpl_target:     number
 *   period:         { from, to }
 *   control_cpl:    number | null
 *   summary: {
 *     total_creatives: number
 *     with_metrics:    number
 *     winners:         number
 *     kills:           number
 *   }
 *   criativos: [
 *     {
 *       nome:       string       // base name (sem F/S e extensão)
 *       status:     string
 *       generation: number
 *       spend:      number
 *       impressoes: number
 *       cpm:        number
 *       ctr:        number
 *       cliques:    number
 *       leads:      number
 *       cpl:        number | null
 *       kill_rule:  { level, name, action } | null
 *     }
 *   ]
 *   dados_brutos: [
 *     {
 *       nome:       string
 *       date:       string
 *       spend:      number
 *       impressoes: number
 *       cpm:        number
 *       ctr:        number
 *       cliques:    number
 *       leads:      number
 *       cpl:        number | null
 *       meta_ad_id: string | null
 *     }
 *   ]
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { evaluateKillRules } from "@/config/kill-rules";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";

const DEFAULT_CPL_TARGET = KNOWN_CAMPAIGNS["T7_0003_RAT"]?.cplTarget ?? 25;

function getAdBaseName(name: string): string {
  let n = name.replace(/\.\w+$/, "");
  n = n.replace(/[FS]$/, "");
  return n;
}

function getDateRange(daysBack = 90): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { from: fmt(from), to: fmt(to) };
}

export async function GET(req: NextRequest) {
  const db = await initDb();
  const { searchParams } = req.nextUrl;

  const cplTarget = parseFloat(searchParams.get("cpl_target") || String(DEFAULT_CPL_TARGET));
  const defaultRange = getDateRange(90);
  const dateFrom = searchParams.get("date_from") || defaultRange.from;
  const dateTo = searchParams.get("date_to") || defaultRange.to;

  // ── 1. Buscar criativos com métricas agregadas ──
  const creativesResult = await db.execute(`
    SELECT
      c.name,
      c.status,
      c.generation,
      SUM(m.spend)              AS total_spend,
      SUM(m.impressions)        AS total_impressions,
      SUM(m.clicks)             AS total_clicks,
      SUM(m.leads)              AS total_leads,
      AVG(m.cpm)                AS avg_cpm,
      AVG(m.ctr)                AS avg_ctr,
      COUNT(DISTINCT m.date)    AS days_count
    FROM creatives c
    LEFT JOIN metrics m ON m.creative_id = c.id
      AND m.date BETWEEN '${dateFrom}' AND '${dateTo}'
    GROUP BY c.id, c.name, c.status, c.generation
    ORDER BY c.generation ASC, c.created_at ASC
  `);

  // ── 2. Calcular controlCpl (generation=0) ──
  let controlCpl: number | null = null;
  for (const row of creativesResult.rows) {
    if ((row.generation as number) === 0) {
      const spend = Number(row.total_spend ?? 0);
      const leads = Number(row.total_leads ?? 0);
      if (leads > 0) {
        controlCpl = spend / leads;
        break;
      }
    }
  }

  // ── 3. Montar criativos com kill rule ──
  const criativos = creativesResult.rows.map((row) => {
    const baseName = getAdBaseName(row.name as string);
    const spend = Number(row.total_spend ?? 0);
    const leads = Number(row.total_leads ?? 0);
    const impressions = Number(row.total_impressions ?? 0);
    const clicks = Number(row.total_clicks ?? 0);
    const cpm = Number(row.avg_cpm ?? 0);
    const ctr = Number(row.avg_ctr ?? 0);
    const days = Number(row.days_count ?? 0);
    const cpl = leads > 0 ? spend / leads : null;

    const killRule = spend > 0
      ? evaluateKillRules({
          spend,
          leads,
          cpl,
          impressions,
          ctr,
          cplTarget,
          controlCpl,
          daysRunning: days,
        })
      : null;

    return {
      nome: baseName,
      status: row.status,
      generation: row.generation,
      spend: Math.round(spend * 100) / 100,
      impressoes: impressions,
      cpm: Math.round(cpm * 100) / 100,
      ctr: Math.round(ctr * 1e6) / 1e6,
      cliques: clicks,
      leads,
      cpl: cpl !== null ? Math.round(cpl * 100) / 100 : null,
      kill_rule: killRule
        ? { level: killRule.level, name: killRule.name, action: killRule.action }
        : null,
    };
  });

  // ── 4. Buscar dados brutos (por dia) ──
  const rawResult = await db.execute(`
    SELECT
      c.name,
      m.date,
      m.spend,
      m.impressions,
      m.cpm,
      m.ctr,
      m.clicks,
      m.leads,
      m.cpl,
      m.meta_ad_id
    FROM creatives c
    JOIN metrics m ON m.creative_id = c.id
    WHERE m.date BETWEEN '${dateFrom}' AND '${dateTo}'
    ORDER BY c.name ASC, m.date ASC
  `);

  const dadosBrutos = rawResult.rows.map((row) => ({
    nome: getAdBaseName(row.name as string),
    date: row.date,
    spend: Math.round(Number(row.spend ?? 0) * 100) / 100,
    impressoes: Number(row.impressions ?? 0),
    cpm: Math.round(Number(row.cpm ?? 0) * 100) / 100,
    ctr: Number(row.ctr ?? 0),
    cliques: Number(row.clicks ?? 0),
    leads: Number(row.leads ?? 0),
    cpl: row.cpl !== null ? Math.round(Number(row.cpl) * 100) / 100 : null,
    meta_ad_id: row.meta_ad_id || null,
  }));

  // ── 5. Summary ──
  const withMetrics = criativos.filter((c) => c.spend > 0);
  const kills = criativos.filter((c) => c.kill_rule?.action === "kill");
  const winners = criativos.filter((c) =>
    c.status === "winner" || c.kill_rule?.action === "promote"
  );

  const payload = {
    generated_at: new Date().toISOString(),
    cpl_target: cplTarget,
    period: { from: dateFrom, to: dateTo },
    control_cpl: controlCpl !== null ? Math.round(controlCpl * 100) / 100 : null,
    summary: {
      total_creatives: criativos.length,
      with_metrics: withMetrics.length,
      winners: winners.length,
      kills: kills.length,
    },
    criativos,
    dados_brutos: dadosBrutos,
  };

  // CORS: permite chamadas do Apps Script (*.google.com)
  return NextResponse.json(payload, {
    headers: {
      "Access-Control-Allow-Origin": "https://script.google.com",
      "Access-Control-Allow-Methods": "GET",
    },
  });
}

// OPTIONS: preflight CORS
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "https://script.google.com",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
