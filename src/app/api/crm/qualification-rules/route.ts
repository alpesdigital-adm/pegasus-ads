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
 *
 * MIGRADO NA FASE 1C (Wave 5 — CRM):
 *  - getDb() → dbAdmin (workspace_id continua no WHERE manual)
 *  - Upsert via onConflictDoUpdate
 *  - BUG CORRIGIDO: id legado era `rule_${ws}_${project}` (TEXT) em schema
 *    UUID — ON CONFLICT mascarava o erro em updates. Agora deixa
 *    .defaultRandom() gerar o UUID corretamente.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { dbAdmin } from "@/lib/db";
import { leadQualificationRules } from "@/lib/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const projectKey = req.nextUrl.searchParams.get("project_key");

  if (projectKey) {
    const rows = await dbAdmin
      .select()
      .from(leadQualificationRules)
      .where(
        and(
          eq(leadQualificationRules.workspaceId, auth.workspace_id),
          eq(leadQualificationRules.projectKey, projectKey),
        ),
      )
      .limit(1);
    return NextResponse.json(rows[0] || null);
  }

  const rows = await dbAdmin
    .select()
    .from(leadQualificationRules)
    .where(eq(leadQualificationRules.workspaceId, auth.workspace_id))
    .orderBy(asc(leadQualificationRules.projectKey));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json();
  const { project_key, rules } = body;

  if (!project_key) return NextResponse.json({ error: "project_key required" }, { status: 400 });
  if (!Array.isArray(rules)) return NextResponse.json({ error: "rules must be an array" }, { status: 400 });

  for (const rule of rules) {
    if (!rule.column || !Array.isArray(rule.values)) {
      return NextResponse.json(
        { error: "Each rule must have column (string) and values (array)" },
        { status: 400 }
      );
    }
  }

  await dbAdmin
    .insert(leadQualificationRules)
    .values({
      workspaceId: auth.workspace_id,
      projectKey: project_key,
      rules,
    })
    .onConflictDoUpdate({
      target: [leadQualificationRules.workspaceId, leadQualificationRules.projectKey],
      set: {
        rules,
        updatedAt: sql`NOW()`,
      },
    });

  return NextResponse.json({ success: true, project_key, rules });
}
