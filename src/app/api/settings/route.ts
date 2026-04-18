/**
 * GET /api/settings?key=xxx — Busca uma configuração do workspace atual.
 * GET /api/settings — Lista todas configurações do workspace atual.
 * POST /api/settings — Upsert. Body: { key: string, value: string }
 *
 * TD-005 resolvido (2026-04-18):
 *  - Antes operava na tabela global `settings` (key TEXT primária,
 *    sem workspace_id). Agora escopa per-workspace via workspace_settings.
 *  - Tabela `settings` dropada em migration 0009.
 *  - API contract: GET/POST agora respondem com settings do workspace
 *    autenticado (via cookie sb-access-token). Sem frontend caller hoje
 *    (a page /settings só gerencia Meta accounts).
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { workspaceSettings } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { and, asc, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const key = request.nextUrl.searchParams.get("key");

    if (key) {
      const rows = await withWorkspace(auth.workspace_id, (tx) =>
        tx
          .select({
            key: workspaceSettings.key,
            value: workspaceSettings.value,
            updated_at: workspaceSettings.updatedAt,
          })
          .from(workspaceSettings)
          .where(
            and(
              eq(workspaceSettings.workspaceId, auth.workspace_id),
              eq(workspaceSettings.key, key),
            ),
          )
          .limit(1),
      );
      if (rows.length === 0) {
        return NextResponse.json({ error: "Setting not found" }, { status: 404 });
      }
      return NextResponse.json(rows[0]);
    }

    const rows = await withWorkspace(auth.workspace_id, (tx) =>
      tx
        .select({
          key: workspaceSettings.key,
          value: workspaceSettings.value,
          updated_at: workspaceSettings.updatedAt,
        })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, auth.workspace_id))
        .orderBy(asc(workspaceSettings.key)),
    );
    return NextResponse.json({ settings: rows });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read settings" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    if (!body.key || body.value === undefined) {
      return NextResponse.json({ error: "key and value are required" }, { status: 400 });
    }

    await withWorkspace(auth.workspace_id, (tx) =>
      tx
        .insert(workspaceSettings)
        .values({
          workspaceId: auth.workspace_id,
          key: body.key,
          value: String(body.value),
        })
        .onConflictDoUpdate({
          target: [workspaceSettings.workspaceId, workspaceSettings.key],
          set: {
            value: sql`EXCLUDED.value`,
            updatedAt: sql`NOW()`,
          },
        }),
    );

    return NextResponse.json({ key: body.key, value: body.value });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save setting" },
      { status: 500 },
    );
  }
}
