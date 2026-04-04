/**
 * GET /api/budget/suggest
 *
 * Sugestão de redistribuição de budget entre criativos (tarefa 4.5).
 * Algoritmo: proporcional ao inverso do CPL (melhor CPL → mais budget).
 *
 * Params:
 *   campaign_key?   — campanha (default: T7_0003_RAT)
 *   total_budget?   — verba total disponível em R$ (default: usa budget atual)
 *   period?         — "7d" | "30d" (default: "7d")
 *   top_n?          — número de criativos a incluir (default: 10)
 *   min_leads?      — mínimo de leads para considerar (default: 3)
 *
 * Lógica:
 *   1. Busca criativos ativos (status = 'testing' | 'winner') com métricas
 *   2. Filtra por min_leads (dados insuficientes → orçamento de exploração)
 *   3. Peso = 1 / CPL (normalizado) para criativos com dados suficientes
 *   4. Criativos sem dados suficientes recebem orçamento de exploração fixo
 *   5. Retorna alocação sugerida + diagnóstico por criativo
 *
 * Proteção: x-api-key = TEST_LOG_API_KEY
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
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

  const db = getDb();

  const { searchParams } = new URL(req.url);
  const campaignKey = searchParams.get("campaign_key") ?? "T7_0003_RAT";
  const period = searchParams.get("period") ?? "7d";
  const topN = Math.min(Number(searchParams.get("top_n") ?? "10"), 30);
  const minLeads = Number(searchParams.get("min_leads") ?? "3");

  // Budget total: parâmetro ou estimado pelo spend atual
  const totalBudgetParam = searchParams.get("total_budget");
  let totalBudget: number | null = totalBudgetParam ? Number(totalBudgetParam) : null;

  // ── Buscar campanha ──────────────────────────────────────────────────────
  const campaign = KNOWN_CAMPAIGNS[campaignKey as keyof typeof KNOWN_CAMPAIGNS];
  if (!campaign) {
    return NextResponse.json({ error: `Campaign '${campaignKey}' not found` }, { status: 404 });
  }

  // ── Buscar criativos ativos com métricas ─────────────────────────────────
  const daysBack = period === "30d" ? 30 : 7;
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - daysBack);
  const dateFromStr = dateFrom.toISOString().split("T")[0];

  const creativeResult = await db.execute({
    sql: `SELECT
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
       CASE WHEN SUM(m.leads) >= $3 THEN TRUE ELSE FALSE END AS has_data
     FROM creatives c
     LEFT JOIN metrics m ON m.creative_id = c.id AND m.date_start >= $2
     WHERE c.campaign_key = $1
       AND c.status IN ('testing', 'winner')
     GROUP BY c.id, c.name, c.status, c.is_control
     ORDER BY cpl ASC NULLS LAST, total_spend DESC
     LIMIT $4`,
    args: [campaignKey, dateFromStr, minLeads, topN],
  });
  const creativeRows = creativeResult.rows as unknown as CreativeMetric[];

  if (creativeRows.length === 0) {
    return NextResponse.json({
      campaign_key: campaignKey,
      message: "Nenhum criativo ativo com métricas encontrado",
      allocations: [],
    });
  }

  // ── Estimar budget total se não fornecido ────────────────────────────────
  if (!totalBudget) {
    const totalSpend = creativeRows.reduce((s: number, r: CreativeMetric) => s + r.total_spend, 0);
    // Projeta spend semanal (7d) ou mantém proporcional
    totalBudget = period === "7d" ? totalSpend : totalSpend / (daysBack / 7);
    // Arredonda para múltiplo de 50
    totalBudget = Math.ceil(totalBudget / 50) * 50 || 500;
  }

  // ── Separar criativos com e sem dados suficientes ────────────────────────
  const withData = creativeRows.filter((r: CreativeMetric) => r.has_data && r.cpl !== null && r.cpl > 0);
  const noData = creativeRows.filter((r: CreativeMetric) => !r.has_data || r.cpl === null);

  // Budget de exploração reservado para criativos sem dados
  const explorationPool = noData.length > 0 ? (totalBudget as number) * EXPLORATION_BUDGET_PCT : 0;
  const performancePool = (totalBudget as number) - explorationPool;

  // ── Calcular pesos por CPL inverso ────────────────────────────────────────
  // Peso = 1/CPL → CPL menor = peso maior
  const weights = withData.map((r: CreativeMetric) => 1 / r.cpl!);
  const totalWeight = weights.reduce((s: number, w: number) => s + w, 0);

  const allocations: BudgetAllocation[] = [];

  // Criativos com dados suficientes
  withData.forEach((r: CreativeMetric, i: number) => {
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

  // Criativos sem dados suficientes — exploração uniforme
  if (noData.length > 0) {
    const explorePerCreative = Math.round(explorationPool / noData.length);
    const exploreWeight = 1 / noData.length;
    noData.forEach((r: CreativeMetric) => {
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

  // ── Ordenar por budget sugerido desc ─────────────────────────────────────
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
