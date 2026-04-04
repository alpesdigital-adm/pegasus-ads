/**
 * GET  /api/funnels           — Lista funis cadastrados com métricas agregadas
 * POST /api/funnels           — Cadastra novo funil
 *
 * Multi-funil (tarefa 4.3).
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const { searchParams } = new URL(req.url);
    const activeOnly = searchParams.get("active_only") === "true";

    const where = activeOnly
      ? "WHERE f.active = TRUE AND f.workspace_id = ?"
      : "WHERE f.workspace_id = ?";

    const res = await db.execute({
      sql: `
        SELECT
          f.*,
          COUNT(DISTINCT c.id)            AS total_creatives,
          COUNT(DISTINCT CASE WHEN c.status = 'testing' THEN c.id END)  AS active_creatives,
          COUNT(DISTINCT CASE WHEN c.status = 'winner'  THEN c.id END)  AS winner_creatives,
          COUNT(DISTINCT CASE WHEN c.status = 'killed'  THEN c.id END)  AS killed_creatives,
          COALESCE(SUM(m.spend), 0)       AS total_spend,
          COALESCE(SUM(m.leads), 0)       AS total_leads,
          CASE WHEN SUM(m.leads) > 0 THEN ROUND((SUM(m.spend) / SUM(m.leads))::numeric, 2) ELSE NULL END AS avg_cpl
        FROM funnels f
        LEFT JOIN creatives c ON c.funnel_key = f.key AND c.workspace_id = f.workspace_id
        LEFT JOIN metrics m ON m.creative_id = c.id
        ${where}
        GROUP BY f.id, f.key, f.name, f.prefix, f.ebook_title, f.cpl_target,
                 f.meta_campaign_id, f.meta_account_id, f.active, f.created_at, f.workspace_id
        ORDER BY f.key
      `,
      args: [auth.workspace_id],
    });

    return NextResponse.json({
      total: res.rows.length,
      funnels: res.rows.map(r => ({
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
    const db = getDb();
    const body = await req.json();
    const {
      key, name, prefix, ebook_title = null,
      cpl_target = null, meta_campaign_id = null,
      meta_account_id = null, active = true,
    } = body;

    if (!key || !name || !prefix) {
      return NextResponse.json({ error: "key, name, prefix são obrigatórios" }, { status: 400 });
    }

    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO funnels (id, key, name, prefix, ebook_title, cpl_target, meta_campaign_id, meta_account_id, active, workspace_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET
              name = EXCLUDED.name, prefix = EXCLUDED.prefix,
              ebook_title = EXCLUDED.ebook_title, cpl_target = EXCLUDED.cpl_target,
              meta_campaign_id = EXCLUDED.meta_campaign_id,
              meta_account_id = EXCLUDED.meta_account_id, active = EXCLUDED.active`,
      args: [id, key, name, prefix, ebook_title, cpl_target, meta_campaign_id, meta_account_id, active, auth.workspace_id],
    });

    // Atualizar funnel_key nos criativos que matcham o prefixo no workspace
    const updated = await db.execute({
      sql: `UPDATE creatives SET funnel_key = ? WHERE name ILIKE ? AND funnel_key IS DISTINCT FROM ? AND workspace_id = ?`,
      args: [key, `${prefix}%`, key, auth.workspace_id],
    });

    const result = await db.execute({ sql: "SELECT * FROM funnels WHERE key = ? AND workspace_id = ?", args: [key, auth.workspace_id] });

    return NextResponse.json({
      ok: true,
      funnel: result.rows[0],
      creatives_updated: updated.rowCount,
    }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
