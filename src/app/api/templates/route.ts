/**
 * GET/POST /api/templates
 *
 * Template library de padrões visuais validados (tarefa 4.4).
 * Banco de abordagens que funcionaram → reutilizar em novos funis.
 *
 * GET params:
 *   funnel_key?    — filtrar por funil de origem (ex: T7)
 *   dimension?     — filtrar por dimensão visual
 *   status?        — 'active' | 'archived' | 'all' (default: 'active')
 *
 * POST body:
 * {
 *   name: string
 *   description: string
 *   funnel_key: string              — funil onde foi validado
 *   source_creative_id?: string     — criativo de referência
 *   dimensions: {                   — elementos visuais do template
 *     hero?: string                 — código H1-H6
 *     ebook?: string                — E1-E4
 *     copy?: string                 — C1-C4
 *     palette?: string              — P1-P3
 *     style?: string                — V1-V3
 *     layout?: string               — L1-L4
 *   }
 *   prompt_fragment?: string        — trecho de prompt reutilizável
 *   cpl_validated?: number          — CPL que levou ao status winner
 *   notes?: string
 * }
 *
 * Proteção: x-api-key = TEST_LOG_API_KEY
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb, initDb } from "@/lib/db";
import { v4 as uuid } from "uuid";

export const runtime = "nodejs";

function checkAuth(req: NextRequest): boolean {
  const key = req.headers.get("x-api-key");
  return !!process.env.TEST_LOG_API_KEY && key === process.env.TEST_LOG_API_KEY;
}

// ── Migração da tabela templates ────────────────────────────────────────────

async function ensureTemplatesTable(): Promise<void> {
  const db = getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      funnel_key TEXT NOT NULL,
      source_creative_id TEXT REFERENCES creatives(id) ON DELETE SET NULL,
      dimensions JSONB NOT NULL DEFAULT '{}',
      prompt_fragment TEXT,
      cpl_validated DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_templates_funnel ON templates(funnel_key)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status)`);
}

// ── Seed: templates derivados dos winners validados ─────────────────────────

async function seedTemplatesIfEmpty(): Promise<void> {
  const db = getDb();
  const { rows } = await db.execute(`SELECT COUNT(*) AS cnt FROM templates`);
  if (Number(rows[0].cnt) > 0) return;

  const seeds = [
    {
      id: uuid(),
      name: "Hero Foto Realista + CTA Grátis (T4 Winner)",
      description:
        "Template validado no T4: médico real com jaleco branco, fundo limpo, CTA 'GRÁTIS' em destaque. CPL R$26,40.",
      funnel_key: "T4",
      dimensions: { hero: "H1", copy: "C1", palette: "P1", layout: "L1" },
      prompt_fragment:
        "médico com jaleco branco segurando ebook, fundo branco limpo, texto GRÁTIS em vermelho bold, rodapé com nome do ebook",
      cpl_validated: 26.4,
      notes: "Controle original T4EBMX — base para todos os testes",
    },
    {
      id: uuid(),
      name: "Hero Cartoon Animado + Paleta Escura (T7 Variante)",
      description:
        "Ilustração cartoon de médico, background escuro azul, ebook em destaque lateral. Hipótese H3+P2.",
      funnel_key: "T7",
      dimensions: { hero: "H3", palette: "P2", ebook: "E2", layout: "L2" },
      prompt_fragment:
        "cartoon animado de médico capilarpista, fundo azul escuro #1a1a2e, ebook flutuando à direita, cores vibrantes",
      cpl_validated: null,
      notes: "Template hipotético baseado em análise de variáveis — aguarda validação",
    },
    {
      id: uuid(),
      name: "Power Copy + Benefício Numérico (Multi-funil)",
      description:
        "Copy agressivo com número de benefício em destaque (ex: '87% dos médicos recomendam'). Dimensão C2.",
      funnel_key: "T7",
      dimensions: { copy: "C2", layout: "L1" },
      prompt_fragment:
        "headline com estatística em destaque bold, subheadline com benefício direto, CTA vermelho centralizado",
      cpl_validated: null,
      notes: "Padrão copy-first — testar isolado da dimensão hero",
    },
  ];

  for (const t of seeds) {
    await db.execute({
      sql: `INSERT INTO templates (id, name, description, funnel_key, dimensions, prompt_fragment, cpl_validated, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      args: [t.id, t.name, t.description, t.funnel_key, JSON.stringify(t.dimensions), t.prompt_fragment, t.cpl_validated, t.notes],
    });
  }
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await initDb();
  await ensureTemplatesTable();
  await seedTemplatesIfEmpty();

  const { searchParams } = new URL(req.url);
  const funnelKey = searchParams.get("funnel_key");
  const dimension = searchParams.get("dimension");
  const status = searchParams.get("status") ?? "active";

  const db = getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (status !== "all") {
    conditions.push(`t.status = $${idx++}`);
    params.push(status);
  }
  if (funnelKey) {
    conditions.push(`t.funnel_key = $${idx++}`);
    params.push(funnelKey);
  }
  if (dimension) {
    conditions.push(`t.dimensions ? $${idx++}`);
    params.push(dimension);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await db.execute({
    sql: `SELECT t.*,
            c.name AS source_creative_name,
            c.status AS source_creative_status
     FROM templates t
     LEFT JOIN creatives c ON c.id = t.source_creative_id
     ${where}
     ORDER BY t.cpl_validated ASC NULLS LAST, t.created_at DESC`,
    args: params,
  });

  return NextResponse.json({
    total: rows.length,
    filters: { funnel_key: funnelKey, dimension, status },
    templates: rows,
  });
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await initDb();
  await ensureTemplatesTable();

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.funnel_key || !body?.dimensions) {
    return NextResponse.json(
      { error: "Campos obrigatórios: name, funnel_key, dimensions" },
      { status: 400 }
    );
  }

  const db = getDb();
  const id = body.id ?? uuid();

  const { rows } = await db.execute({
    sql: `INSERT INTO templates
       (id, name, description, funnel_key, source_creative_id, dimensions,
        prompt_fragment, cpl_validated, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       funnel_key = EXCLUDED.funnel_key,
       source_creative_id = EXCLUDED.source_creative_id,
       dimensions = EXCLUDED.dimensions,
       prompt_fragment = EXCLUDED.prompt_fragment,
       cpl_validated = EXCLUDED.cpl_validated,
       status = EXCLUDED.status,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING *`,
    args: [
      id,
      body.name,
      body.description ?? null,
      body.funnel_key,
      body.source_creative_id ?? null,
      JSON.stringify(body.dimensions),
      body.prompt_fragment ?? null,
      body.cpl_validated ?? null,
      body.status ?? "active",
      body.notes ?? null,
    ],
  });

  return NextResponse.json({ template: rows[0] }, { status: 201 });
}
