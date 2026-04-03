/**
 * GET  /api/visual-elements   — Lista todos os elementos, opcionalmente por dimensão ou funil
 * POST /api/visual-elements   — Cadastra novo elemento
 *
 * Galeria de variáveis visuais testáveis (tarefa 1.7).
 * Dimensões: hero | ebook | copy | palette | style | layout
 *
 * Query params (GET):
 *   - dimension  (optional) filter by dimension
 *   - funnel_key (optional) filter by funnel; null/empty = todos
 *   - active_only (optional) "true" = apenas variações ativas no Meta
 *
 * Protegido por x-api-key.
 */
import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

// Seed inicial com dados do AD002-IA (Minoxidil)
const SEED_ELEMENTS = [
  // Hero
  { code: "H1", dimension: "hero", name: "Grupo de médicos", description: "Equipe médica em grupo, jaleco branco — transmite comunidade/pertencimento", active_in_meta: true, priority: 1 },
  { code: "H2", dimension: "hero", name: "Médico solo", description: "Um único profissional, olhar direto — transmite conexão pessoal", active_in_meta: true, priority: 2 },
  { code: "H3", dimension: "hero", name: "Médico ilustrado (cartoon)", description: "Personagem cartoon de médico com jaleco — contraste estilístico no feed", active_in_meta: true, priority: 3 },
  { code: "H4", dimension: "hero", name: "Ebook sozinho", description: "Livro 3D sem pessoas — foco total no objeto de desejo", active_in_meta: true, priority: 4 },
  { code: "H5", dimension: "hero", name: "Dra. Priscila (autoridade nomeada)", description: "Variação com nome e referência direta à autora — prova social de especialista", active_in_meta: false, priority: 5 },
  { code: "H6", dimension: "hero", name: "Instrumentos médicos", description: "Estetoscópio, seringa — contexto profissional via símbolos, sem pessoas", active_in_meta: false, priority: 6 },
  // Ebook
  { code: "E1", dimension: "ebook", name: "Capa flat (2D) overlay", description: "Capa do ebook sobreposta à imagem, estilo original", active_in_meta: true, priority: 1 },
  { code: "E2", dimension: "ebook", name: "Mockup livro físico 3D", description: "Ebook renderizado como livro real com profundidade e sombra", active_in_meta: true, priority: 2 },
  { code: "E3", dimension: "ebook", name: "Ebook + selo 'E-book Informativo'", description: "Badge/selo ao lado do ebook — reforça tipo de conteúdo", active_in_meta: true, priority: 3 },
  { code: "E4", dimension: "ebook", name: "Ebook pequeno (secundário)", description: "Ebook menor, composição dominada por outros elementos", active_in_meta: false, priority: 4 },
  // Copy
  { code: "C1", dimension: "copy", name: "Exclusividade + Gratuidade", description: "GRÁTIS E EXCLUSIVO PARA MÉDICOS!", active_in_meta: true, priority: 1 },
  { code: "C2", dimension: "copy", name: "Desbloqueio de poder", description: "DESBLOQUEIE O PODER DO MINOXIDIL — Guia EXCLUSIVO para Médicos, Baixe GRÁTIS!", active_in_meta: true, priority: 2 },
  { code: "C3", dimension: "copy", name: "Autoridade nomeada", description: "Dra. Priscila Barreto apresenta soluções inovadoras em seu e-book", active_in_meta: false, priority: 3 },
  { code: "C4", dimension: "copy", name: "Título do ebook puro", description: "Minoxidil: do tópico ao sublingual (sem CTA visual)", active_in_meta: false, priority: 4 },
  // Palette
  { code: "P1", dimension: "palette", name: "Claro / branco-azulado", description: "Fundo claro, tom médico clean", active_in_meta: true, priority: 1 },
  { code: "P2", dimension: "palette", name: "Escuro / navy premium", description: "Fundo escuro com elementos dourados ou claros — sensação premium/sofisticada", active_in_meta: false, priority: 2 },
  { code: "P3", dimension: "palette", name: "Gradiente azul", description: "Transição de tons azuis — médico mas mais dinâmico", active_in_meta: false, priority: 3 },
  // Style
  { code: "V1", dimension: "style", name: "Fotografia (stock médico)", description: "Fotos reais de profissionais de saúde", active_in_meta: true, priority: 1 },
  { code: "V2", dimension: "style", name: "Ilustração / Cartoon", description: "Personagem desenhado — quebra padrão do feed médico", active_in_meta: true, priority: 2 },
  { code: "V3", dimension: "style", name: "Composição mista (foto + grafismo)", description: "Foto com overlay pesado de elementos gráficos", active_in_meta: false, priority: 3 },
  // Layout
  { code: "L1", dimension: "layout", name: "Banner topo + hero + ebook", description: "Estrutura padrão: faixa vermelha no topo, imagem central, ebook overlay", active_in_meta: true, priority: 1 },
  { code: "L2", dimension: "layout", name: "Copy-driven (texto domina)", description: "Mais texto, menos imagem — foco na mensagem escrita", active_in_meta: true, priority: 2 },
  { code: "L3", dimension: "layout", name: "Objeto-driven (ebook centralizado)", description: "Ebook como elemento central, tudo ao redor apoia", active_in_meta: true, priority: 3 },
  { code: "L4", dimension: "layout", name: "Split (metade imagem / metade texto)", description: "Divisão clara entre área visual e área de copy", active_in_meta: false, priority: 4 },
];

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  return !!process.env.TEST_LOG_API_KEY && key === process.env.TEST_LOG_API_KEY;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = await initDb();
    const { searchParams } = new URL(req.url);
    const dimension = searchParams.get("dimension");
    const funnelKey = searchParams.get("funnel_key");
    const activeOnly = searchParams.get("active_only") === "true";

    // ── Seed automático se tabela vazia ──
    const countRes = await db.execute("SELECT COUNT(*) as n FROM visual_elements");
    const count = Number((countRes.rows[0] as { n: string }).n);

    if (count === 0) {
      for (const el of SEED_ELEMENTS) {
        await db.execute({
          sql: `INSERT INTO visual_elements (id, code, dimension, name, description, active_in_meta, priority, funnel_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT (code, funnel_key) DO NOTHING`,
          args: [randomUUID(), el.code, el.dimension, el.name, el.description, el.active_in_meta, el.priority],
        });
      }
    }

    // ── Query ──
    const conditions: string[] = [];
    const args: unknown[] = [];

    if (dimension) { conditions.push("dimension = ?"); args.push(dimension); }
    if (funnelKey) { conditions.push("(funnel_key = ? OR funnel_key IS NULL)"); args.push(funnelKey); }
    else { conditions.push("funnel_key IS NULL"); }
    if (activeOnly) { conditions.push("active_in_meta = TRUE"); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await db.execute({ sql: `SELECT * FROM visual_elements ${where} ORDER BY dimension, priority`, args });

    // ── Agrupar por dimensão ──
    const grouped: Record<string, unknown[]> = {};
    for (const row of rows.rows) {
      const dim = row.dimension as string;
      if (!grouped[dim]) grouped[dim] = [];
      grouped[dim].push(row);
    }

    return NextResponse.json({
      total: rows.rows.length,
      dimensions: Object.keys(grouped).sort(),
      elements: grouped,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = await initDb();
    const body = await req.json();
    const { code, dimension, name, description, active_in_meta = false, priority = 5, funnel_key = null, notes = null } = body;

    if (!code || !dimension || !name) {
      return NextResponse.json({ error: "code, dimension, name são obrigatórios" }, { status: 400 });
    }

    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO visual_elements (id, code, dimension, name, description, active_in_meta, priority, funnel_key, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (code, funnel_key) DO UPDATE SET
              name = EXCLUDED.name,
              description = EXCLUDED.description,
              active_in_meta = EXCLUDED.active_in_meta,
              priority = EXCLUDED.priority,
              notes = EXCLUDED.notes`,
      args: [id, code, dimension, name, description ?? null, active_in_meta, priority, funnel_key, notes],
    });

    const result = await db.execute({ sql: "SELECT * FROM visual_elements WHERE code = ? AND (funnel_key = ? OR (funnel_key IS NULL AND ? IS NULL))", args: [code, funnel_key, funnel_key] });
    return NextResponse.json({ ok: true, element: result.rows[0] }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
