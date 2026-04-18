/**
 * GET/POST /api/templates
 *
 * Template library de padrões visuais validados (tarefa 4.4).
 *
 * MIGRADO NA FASE 1C (Wave 4):
 *  - getDb() → withWorkspace (RLS escopa templates)
 *  - Schema Drizzle adicionado em intelligence.ts + migration 0005
 *  - ensureTemplatesTable() removido (agora via migration canonical)
 *  - uuid() manual removido (defaultRandom no schema)
 *  - JOIN com creatives preservado via sql`` tagged template
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { templates } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";

// ── Seed: templates derivados dos winners validados ─────────────────────────

const SEEDS = [
  {
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

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const funnelKey = searchParams.get("funnel_key");
  const dimension = searchParams.get("dimension");
  const status = searchParams.get("status") ?? "active";

  const rows = await withWorkspace(auth.workspace_id, async (tx) => {
    // Seed se workspace tem 0 templates
    const existing = await tx.select({ id: templates.id }).from(templates).limit(1);
    if (existing.length === 0) {
      await tx.insert(templates).values(
        SEEDS.map((t) => ({
          workspaceId: auth.workspace_id,
          name: t.name,
          description: t.description,
          funnelKey: t.funnel_key,
          dimensions: t.dimensions,
          promptFragment: t.prompt_fragment,
          cplValidated: t.cpl_validated,
          notes: t.notes,
        })),
      );
    }

    // Filtros compostos via sql`` fragments
    const statusFilter = status !== "all" ? sql`AND t.status = ${status}` : sql``;
    const funnelFilter = funnelKey ? sql`AND t.funnel_key = ${funnelKey}` : sql``;
    const dimensionFilter = dimension
      ? sql`AND t.dimensions ? ${dimension}`
      : sql``;

    const result = await tx.execute(sql`
      SELECT t.*,
             c.name AS source_creative_name,
             c.status AS source_creative_status
      FROM templates t
      LEFT JOIN creatives c ON c.id = t.source_creative_id
      WHERE 1=1
        ${statusFilter}
        ${funnelFilter}
        ${dimensionFilter}
      ORDER BY t.cpl_validated ASC NULLS LAST, t.created_at DESC
    `);
    return result as unknown as Array<Record<string, unknown>>;
  });

  return NextResponse.json({
    total: rows.length,
    filters: { funnel_key: funnelKey, dimension, status },
    templates: rows,
  });
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.funnel_key || !body?.dimensions) {
    return NextResponse.json(
      { error: "Campos obrigatórios: name, funnel_key, dimensions" },
      { status: 400 },
    );
  }

  const row = await withWorkspace(auth.workspace_id, async (tx) => {
    const values = {
      workspaceId: auth.workspace_id,
      name: body.name,
      description: body.description ?? null,
      funnelKey: body.funnel_key,
      sourceCreativeId: body.source_creative_id ?? null,
      dimensions: body.dimensions,
      promptFragment: body.prompt_fragment ?? null,
      cplValidated: body.cpl_validated ?? null,
      status: body.status ?? "active",
      notes: body.notes ?? null,
    };

    if (body.id) {
      // Upsert explícito com id fornecido
      const [result] = await tx
        .insert(templates)
        .values({ id: body.id, ...values })
        .onConflictDoUpdate({
          target: templates.id,
          set: {
            name: sql`EXCLUDED.name`,
            description: sql`EXCLUDED.description`,
            funnelKey: sql`EXCLUDED.funnel_key`,
            sourceCreativeId: sql`EXCLUDED.source_creative_id`,
            dimensions: sql`EXCLUDED.dimensions`,
            promptFragment: sql`EXCLUDED.prompt_fragment`,
            cplValidated: sql`EXCLUDED.cpl_validated`,
            status: sql`EXCLUDED.status`,
            notes: sql`EXCLUDED.notes`,
            updatedAt: sql`NOW()`,
          },
        })
        .returning();
      return result;
    }

    const [result] = await tx.insert(templates).values(values).returning();
    return result;
  });

  return NextResponse.json({ template: row }, { status: 201 });
}
