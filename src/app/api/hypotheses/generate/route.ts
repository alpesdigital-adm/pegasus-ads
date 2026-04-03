/**
 * POST /api/hypotheses/generate
 *
 * Gera hipóteses de teste por IA (tarefa 3.3).
 * Analisa performance atual dos criativos + biblioteca de variáveis visuais
 * e sugere a próxima variável a testar com fundamentação.
 *
 * Body:
 * {
 *   campaign_key?: string   (default T7_0003_RAT)
 *   top_n?: number          (quantos criativos analisar, default 10)
 * }
 *
 * Resposta:
 * {
 *   hypotheses: [{
 *     dimension, variable_code, hypothesis, rationale, priority,
 *     supporting_data, suggested_prompt_delta
 *   }]
 *   saved_ids: string[]
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { randomUUID } from "crypto";

export const runtime = "nodejs";
export const maxDuration = 90;

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  return !!process.env.TEST_LOG_API_KEY && key === process.env.TEST_LOG_API_KEY;
}

interface HypothesisResult {
  dimension: string;
  variable_code?: string;
  hypothesis: string;
  rationale: string;
  priority: number;
  supporting_data?: string;
  suggested_prompt_delta?: string;
}

/**
 * Chama Gemini (texto) para gerar hipóteses dado o contexto.
 */
async function callGeminiForHypotheses(
  context: string,
  campaignKey: string
): Promise<HypothesisResult[]> {
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
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );

    if (!res.ok) return [];

    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

    // Parse JSON — pode vir como array direto ou wrapper
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
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = await initDb();
    const body = await req.json().catch(() => ({}));
    const campaignKey = (body.campaign_key as string) ?? "T7_0003_RAT";
    const topN = (body.top_n as number) ?? 10;

    const campaign = KNOWN_CAMPAIGNS[campaignKey];

    // ── 1. Carregar performance dos criativos ──
    const perfRes = await db.execute({
      sql: `
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
        LIMIT ?
      `,
      args: [topN],
    });

    // ── 2. Carregar biblioteca de variáveis visuais ──
    const elemRes = await db.execute(
      "SELECT code, dimension, name, description, active_in_meta, priority FROM visual_elements ORDER BY dimension, priority"
    );

    // ── 3. Carregar hipóteses anteriores ──
    const prevRes = await db.execute({
      sql: "SELECT variable_dimension, variable_code, status FROM hypotheses WHERE campaign_key = ? ORDER BY created_at DESC LIMIT 20",
      args: [campaignKey],
    });

    // ── 4. Montar contexto para o modelo ──
    const cplTarget = campaign?.cplTarget ?? 25;

    const perfSummary = perfRes.rows
      .map(r => `- ${r.name} (gen ${r.generation}${r.is_control ? " [CONTROLE]" : ""}): CPL=${r.cpl ?? "sem leads"}, spend=R$${r.total_spend}, leads=${r.total_leads}, status=${r.status}${r.latest_kill_level ? `, kill=${r.latest_kill_level}` : ""}`)
      .join("\n");

    const libSummary = Object.entries(
      elemRes.rows.reduce((acc: Record<string, string[]>, r) => {
        const dim = r.dimension as string;
        if (!acc[dim]) acc[dim] = [];
        acc[dim].push(`${r.code}=${r.name}(meta_ativo=${r.active_in_meta})`);
        return acc;
      }, {})
    ).map(([dim, els]) => `${dim}: ${els.join(", ")}`).join("\n");

    const prevSummary = prevRes.rows.length > 0
      ? prevRes.rows.map(r => `- dim=${r.variable_dimension} code=${r.variable_code} status=${r.status}`).join("\n")
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

    // ── 5. Chamar IA ──
    const aiHypotheses = await callGeminiForHypotheses(context, campaignKey);

    // ── 6. Fallback: hipóteses baseadas em regras se IA falhar ──
    const hypotheses: HypothesisResult[] = aiHypotheses.length > 0
      ? aiHypotheses
      : [
          {
            dimension: "hero",
            variable_code: "H3",
            hypothesis: "Substituir hero fotográfico por médico cartoon (H3) aumenta CTR por contraste no feed",
            rationale: "H3 foi ativado pela Meta no Advantage+ mas não foi testado manualmente com variável isolada. Contraste estilístico pode diferenciar no feed saturado.",
            priority: 9,
            supporting_data: `CPL meta: R$${cplTarget}. H3 (cartoon) ativado pelo algoritmo Meta → sinal de potencial.`,
            suggested_prompt_delta: "Substituir o elemento hero por um médico ilustrado em estilo cartoon (anime/flat design), jaleco branco, expressão amigável. Manter todos os outros elementos iguais ao controle.",
          },
          {
            dimension: "copy",
            variable_code: "C2",
            hypothesis: "Headline 'Desbloqueie o poder' (C2) vs 'Grátis e Exclusivo' (C1) — curiosidade vs exclusividade",
            rationale: "C2 testa motivação de curiosidade vs escassez. Abordagens de 'poder' e 'segredo' tendem a performar bem em público médico por apelo ao expertise.",
            priority: 8,
            supporting_data: "C2 foi gerado pela IA Meta mas não testado isoladamente.",
            suggested_prompt_delta: "Alterar apenas o headline principal para: 'DESBLOQUEIE O PODER DO MINOXIDIL — Guia EXCLUSIVO para Médicos, Baixe GRÁTIS!' Manter hero, ebook, paleta e layout iguais ao controle.",
          },
          {
            dimension: "palette",
            variable_code: "P2",
            hypothesis: "Fundo escuro navy premium (P2) vs branco clean (P1) — percepção de autoridade",
            rationale: "P2 não foi ativado pela Meta — pode ser justamente por ser muito diferente do original (alto risco percebido). Vale testar manualmente para avaliar se a percepção premium aumenta conversão.",
            priority: 6,
            supporting_data: "Meta desativou P2 provavelmente por conservadorismo algorítmico. Diferença visual máxima — ideal para aprendizado.",
            suggested_prompt_delta: "Alterar apenas o fundo para dark navy/azul escuro premium (#0D1B2A). Elementos em branco/dourado. Manter hero, copy, ebook e layout idênticos ao controle.",
          },
        ];

    // ── 7. Salvar hipóteses no banco ──
    const savedIds: string[] = [];
    for (const h of hypotheses) {
      const id = randomUUID();
      await db.execute({
        sql: `INSERT INTO hypotheses (id, campaign_key, variable_dimension, variable_code, hypothesis, rationale, priority, ai_model)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id, campaignKey,
          h.dimension, h.variable_code ?? null,
          h.hypothesis, h.rationale,
          h.priority ?? 5,
          aiHypotheses.length > 0 ? "gemini-2.0-flash" : "rules-based",
        ],
      });
      savedIds.push(id);
    }

    return NextResponse.json({
      campaign_key: campaignKey,
      source: aiHypotheses.length > 0 ? "gemini-2.0-flash" : "rules-based-fallback",
      creatives_analyzed: perfRes.rows.length,
      hypotheses: hypotheses.map((h, i) => ({ ...h, id: savedIds[i] })),
      saved_ids: savedIds,
    });
  } catch (err) {
    console.error("[HypothesesGenerate]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
