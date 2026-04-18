/**
 * GET /api/reports/weekly
 *
 * Gera relatório semanal de performance dos criativos (tarefa 5.3).
 * Retorna HTML completo pronto para envio/armazenamento.
 *
 * Params:
 *   campaign_key?  — default: T7_0003_RAT
 *   weeks_back?    — semanas atrás (default: 1 = semana passada)
 *   format?        — 'html' | 'json' (default: 'html')
 *
 * Proteção: requireAuth (session ou API key multi-tenant)
 *
 * MIGRADO NA FASE 1C (Wave 2) — 3 BUGS PRE-EXISTENTES CORRIGIDOS:
 *   1. `m.date_start` → `m.date` (schema usa TEXT 'date', 'date_start' não existe)
 *   2. `c.campaign_key` → `c.funnel_key` (creatives.campaign_key não existe;
 *      funnel_key é o identificador do funnel T4/T7/etc)
 *   3. `a.type = 'kill'` → `a.level IN ('L0','L1','L2')` (alerts.type não
 *      existe; coluna é `level`, e kill-level alerts têm L0/L1/L2 conforme
 *      kill-rules/evaluate)
 *
 * OBSERVAÇÃO: antes da migração o SQL provavelmente dava erro silencioso
 * (colunas inexistentes) — a rota retornava dados incompletos/fallbacks.
 * Com os fixes, kills-da-semana e alerts-da-semana agora populam com
 * dados reais. Se há dashboards consumindo, revisar antes de sign-off.
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

function formatDate(d: Date): string {
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatCurrency(v: number): string {
  return `R$${v.toFixed(2).replace(".", ",")}`;
}

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    testing: "🔬",
    winner: "🏆",
    killed: "💀",
    paused: "⏸️",
    control: "🎯",
  };
  return map[status] ?? "•";
}

function trendArrow(current: number | null, previous: number | null): string {
  if (!current || !previous) return "";
  const delta = ((current - previous) / previous) * 100;
  if (delta <= -10) return " ↓";
  if (delta >= 10) return " ↑";
  return " →";
}

// ── Gerador HTML ──────────────────────────────────────────────────────────────

function generateHtml(data: WeeklyReportData): string {
  const { period, campaign_key, summary, creatives, kills, winners, alerts } = data;

  const creatTableRows = creatives
    .map(
      (c) => `
    <tr style="border-bottom: 1px solid #eee;">
      <td style="padding: 8px 12px;">${statusEmoji(c.status)} ${c.name}</td>
      <td style="padding: 8px 12px; text-align:center;">${c.total_leads}</td>
      <td style="padding: 8px 12px; text-align:center;">${c.cpl ? formatCurrency(c.cpl) : "—"}</td>
      <td style="padding: 8px 12px; text-align:center;">${formatCurrency(c.total_spend)}</td>
      <td style="padding: 8px 12px; text-align:center; color:${c.status === "winner" ? "#276221" : c.status === "killed" ? "#cc0000" : "#555"};">${c.status}</td>
    </tr>`,
    )
    .join("");

  const killsSection =
    kills.length > 0
      ? `<div style="background:#fff3cd; border-left:4px solid #f0ad4e; padding:12px 16px; margin:16px 0; border-radius:4px;">
      <strong>⚠️ ${kills.length} criativo(s) pausado(s) esta semana por kill rules:</strong>
      <ul style="margin:8px 0 0 0; padding-left:20px;">${kills.map((k) => `<li>${k.name} — ${k.kill_reason}</li>`).join("")}</ul>
    </div>`
      : "";

  const winnersSection =
    winners.length > 0
      ? `<div style="background:#d4edda; border-left:4px solid #28a745; padding:12px 16px; margin:16px 0; border-radius:4px;">
      <strong>🏆 ${winners.length} criativo(s) promovido(s) a winner:</strong>
      <ul style="margin:8px 0 0 0; padding-left:20px;">${winners.map((w) => `<li>${w.name} — CPL ${formatCurrency(w.cpl ?? 0)}</li>`).join("")}</ul>
    </div>`
      : "";

  const alertsSection =
    alerts.length > 0
      ? `<div style="background:#f8d7da; border-left:4px solid #dc3545; padding:12px 16px; margin:16px 0; border-radius:4px;">
      <strong>🚨 ${alerts.length} alerta(s):</strong>
      <ul style="margin:8px 0 0 0; padding-left:20px;">${alerts.map((a) => `<li>${a.message}</li>`).join("")}</ul>
    </div>`
      : "";

  const cplTrend = trendArrow(summary.avg_cpl, summary.prev_avg_cpl);
  const leadsTrend = trendArrow(summary.total_leads, summary.prev_total_leads);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pegasus Ads — Relatório Semanal ${campaign_key}</title>
</head>
<body style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px; color: #333;">

<div style="background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; padding: 24px; border-radius: 8px; margin-bottom: 24px;">
  <h1 style="margin: 0 0 8px 0; font-size: 22px;">🚀 Pegasus Ads — Relatório Semanal</h1>
  <p style="margin: 0; opacity: 0.8; font-size: 14px;">${campaign_key} • ${formatDate(new Date(period.from))} – ${formatDate(new Date(period.to))}</p>
</div>

<!-- KPIs -->
<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px;">
  <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 16px; text-align: center;">
    <div style="font-size: 28px; font-weight: bold; color: #1a1a2e;">${summary.total_leads}${leadsTrend}</div>
    <div style="font-size: 12px; color: #666; margin-top: 4px;">Leads na semana</div>
  </div>
  <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 16px; text-align: center;">
    <div style="font-size: 28px; font-weight: bold; color: #1a1a2e;">${summary.avg_cpl ? formatCurrency(summary.avg_cpl) : "—"}${cplTrend}</div>
    <div style="font-size: 12px; color: #666; margin-top: 4px;">CPL médio</div>
  </div>
  <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 16px; text-align: center;">
    <div style="font-size: 28px; font-weight: bold; color: #1a1a2e;">${formatCurrency(summary.total_spend)}</div>
    <div style="font-size: 12px; color: #666; margin-top: 4px;">Investimento</div>
  </div>
  <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 16px; text-align: center;">
    <div style="font-size: 28px; font-weight: bold; color: #1a1a2e;">${summary.active_creatives}</div>
    <div style="font-size: 12px; color: #666; margin-top: 4px;">Criativos ativos</div>
  </div>
</div>

${killsSection}
${winnersSection}
${alertsSection}

<!-- Tabela de criativos -->
<h2 style="color: #1a1a2e; border-bottom: 2px solid #dee2e6; padding-bottom: 8px;">Performance dos Criativos</h2>
<table style="width: 100%; border-collapse: collapse; font-size: 14px;">
  <thead>
    <tr style="background: #f8f9fa;">
      <th style="padding: 10px 12px; text-align:left; border-bottom: 2px solid #dee2e6;">Criativo</th>
      <th style="padding: 10px 12px; text-align:center; border-bottom: 2px solid #dee2e6;">Leads</th>
      <th style="padding: 10px 12px; text-align:center; border-bottom: 2px solid #dee2e6;">CPL</th>
      <th style="padding: 10px 12px; text-align:center; border-bottom: 2px solid #dee2e6;">Spend</th>
      <th style="padding: 10px 12px; text-align:center; border-bottom: 2px solid #dee2e6;">Status</th>
    </tr>
  </thead>
  <tbody>
    ${creatTableRows}
  </tbody>
</table>

${
  summary.best_creative
    ? `<div style="background: #e8f5e9; border: 1px solid #a5d6a7; border-radius: 6px; padding: 12px 16px; margin-top: 16px;">
  <strong>🏆 Melhor criativo da semana:</strong> ${summary.best_creative.name} — CPL ${formatCurrency(summary.best_creative.cpl ?? 0)}
</div>`
    : ""
}

<div style="margin-top: 24px; font-size: 12px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 16px;">
  Gerado automaticamente pelo Pegasus Ads em ${formatDate(new Date())} • <a href="https://pegasus.alpesd.com.br" style="color: #1a1a2e;">pegasus.alpesd.com.br</a>
</div>

</body>
</html>`;
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface CreativeSummary {
  id: string;
  name: string;
  status: string;
  is_control: boolean;
  total_leads: number;
  total_spend: number;
  cpl: number | null;
}

interface WeeklyReportData {
  campaign_key: string;
  period: { from: string; to: string };
  summary: {
    total_leads: number;
    prev_total_leads: number | null;
    total_spend: number;
    avg_cpl: number | null;
    prev_avg_cpl: number | null;
    active_creatives: number;
    best_creative: CreativeSummary | null;
  };
  creatives: CreativeSummary[];
  kills: { name: string; kill_reason: string }[];
  winners: { name: string; cpl: number | null }[];
  alerts: { message: string }[];
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const campaignKey = searchParams.get("campaign_key") ?? "T7_0003_RAT";
  const weeksBack = Number(searchParams.get("weeks_back") ?? "1");
  const format = searchParams.get("format") ?? "html";

  // Calcular períodos
  const toDate = new Date();
  toDate.setDate(toDate.getDate() - (weeksBack - 1) * 7);
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 7);

  const prevFromDate = new Date(fromDate);
  prevFromDate.setDate(prevFromDate.getDate() - 7);

  const toStr = toDate.toISOString().split("T")[0];
  const fromStr = fromDate.toISOString().split("T")[0];
  const prevFromStr = prevFromDate.toISOString().split("T")[0];

  // 4 queries em withWorkspace — RLS escopa workspace_id em c (creatives),
  // a (alerts), e nas tabelas joinadas.
  const { creativeRows, prevRows, killRows, winnerRows, alertRows } =
    await withWorkspace(auth.workspace_id, async (tx) => {
      const creativeResult = await tx.execute(sql`
        SELECT
          c.id, c.name, c.status, c.is_control,
          COALESCE(SUM(m.leads), 0)::INT AS total_leads,
          COALESCE(SUM(m.spend), 0)::DOUBLE PRECISION AS total_spend,
          CASE WHEN SUM(m.leads) > 0
               THEN (SUM(m.spend)/SUM(m.leads))::DOUBLE PRECISION
               ELSE NULL END AS cpl
        FROM creatives c
        LEFT JOIN metrics m ON m.creative_id = c.id AND m.date >= ${fromStr} AND m.date <= ${toStr}
        WHERE c.funnel_key = ${campaignKey}
        GROUP BY c.id, c.name, c.status, c.is_control
        ORDER BY cpl ASC NULLS LAST, total_leads DESC
      `);

      const prevResult = await tx.execute(sql`
        SELECT
          COALESCE(SUM(m.leads), 0)::TEXT AS total_leads,
          CASE WHEN SUM(m.leads) > 0
               THEN (SUM(m.spend)/SUM(m.leads))::TEXT
               ELSE NULL END AS avg_cpl
        FROM creatives c
        JOIN metrics m ON m.creative_id = c.id AND m.date >= ${prevFromStr} AND m.date < ${fromStr}
        WHERE c.funnel_key = ${campaignKey}
      `);

      // FIX: a.type -> a.level IN ('L0','L1','L2') (kill-level alerts)
      const killResult = await tx.execute(sql`
        SELECT c.name,
          COALESCE(a.message, 'Kill rule disparada') AS kill_reason
        FROM creatives c
        LEFT JOIN alerts a ON a.creative_id = c.id
          AND a.created_at >= ${fromStr}
          AND a.level IN ('L0','L1','L2')
        WHERE c.funnel_key = ${campaignKey}
          AND c.status = 'killed'
      `);

      const winnerResult = await tx.execute(sql`
        SELECT c.name,
          (SELECT (SUM(m2.spend)/NULLIF(SUM(m2.leads),0))
           FROM metrics m2 WHERE m2.creative_id = c.id AND m2.date >= ${fromStr}) AS cpl
        FROM creatives c
        WHERE c.funnel_key = ${campaignKey}
          AND c.status = 'winner'
      `);

      // FIX: a.type != 'kill' -> a.level NOT IN ('L0','L1','L2')
      const alertResult = await tx.execute(sql`
        SELECT message FROM alerts
        WHERE campaign_key = ${campaignKey}
          AND created_at >= ${fromStr}
          AND level NOT IN ('L0','L1','L2')
        ORDER BY created_at DESC LIMIT 10
      `);

      return {
        creativeRows: creativeResult as unknown as CreativeSummary[],
        prevRows: prevResult as unknown as Array<{ total_leads: string; avg_cpl: string | null }>,
        killRows: killResult as unknown as Array<{ name: string; kill_reason: string }>,
        winnerRows: winnerResult as unknown as Array<{ name: string; cpl: number | null }>,
        alertRows: alertResult as unknown as Array<{ message: string }>,
      };
    });

  // ── Montar data do relatório ──────────────────────────────────────────────
  const activeCreatives = creativeRows.filter((c) =>
    ["testing", "winner"].includes(c.status),
  ).length;
  const totalLeads = creativeRows.reduce((s, c) => s + c.total_leads, 0);
  const totalSpend = creativeRows.reduce((s, c) => s + c.total_spend, 0);
  const withCpl = creativeRows.filter((c) => c.cpl !== null);
  const avgCpl =
    withCpl.length > 0
      ? withCpl.reduce((s, c) => s + c.cpl!, 0) / withCpl.length
      : null;
  const bestCreative =
    withCpl.length > 0
      ? withCpl.reduce((a, b) => (a.cpl! < b.cpl! ? a : b))
      : null;

  const reportData: WeeklyReportData = {
    campaign_key: campaignKey,
    period: { from: fromStr, to: toStr },
    summary: {
      total_leads: totalLeads,
      prev_total_leads: prevRows[0]?.total_leads ? Number(prevRows[0].total_leads) : null,
      total_spend: totalSpend,
      avg_cpl: avgCpl ? Math.round(avgCpl * 100) / 100 : null,
      prev_avg_cpl: prevRows[0]?.avg_cpl ? Math.round(Number(prevRows[0].avg_cpl) * 100) / 100 : null,
      active_creatives: activeCreatives,
      best_creative: bestCreative,
    },
    creatives: creativeRows,
    kills: killRows,
    winners: winnerRows,
    alerts: alertRows,
  };

  if (format === "json") {
    return NextResponse.json(reportData);
  }

  // Retornar HTML
  const html = generateHtml(reportData);
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `inline; filename="pegasus-report-${campaignKey}-${fromStr}.html"`,
    },
  });
}
