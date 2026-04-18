/**
 * GET  /api/visual-elements   — Lista todos os elementos, opcionalmente por dimensão ou funil
 * POST /api/visual-elements   — Cadastra novo elemento
 *
 * Galeria de variáveis visuais testáveis (tarefa 1.7).
 *
 * MIGRADO NA FASE 1C (Wave 4):
 *  - getDb() → withWorkspace (RLS escopa visual_elements)
 *  - Queries tipadas via Drizzle + schema
 *  - randomUUID() manual removido (defaultRandom no schema)
 *  - Filtros workspace_id manuais removidos (RLS cobre)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { visualElements } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

export const runtime = "nodejs";

// Seed inicial com dados do AD002-IA (Minoxidil)
const SEED_ELEMENTS = [
  { code: "H1", dimension: "hero", name: "Grupo de médicos", description: "Equipe médica em grupo, jaleco branco — transmite comunidade/pertencimento", active_in_meta: true, priority: 1 },
  { code: "H2", dimension: "hero", name: "Médico solo", description: "Um único profissional, olhar direto — transmite conexão pessoal", active_in_meta: true, priority: 2 },
  { code: "H3", dimension: "hero", name: "Médico ilustrado (cartoon)", description: "Personagem cartoon de médico com jaleco — contraste estilístico no feed", active_in_meta: true, priority: 3 },
  { code: "H4", dimension: "hero", name: "Ebook sozinho", description: "Livro 3D sem pessoas — foco total no objeto de desejo", active_in_meta: true, priority: 4 },
  { code: "H5", dimension: "hero", name: "Dra. Priscila (autoridade nomeada)", description: "Variação com nome e referência direta à autora — prova social de especialista", active_in_meta: false, priority: 5 },
  { code: "H6", dimension: "hero", name: "Instrumentos médicos", description: "Estetoscópio, seringa — contexto profissional via símbolos, sem pessoas", active_in_meta: false, priority: 6 },
  { code: "E1", dimension: "ebook", name: "Capa flat (2D) overlay", description: "Capa do ebook sobreposta à imagem, estilo original", active_in_meta: true, priority: 1 },
  { code: "E2", dimension: "ebook", name: "Mockup livro físico 3D", description: "Ebook renderizado como livro real com profundidade e sombra", active_in_meta: true, priority: 2 },
  { code: "E3", dimension: "ebook", name: "Ebook + selo 'E-book Informativo'", description: "Badge/selo ao lado do ebook — reforça tipo de conteúdo", active_in_meta: true, priority: 3 },
  { code: "E4", dimension: "ebook", name: "Ebook pequeno (secundário)", description: "Ebook menor, composição dominada por outros elementos", active_in_meta: false, priority: 4 },
  { code: "C1", dimension: "copy", name: "Exclusividade + Gratuidade", description: "GRÁTIS E EXCLUSIVO PARA MÉDICOS!", active_in_meta: true, priority: 1 },
  { code: "C2", dimension: "copy", name: "Desbloqueio de poder", description: "DESBLOQUEIE O PODER DO MINOXIDIL — Guia EXCLUSIVO para Médicos, Baixe GRÁTIS!", active_in_meta: true, priority: 2 },
  { code: "C3", dimension: "copy", name: "Autoridade nomeada", description: "Dra. Priscila Barreto apresenta soluções inovadoras em seu e-book", active_in_meta: false, priority: 3 },
  { code: "C4", dimension: "copy", name: "Título do ebook puro", description: "Minoxidil: do tópico ao sublingual (sem CTA visual)", active_in_meta: false, priority: 4 },
  { code: "P1", dimension: "palette", name: "Claro / branco-azulado", description: "Fundo claro, tom médico clean", active_in_meta: true, priority: 1 },
  { code: "P2", dimension: "palette", name: "Escuro / navy premium", description: "Fundo escuro com elementos dourados ou claros — sensação premium/sofisticada", active_in_meta: false, priority: 2 },
  { code: "P3", dimension: "palette", name: "Gradiente azul", description: "Transição de tons azuis — médico mas mais dinâmico", active_in_meta: false, priority: 3 },
  { code: "V1", dimension: "style", name: "Fotografia (stock médico)", description: "Fotos reais de profissionais de saúde", active_in_meta: true, priority: 1 },
  { code: "V2", dimension: "style", name: "Ilustração / Cartoon", description: "Personagem desenhado — quebra padrão do feed médico", active_in_meta: true, priority: 2 },
  { code: "V3", dimension: "style", name: "Composição mista (foto + grafismo)", description: "Foto com overlay pesado de elementos gráficos", active_in_meta: false, priority: 3 },
  { code: "L1", dimension: "layout", name: "Banner topo + hero + ebook", description: "Estrutura padrão: faixa vermelha no topo, imagem central, ebook overlay", active_in_meta: true, priority: 1 },
  { code: "L2", dimension: "layout", name: "Copy-driven (texto domina)", description: "Mais texto, menos imagem — foco na mensagem escrita", active_in_meta: true, priority: 2 },
  { code: "L3", dimension: "layout", name: "Objeto-driven (ebook centralizado)", description: "Ebook como elemento central, tudo ao redor apoia", active_in_meta: true, priority: 3 },
  { code: "L4", dimension: "layout", name: "Split (metade imagem / metade texto)", description: "Divisão clara entre área visual e área de copy", active_in_meta: false, priority: 4 },
];

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const dimension = searchParams.get("dimension");
  const funnelKey = searchParams.get("funnel_key");
  const activeOnly = searchParams.get("active_only") === "true";

  try {
    const rows = await withWorkspace(auth.workspace_id, async (tx) => {
      // Seed automático se tabela vazia para este workspace
      const existing = await tx
        .select({ id: visualElements.id })
        .from(visualElements)
        .limit(1);

      if (existing.length === 0) {
        await tx
          .insert(visualElements)
          .values(
            SEED_ELEMENTS.map((el) => ({
              workspaceId: auth.workspace_id,
              code: el.code,
              dimension: el.dimension,
              name: el.name,
              description: el.description,
              activeInMeta: el.active_in_meta,
              priority: el.priority,
              funnelKey: null,
            })),
          )
          .onConflictDoNothing({
            target: [visualElements.code, visualElements.funnelKey],
          });
      }

      const whereParts = [];
      if (dimension) whereParts.push(eq(visualElements.dimension, dimension));
      if (funnelKey) {
        whereParts.push(
          or(eq(visualElements.funnelKey, funnelKey), isNull(visualElements.funnelKey)),
        );
      } else {
        whereParts.push(isNull(visualElements.funnelKey));
      }
      if (activeOnly) whereParts.push(eq(visualElements.activeInMeta, true));

      return tx
        .select()
        .from(visualElements)
        .where(whereParts.length > 0 ? and(...whereParts) : undefined)
        .orderBy(asc(visualElements.dimension), asc(visualElements.priority));
    });

    const grouped: Record<string, unknown[]> = {};
    for (const row of rows) {
      const dim = row.dimension;
      if (!grouped[dim]) grouped[dim] = [];
      grouped[dim].push(row);
    }

    return NextResponse.json({
      total: rows.length,
      dimensions: Object.keys(grouped).sort(),
      elements: grouped,
    });
  } catch (err) {
    console.error("GET /api/visual-elements error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const {
      code,
      dimension,
      name,
      description,
      active_in_meta = false,
      priority = 5,
      funnel_key = null,
      notes = null,
    } = body;

    if (!code || !dimension || !name) {
      return NextResponse.json(
        { error: "code, dimension, name são obrigatórios" },
        { status: 400 },
      );
    }

    const element = await withWorkspace(auth.workspace_id, async (tx) => {
      await tx
        .insert(visualElements)
        .values({
          workspaceId: auth.workspace_id,
          code,
          dimension,
          name,
          description: description ?? null,
          activeInMeta: active_in_meta,
          priority,
          funnelKey: funnel_key,
          notes,
        })
        .onConflictDoUpdate({
          target: [visualElements.code, visualElements.funnelKey],
          set: {
            name: sql`EXCLUDED.name`,
            description: sql`EXCLUDED.description`,
            activeInMeta: sql`EXCLUDED.active_in_meta`,
            priority: sql`EXCLUDED.priority`,
            notes: sql`EXCLUDED.notes`,
          },
        });

      const result = await tx
        .select()
        .from(visualElements)
        .where(
          and(
            eq(visualElements.code, code),
            funnel_key
              ? eq(visualElements.funnelKey, funnel_key)
              : isNull(visualElements.funnelKey),
          ),
        )
        .limit(1);
      return result[0];
    });

    return NextResponse.json({ ok: true, element }, { status: 201 });
  } catch (err) {
    console.error("POST /api/visual-elements error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
