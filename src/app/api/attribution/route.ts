/**
 * GET /api/attribution
 *
 * Modelo de atribuição first-touch + any-touch (tarefa 3.5).
 * Combina métricas de captação (Meta Ads) com dados validados de conversão (T4).
 *
 * Retorna:
 * {
 *   first_touch: { cpl, leads, conv_rate, projected_revenue, description }
 *   any_touch:   { cpl_adjusted, leads_adjusted, conv_rate_adjusted, multi_ebook_lift }
 *   live_metrics: { total_spend, total_leads, avg_cpl, campaign_key }
 *   context: { validated_at, source, notes }
 * }
 *
 * Query params:
 *   - campaign_key  (optional, default T7_0003_RAT)
 *   - period        (optional, "7d" | "30d" | "all", default "all")
 */
import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
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
  // Efeito multi-ebook (any-touch): uplift na conversão
  multi_ebook_effect: {
    one_ebook: 0.0122,    // 1,22%
    two_ebooks: 0.0457,   // 4,57%
    three_plus: 0.0624,   // 6,24%
  },
  // Ebooks de meio-de-funil têm 100-229% mais presença any-touch vs first-touch
  mid_funnel_any_touch_multiplier: 1.65,  // média conservadora
};

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  return !!process.env.TEST_LOG_API_KEY && key === process.env.TEST_LOG_API_KEY;
}

function periodFilter(period: string): string {
  if (period === "7d") return `AND m.date >= (CURRENT_DATE - INTERVAL '7 days')::TEXT`;
  if (period === "30d") return `AND m.date >= (CURRENT_DATE - INTERVAL '30 days')::TEXT`;
  return "";
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = await initDb();
    const { searchParams } = new URL(req.url);
    const campaignKey = searchParams.get("campaign_key") ?? "T7_0003_RAT";
    const period = searchParams.get("period") ?? "all";

    const campaign = KNOWN_CAMPAIGNS[campaignKey];
    const cplTarget = campaign?.cplTarget ?? T4_VALIDATED.cpl_ebook_first_touch;

    // ── Métricas ao vivo do banco ──
    const periodSql = periodFilter(period);
    const liveRes = await db.execute(`
      SELECT
        COALESCE(SUM(m.spend), 0)       AS total_spend,
        COALESCE(SUM(m.leads), 0)       AS total_leads,
        COALESCE(SUM(m.impressions), 0) AS total_impressions,
        COALESCE(SUM(m.clicks), 0)      AS total_clicks
      FROM metrics m
      JOIN creatives c ON c.id = m.creative_id
      WHERE c.status NOT IN ('killed')
      ${periodSql}
    `);

    const live = liveRes.rows[0] as {
      total_spend: string; total_leads: string;
      total_impressions: string; total_clicks: string;
    };

    const totalSpend = parseFloat(live.total_spend) || 0;
    const totalLeads = parseInt(live.total_leads) || 0;
    const liveCpl = totalLeads > 0 ? totalSpend / totalLeads : null;

    // ── First-touch attribution ──
    // CPL do banco (captação); conversão baseada no T4 validado
    const ftCpl = liveCpl ?? cplTarget;
    const ftConvRate = T4_VALIDATED.conv_rate_first_touch;
    const ftProjectedMatriculas = Math.round(totalLeads * ftConvRate);
    const ftProjectedRevenue = ftProjectedMatriculas; // multiplied by ticket externally

    // ── Any-touch attribution ──
    // Efeito multi-ebook: upside de 1,65x na conversão para leads que passaram por múltiplos ebooks
    const atConvRate = ftConvRate * T4_VALIDATED.mid_funnel_any_touch_multiplier;
    const atLeadsAdjusted = Math.round(totalLeads * T4_VALIDATED.mid_funnel_any_touch_multiplier);
    const atProjectedMatriculas = Math.round(totalLeads * atConvRate);
    const multiEbookLift = ((atConvRate - ftConvRate) / ftConvRate) * 100;

    // ── Breakdown por criativo (top performers) ──
    const topRes = await db.execute(`
      SELECT
        c.name,
        c.id,
        COALESCE(SUM(m.spend), 0) AS spend,
        COALESCE(SUM(m.leads), 0) AS leads,
        CASE WHEN SUM(m.leads) > 0 THEN SUM(m.spend) / SUM(m.leads) ELSE NULL END AS cpl
      FROM creatives c
      JOIN metrics m ON m.creative_id = c.id
      WHERE c.status NOT IN ('killed')
      ${periodSql}
      GROUP BY c.id, c.name
      HAVING SUM(m.leads) > 0
      ORDER BY cpl ASC
      LIMIT 10
    `);

    return NextResponse.json({
      campaign_key: campaignKey,
      period,

      live_metrics: {
        total_spend: totalSpend,
        total_leads: totalLeads,
        total_impressions: parseInt(live.total_impressions) || 0,
        total_clicks: parseInt(live.total_clicks) || 0,
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

      top_creatives_by_cpl: topRes.rows.map(r => ({
        name: r.name,
        id: r.id,
        spend: parseFloat(r.spend as string),
        leads: parseInt(r.leads as string),
        cpl: r.cpl ? parseFloat(r.cpl as string) : null,
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
