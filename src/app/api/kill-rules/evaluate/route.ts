/**
 * POST /api/kill-rules/evaluate
 *
 * Tarefa 2.5 — Kill Rules automáticas (L0-L5)
 *
 * Avalia todas as kill rules para todos os criativos com métricas.
 * Identifica o CPL do controle (is_control=true > generation=0) e usa
 * como referência.
 *
 * Body JSON (opcional):
 * {
 *   cpl_target?:  number   // CPL target em R$ (padrão: 25)
 *   apply?:       boolean  // Se true, aplica status 'killed' no DB
 *   dry_run?:     boolean  // Alias de apply=false (padrão: true = dry run)
 * }
 *
 * MIGRADO NA FASE 1C (Wave 2, otimizado):
 *  - getDb() → withWorkspace SINGLE TRANSACTION (sugestão do gêmeo VPS)
 *  - Aggregate SELECT + avaliação + bulk UPDATE na mesma tx
 *    → overhead de N transactions evitado (era 1 tx por UPDATE antes)
 *  - Bulk UPDATE via inArray(killedIds) — um único UPDATE para todos
 *    os criativos matados
 *  - BUG CROSS-TENANT CORRIGIDO: legado não tinha filtro workspace_id.
 *    Agora RLS filtra automático via withWorkspace.
 */

import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { creatives } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { evaluateKillRules, evaluateAllKillRules } from "@/config/kill-rules";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { inArray } from "drizzle-orm";

export const runtime = "nodejs";

const DEFAULT_CPL_TARGET = KNOWN_CAMPAIGNS["T7_0003_RAT"]?.cplTarget ?? 25;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

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
  const shouldApply = body.apply === true || body.dry_run === false;

  // Single transaction: SELECT + evaluate + bulk UPDATE
  const { rows, killedIds } = await withWorkspace(auth.workspace_id, async (tx) => {
    const aggResult = await tx.execute(sql`
      SELECT
        c.id,
        c.name,
        c.generation,
        c.is_control,
        c.status,
        c.parent_id,
        SUM(m.spend)           AS total_spend,
        SUM(m.impressions)     AS total_impressions,
        SUM(m.clicks)          AS total_clicks,
        SUM(m.leads)           AS total_leads,
        AVG(m.ctr)             AS avg_ctr,
        COUNT(DISTINCT m.date) AS days_count
      FROM creatives c
      JOIN metrics m ON m.creative_id = c.id
      GROUP BY c.id, c.name, c.generation, c.is_control, c.status, c.parent_id
      ORDER BY c.is_control DESC NULLS LAST, c.generation ASC, c.created_at ASC
    `);
    const rows = aggResult as unknown as Array<Record<string, unknown>>;

    // Collect IDs to kill (se shouldApply e primaryRule disparar)
    const killedIds: string[] = [];
    if (shouldApply) {
      for (const row of rows) {
        const totalSpend = Number(row.total_spend ?? 0);
        const totalLeads = Number(row.total_leads ?? 0);
        const totalImpressions = Number(row.total_impressions ?? 0);
        const avgCtr = Number(row.avg_ctr ?? 0);
        const daysRunning = Number(row.days_count ?? 0);
        const cpl = totalLeads > 0 ? totalSpend / totalLeads : null;

        const primaryRule = evaluateKillRules({
          spend: totalSpend, leads: totalLeads, cpl,
          impressions: totalImpressions, ctr: avgCtr,
          cpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
          daysRunning, cplTarget,
          benchmarkExists: false,
          rolling5dCpl: null,
          spend3d: 0, leads3d: 0, cpl3d: null,
          spend7d: 0, leads7d: 0, cpl7d: null,
        });

        if (primaryRule) {
          const currentStatus = row.status as string;
          if (currentStatus !== "killed" && currentStatus !== "winner") {
            killedIds.push(row.id as string);
          }
        }
      }

      // Bulk UPDATE: todos os matches num único statement
      if (killedIds.length > 0) {
        await tx
          .update(creatives)
          .set({ status: "killed" })
          .where(inArray(creatives.id, killedIds));
      }
    }

    return { rows, killedIds };
  });

  if (rows.length === 0) {
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

  // ── 2. Identificar control CPL (is_control=true > generation=0) ──
  let controlCpl: number | null = null;
  for (const row of rows) {
    if (row.is_control) {
      const totalSpend = Number(row.total_spend ?? 0);
      const totalLeads = Number(row.total_leads ?? 0);
      if (totalLeads > 0) { controlCpl = totalSpend / totalLeads; break; }
    }
  }
  if (controlCpl === null) {
    for (const row of rows) {
      if ((row.generation as number) === 0) {
        const totalSpend = Number(row.total_spend ?? 0);
        const totalLeads = Number(row.total_leads ?? 0);
        if (totalLeads > 0) { controlCpl = totalSpend / totalLeads; break; }
      }
    }
  }

  // ── 3. Montar resposta com flag db_updated baseado em killedIds ──
  const killedSet = new Set(killedIds);
  const results: Array<Record<string, unknown>> = [];
  let triggered = 0;

  for (const row of rows) {
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
      cpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
      daysRunning,
      cplTarget,
      benchmarkExists: false,
      rolling5dCpl: null as number | null,
      spend3d: 0, leads3d: 0, cpl3d: null as number | null,
      spend7d: 0, leads7d: 0, cpl7d: null as number | null,
    };

    const primaryRule = evaluateKillRules(killMetrics);
    const allRules = evaluateAllKillRules(killMetrics);

    if (primaryRule) triggered++;

    const dbUpdated = killedSet.has(row.id as string);

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
    evaluated: rows.length,
    triggered,
    applied: killedIds.length,
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
    }),
  );
}
