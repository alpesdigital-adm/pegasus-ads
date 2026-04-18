/**
 * GET /api/attribution
 *
 * Modelo de atribuição first-touch + any-touch (tarefa 3.5).
 * Combina métricas de captação (Meta Ads) com dados validados de conversão (T4).
 *
 * Query params:
 *   - campaign_key  (optional, default T7_0003_RAT)
 *   - period        (optional, "7d" | "30d" | "all", default "all")
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (RLS)
 *  - 2 aggregate queries em sql`` tagged (LEFT JOIN + SUM + CASE)
 *  - BUG CROSS-TENANT CORRIGIDO: o código legado não tinha filtro
 *    WHERE workspace_id = ? — agregava métricas de TODAS as workspaces.
 *    Agora com withWorkspace + RLS, filtragem é automática e correta.
 *    Se o Track F de smoke test revelar números diferentes antes/depois
 *    deste commit, é porque antes misturava dados de múltiplas workspaces.
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";

export const runtime = "nodejs";

// ── Constantes validadas T4 (2026-03-31) ──
// Fonte: reference_attribution_model.md
const T4_VALIDATED = {
  cpl_ebook_first_touch: 32.77,       // R$ — CPL real via ebook captação
  cpl_evento_direto: 58.70,           // R$ — CPL via evento sem ebook
  conv_rate_first_touch: 0.0144,      // 1,44% — leads/matriculados (first-touch)
  conv_rate_total: 0.0195,            // 1,95% — inclui orgânico/indicação
  sample_leads_first_touch: 233,
  sample_total_leads: 16136,
  multi_ebook_effect: {
    one_ebook: 0.0122,    // 1,22%
    two_ebooks: 0.0457,   // 4,57%
    three_plus: 0.0624,   // 6,24%
  },
  mid_funnel_any_touch_multiplier: 1.65,
};

type Period = "7d" | "30d" | "all";

function periodDateThreshold(period: Period): string | null {
  if (period === "7d") {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split("T")[0];
  }
  if (period === "30d") {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  }
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const campaignKey = searchParams.get("campaign_key") ?? "T7_0003_RAT";
    const period = (searchParams.get("period") ?? "all") as Period;

    const campaign = KNOWN_CAMPAIGNS[campaignKey];
    const cplTarget = campaign?.cplTarget ?? T4_VALIDATED.cpl_ebook_first_touch;

    const dateThreshold = periodDateThreshold(period);

    // Aggregates — live + top creatives — dentro da mesma transaction
    // (withWorkspace escopa workspace_id via RLS em c, m).
    const { live, topCreatives } = await withWorkspace(auth.workspace_id, async (tx) => {
      const liveResult = await tx.execute(sql`
        SELECT
          COALESCE(SUM(m.spend), 0)       AS total_spend,
          COALESCE(SUM(m.leads), 0)       AS total_leads,
          COALESCE(SUM(m.impressions), 0) AS total_impressions,
          COALESCE(SUM(m.clicks), 0)      AS total_clicks
        FROM metrics m
        JOIN creatives c ON c.id = m.creative_id
        WHERE c.status NOT IN ('killed')
        ${dateThreshold ? sql`AND m.date >= ${dateThreshold}` : sql``}
      `);
      const liveRows = liveResult as unknown as Array<Record<string, unknown>>;

      const topResult = await tx.execute(sql`
        SELECT
          c.name,
          c.id,
          COALESCE(SUM(m.spend), 0) AS spend,
          COALESCE(SUM(m.leads), 0) AS leads,
          CASE WHEN SUM(m.leads) > 0 THEN SUM(m.spend) / SUM(m.leads) ELSE NULL END AS cpl
        FROM creatives c
        JOIN metrics m ON m.creative_id = c.id
        WHERE c.status NOT IN ('killed')
        ${dateThreshold ? sql`AND m.date >= ${dateThreshold}` : sql``}
        GROUP BY c.id, c.name
        HAVING SUM(m.leads) > 0
        ORDER BY cpl ASC
        LIMIT 10
      `);
      const topRows = topResult as unknown as Array<Record<string, unknown>>;

      return {
        live: liveRows[0] ?? {},
        topCreatives: topRows,
      };
    });

    const totalSpend = parseFloat(String(live.total_spend ?? 0)) || 0;
    const totalLeads = parseInt(String(live.total_leads ?? 0)) || 0;
    const liveCpl = totalLeads > 0 ? totalSpend / totalLeads : null;

    // ── First-touch attribution ──
    const ftCpl = liveCpl ?? cplTarget;
    const ftConvRate = T4_VALIDATED.conv_rate_first_touch;
    const ftProjectedMatriculas = Math.round(totalLeads * ftConvRate);

    // ── Any-touch attribution ──
    const atConvRate = ftConvRate * T4_VALIDATED.mid_funnel_any_touch_multiplier;
    const atLeadsAdjusted = Math.round(totalLeads * T4_VALIDATED.mid_funnel_any_touch_multiplier);
    const atProjectedMatriculas = Math.round(totalLeads * atConvRate);
    const multiEbookLift = ((atConvRate - ftConvRate) / ftConvRate) * 100;

    return NextResponse.json({
      campaign_key: campaignKey,
      period,

      live_metrics: {
        total_spend: totalSpend,
        total_leads: totalLeads,
        total_impressions: parseInt(String(live.total_impressions ?? 0)) || 0,
        total_clicks: parseInt(String(live.total_clicks ?? 0)) || 0,
        avg_cpl: liveCpl,
        cpl_target: cplTarget,
        cpl_vs_target_pct: liveCpl ? ((liveCpl - cplTarget) / cplTarget) * 100 : null,
      },

      first_touch: {
        description: "Atribuição conservadora — ebook que captou o lead. Base para budget allocation e projeções.",
        cpl: ftCpl,
        total_leads: totalLeads,
        conv_rate_pct: +(ftConvRate * 100).toFixed(2),
        projected_matriculas: ftProjectedMatriculas,
        validated_sample: `${T4_VALIDATED.sample_leads_first_touch} matriculados / ${T4_VALIDATED.sample_total_leads.toLocaleString()} leads (T4)`,
      },

      any_touch: {
        description: "Any-touch — atribui crédito a todos os ebooks da jornada. Mostra o upside real do funil multi-ebook.",
        cpl_adjusted: +(ftCpl / T4_VALIDATED.mid_funnel_any_touch_multiplier).toFixed(2),
        leads_adjusted: atLeadsAdjusted,
        conv_rate_adjusted_pct: +(atConvRate * 100).toFixed(2),
        projected_matriculas: atProjectedMatriculas,
        multi_ebook_lift_pct: +multiEbookLift.toFixed(1),
        multi_ebook_effect: {
          "1_ebook": `${(T4_VALIDATED.multi_ebook_effect.one_ebook * 100).toFixed(2)}%`,
          "2_ebooks": `${(T4_VALIDATED.multi_ebook_effect.two_ebooks * 100).toFixed(2)}%`,
          "3+_ebooks": `${(T4_VALIDATED.multi_ebook_effect.three_plus * 100).toFixed(2)}%`,
        },
      },

      top_creatives_by_cpl: topCreatives.map((r) => ({
        name: r.name,
        id: r.id,
        spend: parseFloat(String(r.spend ?? 0)),
        leads: parseInt(String(r.leads ?? 0)),
        cpl: r.cpl ? parseFloat(String(r.cpl)) : null,
      })),

      context: {
        validated_at: "2026-03-31",
        source: "T4 — 16.136 leads, 233 matriculados",
        model: "First-touch como base conservadora para projeções. Any-touch mostra upside sem precisar mudar alocação de budget.",
        notes: "Ebooks de meio-de-funil (ML, ANP, MPT, APO) aparecem 100-229% mais em jornadas de buyers via any-touch.",
      },
    });
  } catch (err) {
    console.error("[Attribution]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
