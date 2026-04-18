/**
 * GET /api/budget/suggest
 *
 * Sugestão de redistribuição de budget entre criativos (tarefa 4.5).
 * Algoritmo: proporcional ao inverso do CPL (melhor CPL → mais budget).
 *
 * Params:
 *   campaign_key?   — funnel key (default: T7_0003_RAT)
 *   total_budget?   — verba total disponível em R$ (default: usa spend atual)
 *   period?         — "7d" | "30d" (default: "7d")
 *   top_n?          — número de criativos a incluir (default: 10, max: 30)
 *   min_leads?      — mínimo de leads para considerar (default: 3)
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (RLS)
 *  - Aggregate query em sql`` (CASE WHEN + COALESCE + LEFT JOIN GROUP BY)
 *  - BUGS LATENTES CORRIGIDOS NA MIGRAÇÃO:
 *    * `m.date_start` → `m.date` (schema usa TEXT 'date', não 'date_start')
 *    * `c.campaign_key` → `c.funnel_key` (creatives não tem campaign_key,
 *      a chave de funnel é funnel_key)
 *  Se esses bugs silenciavam no Neon, a rota nunca retornava dados
 *  agregados corretamente. Revisar se houve comportamento esperado
 *  dependente desses erros.
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";

export const runtime = "nodejs";

// Budget de exploração: % do total reservada para criativos sem dados
const EXPLORATION_BUDGET_PCT = 0.15;

interface CreativeMetric {
  id: string;
  name: string;
  status: string;
  is_control: boolean;
  total_spend: number;
  total_leads: number;
  cpl: number | null;
  has_data: boolean;
}

interface BudgetAllocation {
  creative_id: string;
  creative_name: string;
  status: string;
  is_control: boolean;
  current_cpl: number | null;
  weight: number;
  suggested_budget: number;
  suggested_budget_pct: number;
  rationale: string;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const campaignKey = searchParams.get("campaign_key") ?? "T7_0003_RAT";
  const period = searchParams.get("period") ?? "7d";
  const topN = Math.min(Number(searchParams.get("top_n") ?? "10"), 30);
  const minLeads = Number(searchParams.get("min_leads") ?? "3");

  const totalBudgetParam = searchParams.get("total_budget");
  let totalBudget: number | null = totalBudgetParam ? Number(totalBudgetParam) : null;

  const campaign = KNOWN_CAMPAIGNS[campaignKey as keyof typeof KNOWN_CAMPAIGNS];
  if (!campaign) {
    return NextResponse.json({ error: `Campaign '${campaignKey}' not found` }, { status: 404 });
  }

  const daysBack = period === "30d" ? 30 : 7;
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - daysBack);
  const dateFromStr = dateFrom.toISOString().split("T")[0];

  // Aggregate: criativos ativos (testing|winner) com spend/leads do período.
  // RLS escopa workspace_id em c (creatives) e m (metrics) via SET LOCAL.
  const creativeRows = await withWorkspace(auth.workspace_id, async (tx) => {
    const result = await tx.execute(sql`
      SELECT
        c.id,
        c.name,
        c.status,
        c.is_control,
        COALESCE(SUM(m.spend), 0)::DOUBLE PRECISION AS total_spend,
        COALESCE(SUM(m.leads), 0)::DOUBLE PRECISION AS total_leads,
        CASE
          WHEN SUM(m.leads) > 0
          THEN (SUM(m.spend) / SUM(m.leads))::DOUBLE PRECISION
          ELSE NULL
        END AS cpl,
        CASE WHEN SUM(m.leads) >= ${minLeads} THEN TRUE ELSE FALSE END AS has_data
      FROM creatives c
      LEFT JOIN metrics m ON m.creative_id = c.id AND m.date >= ${dateFromStr}
      WHERE c.funnel_key = ${campaignKey}
        AND c.status IN ('testing', 'winner')
      GROUP BY c.id, c.name, c.status, c.is_control
      ORDER BY cpl ASC NULLS LAST, total_spend DESC
      LIMIT ${topN}
    `);
    return result as unknown as CreativeMetric[];
  });

  if (creativeRows.length === 0) {
    return NextResponse.json({
      campaign_key: campaignKey,
      message: "Nenhum criativo ativo com métricas encontrado",
      allocations: [],
    });
  }

  // ── Estimar budget total se não fornecido ────────────────────────────────
  if (!totalBudget) {
    const totalSpend = creativeRows.reduce((s, r) => s + r.total_spend, 0);
    totalBudget = period === "7d" ? totalSpend : totalSpend / (daysBack / 7);
    totalBudget = Math.ceil(totalBudget / 50) * 50 || 500;
  }

  // ── Separar criativos com e sem dados suficientes ────────────────────────
  const withData = creativeRows.filter((r) => r.has_data && r.cpl !== null && r.cpl > 0);
  const noData = creativeRows.filter((r) => !r.has_data || r.cpl === null);

  const explorationPool = noData.length > 0 ? (totalBudget as number) * EXPLORATION_BUDGET_PCT : 0;
  const performancePool = (totalBudget as number) - explorationPool;

  // Peso = 1/CPL (CPL menor → peso maior)
  const weights = withData.map((r) => 1 / r.cpl!);
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  const allocations: BudgetAllocation[] = [];

  withData.forEach((r, i) => {
    const normalizedWeight = totalWeight > 0 ? weights[i] / totalWeight : 1 / withData.length;
    const suggestedBudget = Math.round(performancePool * normalizedWeight);
    const cplTarget = campaign.cplTarget ?? null;

    let rationale: string;
    if (r.is_control) {
      rationale = `Controle — CPL R$${r.cpl?.toFixed(2)} — manter como referência`;
    } else if (cplTarget && r.cpl! <= cplTarget * 0.85) {
      rationale = `Winner: CPL ${((1 - r.cpl! / cplTarget) * 100).toFixed(0)}% abaixo da meta → escalar`;
    } else if (cplTarget && r.cpl! <= cplTarget) {
      rationale = `Dentro da meta (CPL R$${r.cpl?.toFixed(2)} ≤ R$${cplTarget}) → manter budget`;
    } else {
      rationale = `CPL R$${r.cpl?.toFixed(2)} acima da meta → reduzir até melhora`;
    }

    allocations.push({
      creative_id: r.id,
      creative_name: r.name,
      status: r.status,
      is_control: r.is_control,
      current_cpl: r.cpl,
      weight: Math.round(normalizedWeight * 1000) / 1000,
      suggested_budget: suggestedBudget,
      suggested_budget_pct: Math.round(normalizedWeight * 100 * 10) / 10,
      rationale,
    });
  });

  if (noData.length > 0) {
    const explorePerCreative = Math.round(explorationPool / noData.length);
    const exploreWeight = 1 / noData.length;
    noData.forEach((r) => {
      allocations.push({
        creative_id: r.id,
        creative_name: r.name,
        status: r.status,
        is_control: r.is_control,
        current_cpl: null,
        weight: Math.round(exploreWeight * 1000) / 1000,
        suggested_budget: explorePerCreative,
        suggested_budget_pct:
          Math.round((explorationPool / (totalBudget as number)) * 100 * (1 / noData.length) * 10) / 10,
        rationale: `Dados insuficientes (< ${minLeads} leads) → budget de exploração`,
      });
    });
  }

  allocations.sort((a, b) => b.suggested_budget - a.suggested_budget);

  const totalAllocated = allocations.reduce((s, a) => s + a.suggested_budget, 0);
  const cplTarget = campaign.cplTarget ?? null;
  const avgCpl =
    withData.length > 0
      ? withData.reduce((s, r) => s + r.cpl!, 0) / withData.length
      : null;

  return NextResponse.json({
    campaign_key: campaignKey,
    period,
    cpl_target: cplTarget,
    avg_cpl_period: avgCpl ? Math.round(avgCpl * 100) / 100 : null,

    budget: {
      total: totalBudget,
      allocated: totalAllocated,
      performance_pool: Math.round(performancePool),
      exploration_pool: Math.round(explorationPool),
    },

    creatives_analyzed: creativeRows.length,
    creatives_with_data: withData.length,
    creatives_exploring: noData.length,

    allocations,

    methodology:
      "Proporcional ao inverso do CPL — criativos com CPL menor recebem maior share do budget de performance. " +
      `${Math.round(EXPLORATION_BUDGET_PCT * 100)}% reservado para exploração de novos criativos.`,
  });
}
