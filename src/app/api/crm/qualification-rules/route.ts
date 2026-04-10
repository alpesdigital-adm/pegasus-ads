/**
 * GET  /api/crm/qualification-rules?project_key=rat
 * POST /api/crm/qualification-rules
 *
 * Gerencia regras de qualificação de leads por projeto.
 *
 * Regra: array de { column, values[], negate? }
 * Semântica: AND entre regras, OR entre values[] de cada regra.
 *
 * Exemplo RAT:
 * [{"column": "Médico", "values": ["Sim"]}]
 *
 * Exemplo multi-coluna (futuro):
 * [
 *   {"column": "Médico", "values": ["Sim"]},
 *   {"column": "Profissão Confirmada", "values": ["Médico", "Residente"]}
 * ]
 *
 * Protegido por x-api-key.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const projectKey = req.nextUrl.searchParams.get("project_key");
  const db = getDb();

  if (projectKey) {
    const res = await db.execute({
      sql: "SELECT * FROM lead_qualification_rules WHERE workspace_id = ? AND project_key = ?",
      args: [auth.workspace_id, projectKey],
    });
    return NextResponse.json(res.rows[0] || null);
  }

  const res = await db.execute({
    sql: "SELECT * FROM lead_qualification_rules WHERE workspace_id = ? ORDER BY project_key",
    args: [auth.workspace_id],
  });
  return NextResponse.json(res.rows);
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json();
  const { project_key, rules } = body;

  if (!project_key) return NextResponse.json({ error: "project_key required" }, { status: 400 });
  if (!Array.isArray(rules)) return NextResponse.json({ error: "rules must be an array" }, { status: 400 });

  // Validate rules
  for (const rule of rules) {
    if (!rule.column || !Array.isArray(rule.values)) {
      return NextResponse.json(
        { error: "Each rule must have column (string) and values (array)" },
        { status: 400 }
      );
    }
  }

  const db = getDb();
  const id = `rule_${auth.workspace_id}_${project_key}`;

  await db.execute({
    sql: `INSERT INTO lead_qualification_rules (id, workspace_id, project_key, rules)
          VALUES (?, ?, ?, ?::jsonb)
          ON CONFLICT (workspace_id, project_key) DO UPDATE SET
            rules = EXCLUDED.rules,
            updated_at = NOW()`,
    args: [id, auth.workspace_id, project_key, JSON.stringify(rules)],
  });

  return NextResponse.json({ success: true, project_key, rules });
}
