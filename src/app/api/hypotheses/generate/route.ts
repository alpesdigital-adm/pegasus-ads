/**
 * POST /api/hypotheses/generate
 *
 * Gera hipóteses de teste por IA (tarefa 3.3).
 *
 * MIGRADO NA FASE 1C (Wave 5):
 *  - getDb() → withWorkspace (RLS escopa creatives/metrics/alerts/
 *    visual_elements/hypotheses)
 *  - 4 queries em sql`` / Drizzle
 *  - randomUUID() manual removido (defaultRandom no schema)
 *  - Filtros workspace_id manuais removidos (RLS cobre)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { hypotheses as hypothesesTable, visualElements } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { asc, desc, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 90;

interface HypothesisResult {
  dimension: string;
  variable_code?: string;
  hypothesis: string;
  rationale: string;
  priority: number;
  supporting_data?: string;
  suggested_prompt_delta?: string;
}

async function callGeminiForHypotheses(context: string): Promise<HypothesisResult[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  const systemPrompt = `Você é um especialista em testes A/B para anúncios de marketing médico digital no Brasil.
Sua função é analisar dados de performance de criativos e sugerir hipóteses de teste com variável isolada.
Responda SEMPRE em JSON válido, array de objetos com exatamente os campos: dimension, variable_code, hypothesis, rationale, priority (1-10), supporting_data, suggested_prompt_delta.
Máximo 3 hipóteses. Ordene por priority decrescente (10 = mais urgente).`;

  const body = {
    contents: [{
      parts: [
        { text: systemPrompt },
        { text: context },
      ],
    }],
    generationConfig: {
      responseModalities: ["TEXT"],
      responseMimeType: "application/json",
    },
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    if (!res.ok) return [];
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : (parsed.hypotheses ?? []);
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json().catch(() => ({}));
    const campaignKey = (body.campaign_key as string) ?? "T7_0003_RAT";
    const topN = (body.top_n as number) ?? 10;
    const campaign = KNOWN_CAMPAIGNS[campaignKey];
    const cplTarget = campaign?.cplTarget ?? 25;

    // ── Carrega contexto: performance + biblioteca de elementos + hist. ──
    const { perfRows, elemRows, prevRows } = await withWorkspace(
      auth.workspace_id,
      async (tx) => {
        const perf = await tx.execute(sql`
          SELECT
            c.id, c.name, c.status, c.generation, c.is_control,
            COALESCE(SUM(m.spend), 0)       AS total_spend,
            COALESCE(SUM(m.leads), 0)       AS total_leads,
            COALESCE(SUM(m.impressions), 0) AS total_impressions,
            CASE WHEN SUM(m.leads) > 0 THEN ROUND((SUM(m.spend) / SUM(m.leads))::numeric, 2) ELSE NULL END AS cpl,
            MAX(kr.level)                   AS latest_kill_level
          FROM creatives c
          LEFT JOIN metrics m ON m.creative_id = c.id
          LEFT JOIN alerts kr ON kr.creative_id = c.id AND kr.resolved = FALSE
          WHERE c.status NOT IN ('killed')
          GROUP BY c.id, c.name, c.status, c.generation, c.is_control
          HAVING SUM(m.spend) > 0
          ORDER BY cpl ASC NULLS LAST
          LIMIT ${topN}
        `);

        const elem = await tx
          .select({
            code: visualElements.code,
            dimension: visualElements.dimension,
            name: visualElements.name,
            description: visualElements.description,
            activeInMeta: visualElements.activeInMeta,
            priority: visualElements.priority,
          })
          .from(visualElements)
          .orderBy(asc(visualElements.dimension), asc(visualElements.priority));

        const prev = await tx
          .select({
            variableDimension: hypothesesTable.variableDimension,
            variableCode: hypothesesTable.variableCode,
            status: hypothesesTable.status,
          })
          .from(hypothesesTable)
          .where(eq(hypothesesTable.campaignKey, campaignKey))
          .orderBy(desc(hypothesesTable.createdAt))
          .limit(20);

        return {
          perfRows: perf as unknown as Array<Record<string, unknown>>,
          elemRows: elem,
          prevRows: prev,
        };
      },
    );

    // ── Monta prompt ──
    const perfSummary = perfRows
      .map((r) => `- ${r.name} (gen ${r.generation}${r.is_control ? " [CONTROLE]" : ""}): CPL=${r.cpl ?? "sem leads"}, spend=R$${r.total_spend}, leads=${r.total_leads}, status=${r.status}${r.latest_kill_level ? `, kill=${r.latest_kill_level}` : ""}`)
      .join("\n");

    const libSummary = Object.entries(
      elemRows.reduce((acc: Record<string, string[]>, r) => {
        const dim = r.dimension;
        if (!acc[dim]) acc[dim] = [];
        acc[dim].push(`${r.code}=${r.name}(meta_ativo=${r.activeInMeta})`);
        return acc;
      }, {}),
    ).map(([dim, els]) => `${dim}: ${els.join(", ")}`).join("\n");

    const prevSummary = prevRows.length > 0
      ? prevRows.map((r) => `- dim=${r.variableDimension} code=${r.variableCode} status=${r.status}`).join("\n")
      : "Nenhuma hipótese anterior";

    const context = `
=== CONTEXTO DA CAMPANHA ===
Campanha: ${campaignKey}
CPL meta: R$${cplTarget}

=== PERFORMANCE ATUAL DOS CRIATIVOS (top ${topN}) ===
${perfSummary || "Nenhum criativo com spend"}

=== BIBLIOTECA DE VARIÁVEIS VISUAIS ===
${libSummary}

=== HIPÓTESES TESTADAS ANTERIORMENTE ===
${prevSummary}

=== TAREFA ===
Com base nesses dados, sugira as 3 melhores hipóteses de teste A/B com VARIÁVEL ISOLADA.
Priorize variáveis não testadas, com maior potencial de impacto no CPL.
Para cada hipótese inclua um suggested_prompt_delta: instrução específica para o Gemini gerar o criativo variante.
`.trim();

    const aiHypotheses = await callGeminiForHypotheses(context);

    const hypothesesList: HypothesisResult[] = aiHypotheses.length > 0
      ? aiHypotheses
      : [
          {
            dimension: "hero",
            variable_code: "H3",
            hypothesis: "Substituir hero fotográfico por médico cartoon (H3) aumenta CTR por contraste no feed",
            rationale: "H3 foi ativado pela Meta no Advantage+ mas não foi testado manualmente com variável isolada.",
            priority: 9,
            supporting_data: `CPL meta: R$${cplTarget}. H3 (cartoon) ativado pelo algoritmo Meta → sinal de potencial.`,
            suggested_prompt_delta: "Substituir o elemento hero por um médico ilustrado em estilo cartoon (anime/flat design), jaleco branco, expressão amigável. Manter todos os outros elementos iguais ao controle.",
          },
          {
            dimension: "copy",
            variable_code: "C2",
            hypothesis: "Headline 'Desbloqueie o poder' (C2) vs 'Grátis e Exclusivo' (C1) — curiosidade vs exclusividade",
            rationale: "C2 testa motivação de curiosidade vs escassez.",
            priority: 8,
            supporting_data: "C2 foi gerado pela IA Meta mas não testado isoladamente.",
            suggested_prompt_delta: "Alterar apenas o headline principal para: 'DESBLOQUEIE O PODER DO MINOXIDIL — Guia EXCLUSIVO para Médicos, Baixe GRÁTIS!' Manter hero, ebook, paleta e layout iguais ao controle.",
          },
          {
            dimension: "palette",
            variable_code: "P2",
            hypothesis: "Fundo escuro navy premium (P2) vs branco clean (P1) — percepção de autoridade",
            rationale: "P2 não foi ativado pela Meta — pode ser justamente por ser muito diferente do original.",
            priority: 6,
            supporting_data: "Meta desativou P2 provavelmente por conservadorismo algorítmico.",
            suggested_prompt_delta: "Alterar apenas o fundo para dark navy/azul escuro premium (#0D1B2A). Elementos em branco/dourado. Manter hero, copy, ebook e layout idênticos ao controle.",
          },
        ];

    // ── Persiste hipóteses ──
    const saved = await withWorkspace(auth.workspace_id, async (tx) => {
      const rows: Array<{ id: string }> = [];
      for (const h of hypothesesList) {
        const [r] = await tx
          .insert(hypothesesTable)
          .values({
            workspaceId: auth.workspace_id,
            campaignKey,
            variableDimension: h.dimension,
            variableCode: h.variable_code ?? null,
            hypothesis: h.hypothesis,
            rationale: h.rationale,
            priority: h.priority ?? 5,
            aiModel: aiHypotheses.length > 0 ? "gemini-2.0-flash" : "rules-based",
          })
          .returning({ id: hypothesesTable.id });
        rows.push(r);
      }
      return rows;
    });

    const savedIds = saved.map((r) => r.id);

    return NextResponse.json({
      campaign_key: campaignKey,
      source: aiHypotheses.length > 0 ? "gemini-2.0-flash" : "rules-based-fallback",
      creatives_analyzed: perfRows.length,
      hypotheses: hypothesesList.map((h, i) => ({ ...h, id: savedIds[i] })),
      saved_ids: savedIds,
    });
  } catch (err) {
    console.error("[HypothesesGenerate]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
