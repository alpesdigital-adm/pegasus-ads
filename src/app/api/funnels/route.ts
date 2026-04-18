/**
 * GET  /api/funnels           — Lista funis cadastrados com métricas agregadas
 * POST /api/funnels           — Cadastra novo funil (UPSERT por key)
 *
 * Multi-funil (tarefa 4.3).
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (RLS scoped)
 *  - Aggregate query (JOIN + GROUP BY + CASE) em sql`` — mais legível
 *  - INSERT + ON CONFLICT via Drizzle onConflictDoUpdate
 *  - UPDATE de creatives.funnel_key em Drizzle
 *  - randomUUID() removido (.defaultRandom() cobre)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { funnels, creatives } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { and, eq, ilike } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const activeOnly = searchParams.get("active_only") === "true";

    // Aggregate com LEFT JOIN duplo + CASE WHEN — mantém sql`` por legibilidade.
    // RLS enforça workspace_id no f (funnels) e c (creatives) via SET LOCAL.
    const result = await withWorkspace(auth.workspace_id, async (tx) => {
      return tx.execute(sql`
        SELECT
          f.*,
          COUNT(DISTINCT c.id)            AS total_creatives,
          COUNT(DISTINCT CASE WHEN c.status = 'testing' THEN c.id END)  AS active_creatives,
          COUNT(DISTINCT CASE WHEN c.status = 'winner'  THEN c.id END)  AS winner_creatives,
          COUNT(DISTINCT CASE WHEN c.status = 'killed'  THEN c.id END)  AS killed_creatives,
          COALESCE(SUM(m.spend), 0)       AS total_spend,
          COALESCE(SUM(m.leads), 0)       AS total_leads,
          CASE WHEN SUM(m.leads) > 0
               THEN ROUND((SUM(m.spend) / SUM(m.leads))::numeric, 2)
               ELSE NULL END              AS avg_cpl
        FROM funnels f
        LEFT JOIN creatives c ON c.funnel_key = f.key
        LEFT JOIN metrics m ON m.creative_id = c.id
        ${activeOnly ? sql`WHERE f.active = TRUE` : sql``}
        GROUP BY f.id, f.key, f.name, f.prefix, f.ebook_title, f.cpl_target,
                 f.meta_campaign_id, f.meta_account_id, f.active, f.created_at, f.workspace_id
        ORDER BY f.key
      `);
    });

    const rows = result as unknown as Array<Record<string, unknown>>;
    return NextResponse.json({
      total: rows.length,
      funnels: rows.map((r) => ({
        ...r,
        total_creatives: parseInt(r.total_creatives as string),
        active_creatives: parseInt(r.active_creatives as string),
        winner_creatives: parseInt(r.winner_creatives as string),
        killed_creatives: parseInt(r.killed_creatives as string),
        total_spend: parseFloat(r.total_spend as string),
        total_leads: parseInt(r.total_leads as string),
        avg_cpl: r.avg_cpl ? parseFloat(r.avg_cpl as string) : null,
        cpl_target: r.cpl_target ? parseFloat(r.cpl_target as string) : null,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const {
      key, name, prefix, ebook_title = null,
      cpl_target = null, meta_campaign_id = null,
      meta_account_id = null, active = true,
    } = body;

    if (!key || !name || !prefix) {
      return NextResponse.json(
        { error: "key, name, prefix são obrigatórios" },
        { status: 400 },
      );
    }

    const { funnel, creativesUpdated } = await withWorkspace(
      auth.workspace_id,
      async (tx) => {
        // UPSERT do funnel (ON CONFLICT key)
        await tx
          .insert(funnels)
          .values({
            workspaceId: auth.workspace_id,
            key,
            name,
            prefix,
            ebookTitle: ebook_title,
            cplTarget: cpl_target,
            metaCampaignId: meta_campaign_id,
            metaAccountId: meta_account_id,
            active,
          })
          .onConflictDoUpdate({
            target: funnels.key,
            set: {
              name: sql`EXCLUDED.name`,
              prefix: sql`EXCLUDED.prefix`,
              ebookTitle: sql`EXCLUDED.ebook_title`,
              cplTarget: sql`EXCLUDED.cpl_target`,
              metaCampaignId: sql`EXCLUDED.meta_campaign_id`,
              metaAccountId: sql`EXCLUDED.meta_account_id`,
              active: sql`EXCLUDED.active`,
            },
          });

        // Atualizar funnel_key nos criativos que matcham o prefixo.
        // IS DISTINCT FROM trata NULL como valor (inclui funnelKey IS NULL)
        // — Drizzle não tem helper, uso sql`` para preservar a semântica original.
        const updatedRows = await tx
          .update(creatives)
          .set({ funnelKey: key })
          .where(
            and(
              ilike(creatives.name, `${prefix}%`),
              sql`${creatives.funnelKey} IS DISTINCT FROM ${key}`,
            ),
          )
          .returning({ id: creatives.id });

        // SELECT o funnel atualizado
        const funnelRows = await tx
          .select()
          .from(funnels)
          .where(eq(funnels.key, key))
          .limit(1);

        return {
          funnel: funnelRows[0],
          creativesUpdated: updatedRows.length,
        };
      },
    );

    return NextResponse.json(
      {
        ok: true,
        funnel,
        creatives_updated: creativesUpdated,
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
