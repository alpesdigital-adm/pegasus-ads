/**
 * POST /api/kill-rules/evaluate
 *
 * Tarefa 2.5 — Kill Rules automáticas (L0-L5)
 *
 * Avalia todas as kill rules para todos os criativos com métricas.
 * Identifica o CPL do controle (generation=0) e usa como referência.
 *
 * Body JSON (opcional):
 * {
 *   cpl_target?:  number   // CPL target em R$ (padrão: 25)
 *   apply?:       boolean  // Se true, aplica status 'killed' no DB para regras kill
 *   dry_run?:     boolean  // Alias de apply=false (padrão: true = dry run)
 * }
 *
 * Resposta:
 * {
 *   cpl_target:    number
 *   control_cpl:   number | null
 *   evaluated:     number        // total de ADs avaliados
 *   triggered:     number        // ADs com alguma regra ativa
 *   applied:       number        // ADs que tiveram status atualizado no DB
 *   results: [
 *     {
 *       creative_id: string
 *       creative_name: string
 *       generation: number
 *       status: string
 *       metrics: { spend, leads, cpl, impressions, ctr, days_running }
 *       kill_rule: { level, name, action } | null
 *       all_rules: [{ level, name, action }]
 *       db_updated: boolean
 *     }
 *   ]
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { evaluateKillRules, evaluateAllKillRules } from "@/config/kill-rules";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";

export const runtime = "nodejs";

const DEFAULT_CPL_TARGET = KNOWN_CAMPAIGNS["T7_0003_RAT"]?.cplTarget ?? 25;

export async function POST(req: NextRequest) {
  const db = await initDb();

  interface EvaluateBody {
    cpl_target?: number;
    apply?: boolean;
    dry_run?: boolean;
  }

  let body: EvaluateBody = {};
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      body = await req.json();
    }
  } catch {
    // body vazio é ok
  }

  const cplTarget = body.cpl_target ?? DEFAULT_CPL_TARGET;
  // apply=true ou dry_run=false → aplica no DB
  const shouldApply = body.apply === true || body.dry_run === false;

  // ── 1. Buscar todos os criativos com métricas agregadas ──
  const result = await db.execute(`
    SELECT
      c.id,
      c.name,
      c.generation,
      c.status,
      c.parent_id,
      SUM(m.spend)                                          AS total_spend,
      SUM(m.impressions)                                    AS total_impressions,
      SUM(m.clicks)                                         AS total_clicks,
      SUM(m.leads)                                          AS total_leads,
      AVG(m.ctr)                                            AS avg_ctr,
      COUNT(DISTINCT m.date)                                AS days_count
    FROM creatives c
    JOIN metrics m ON m.creative_id = c.id
    GROUP BY c.id, c.name, c.generation, c.status, c.parent_id
    ORDER BY c.generation ASC, c.created_at ASC
  `);

  if (result.rows.length === 0) {
    return NextResponse.json({
      cpl_target: cplTarget,
      control_cpl: null,
      evaluated: 0,
      triggered: 0,
      applied: 0,
      results: [],
      note: "Nenhum criativo com métricas encontrado.",
    });
  }

  // ── 2. Identificar control CPL (generation=0) ──
  let controlCpl: number | null = null;
  for (const row of result.rows) {
    if ((row.generation as number) === 0) {
      const totalSpend = Number(row.total_spend ?? 0);
      const totalLeads = Number(row.total_leads ?? 0);
      if (totalLeads > 0) {
        controlCpl = totalSpend / totalLeads;
        break;
      }
    }
  }

  // ── 3. Avaliar kill rules por criativo ──
  const results = [];
  let triggered = 0;
  let applied = 0;

  for (const row of result.rows) {
    const totalSpend = Number(row.total_spend ?? 0);
    const totalLeads = Number(row.total_leads ?? 0);
    const totalImpressions = Number(row.total_impressions ?? 0);
    const avgCtr = Number(row.avg_ctr ?? 0);
    const daysRunning = Number(row.days_count ?? 0);
    const cpl = totalLeads > 0 ? totalSpend / totalLeads : null;

    const killMetrics = {
      spend: totalSpend,
      leads: totalLeads,
      cpl,
      impressions: totalImpressions,
      ctr: avgCtr,
      cplTarget,
      controlCpl,
      daysRunning,
    };

    const primaryRule = evaluateKillRules(killMetrics);
    const allRules = evaluateAllKillRules(killMetrics);

    if (primaryRule) triggered++;

    // Aplicar no DB se solicitado e a regra é "kill"
    let dbUpdated = false;
    if (shouldApply && primaryRule?.action === "kill") {
      const currentStatus = row.status as string;
      if (currentStatus !== "killed" && currentStatus !== "winner") {
        try {
          await db.execute({
            sql: `UPDATE creatives SET status = 'killed' WHERE id = ?`,
            args: [row.id],
          });
          dbUpdated = true;
          applied++;
        } catch (err) {
          console.error(`[KillRules] Erro ao matar criativo ${row.id}:`, err);
        }
      }
    }

    results.push({
      creative_id: row.id,
      creative_name: row.name,
      generation: row.generation,
      status: dbUpdated ? "killed" : row.status,
      metrics: {
        spend: totalSpend,
        leads: totalLeads,
        cpl: cpl !== null ? Math.round(cpl * 100) / 100 : null,
        impressions: totalImpressions,
        ctr: avgCtr,
        days_running: daysRunning,
      },
      kill_rule: primaryRule
        ? { level: primaryRule.level, name: primaryRule.name, action: primaryRule.action }
        : null,
      all_rules: allRules.map((r) => ({
        level: r.level,
        name: r.name,
        action: r.action,
      })),
      db_updated: dbUpdated,
    });
  }

  return NextResponse.json({
    cpl_target: cplTarget,
    control_cpl: controlCpl !== null ? Math.round(controlCpl * 100) / 100 : null,
    evaluated: result.rows.length,
    triggered,
    applied,
    dry_run: !shouldApply,
    results,
  });
}

// GET — resumo rápido sem body
export async function GET(req: NextRequest) {
  return POST(
    new NextRequest(req.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  );
}
