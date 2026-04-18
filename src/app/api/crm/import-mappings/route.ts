/**
 * MIGRADO NA FASE 1C (Wave 5 — CRM):
 *  - getDb() → dbAdmin (workspace_id no WHERE manual)
 *  - Drizzle typed builder pra SELECT/INSERT/UPDATE/DELETE
 *  - Upsert agora usa .onConflictDoUpdate em vez de SELECT-then-branch
 *  - Shape do response preservado (snake_case via alias no .select())
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { dbAdmin } from "@/lib/db";
import { crmImportMappings } from "@/lib/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

// Campos padronizados do response (snake_case mantido para compat).
const mappingSelect = {
  id: crmImportMappings.id,
  name: crmImportMappings.name,
  description: crmImportMappings.description,
  column_mappings: crmImportMappings.columnMappings,
  target_fields: crmImportMappings.targetFields,
  last_used_at: crmImportMappings.lastUsedAt,
  import_count: crmImportMappings.importCount,
  created_at: crmImportMappings.createdAt,
  updated_at: crmImportMappings.updatedAt,
};

// GET /api/crm/import-mappings — list saved mappings
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const mappings = await dbAdmin
      .select(mappingSelect)
      .from(crmImportMappings)
      .where(eq(crmImportMappings.workspaceId, auth.workspace_id))
      .orderBy(
        sql`${crmImportMappings.lastUsedAt} DESC NULLS LAST`,
        desc(crmImportMappings.createdAt),
      );

    return NextResponse.json({ mappings });
  } catch (error) {
    console.error("[import-mappings] GET error:", error);
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/crm/import-mappings — upsert mapping by (workspace_id, name)
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { name, description, column_mappings, target_fields } = body;

    if (!name || !column_mappings) {
      return NextResponse.json({ error: "name e column_mappings sao obrigatorios" }, { status: 400 });
    }

    if (typeof column_mappings !== "object" || Array.isArray(column_mappings)) {
      return NextResponse.json({ error: "column_mappings deve ser um objeto" }, { status: 400 });
    }

    const targetFields = Array.isArray(target_fields) ? target_fields : [];

    const existing = await dbAdmin
      .select({ id: crmImportMappings.id })
      .from(crmImportMappings)
      .where(
        and(
          eq(crmImportMappings.workspaceId, auth.workspace_id),
          eq(crmImportMappings.name, name),
        ),
      )
      .limit(1);

    const isUpdate = existing.length > 0;

    const [row] = await dbAdmin
      .insert(crmImportMappings)
      .values({
        workspaceId: auth.workspace_id,
        name,
        description: description ?? null,
        columnMappings: column_mappings,
        targetFields,
      })
      .onConflictDoUpdate({
        target: [crmImportMappings.workspaceId, crmImportMappings.name],
        set: {
          description: description ?? null,
          columnMappings: column_mappings,
          targetFields,
          updatedAt: sql`NOW()`,
        },
      })
      .returning(mappingSelect);

    return NextResponse.json({
      mapping: row,
      message: isUpdate ? "Mapeamento atualizado" : "Mapeamento criado",
    });
  } catch (error) {
    console.error("[import-mappings] POST error:", error);
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/crm/import-mappings?id=xxx
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    let id = searchParams.get("id");

    if (!id) {
      const body = await req.json().catch(() => ({}));
      id = (body as { id?: string }).id ?? null;
    }

    if (!id) {
      return NextResponse.json({ error: "id e obrigatorio" }, { status: 400 });
    }

    const deleted = await dbAdmin
      .delete(crmImportMappings)
      .where(
        and(
          eq(crmImportMappings.id, id),
          eq(crmImportMappings.workspaceId, auth.workspace_id),
        ),
      )
      .returning({ id: crmImportMappings.id, name: crmImportMappings.name });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Mapeamento nao encontrado" }, { status: 404 });
    }

    return NextResponse.json({ deleted: deleted[0], message: "Mapeamento removido" });
  } catch (error) {
    console.error("[import-mappings] DELETE error:", error);
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// PATCH /api/crm/import-mappings — increment usage counter
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: "id e obrigatorio" }, { status: 400 });
    }

    const updated = await dbAdmin
      .update(crmImportMappings)
      .set({
        lastUsedAt: sql`NOW()`,
        importCount: sql`${crmImportMappings.importCount} + 1`,
        updatedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(crmImportMappings.id, id),
          eq(crmImportMappings.workspaceId, auth.workspace_id),
        ),
      )
      .returning({
        id: crmImportMappings.id,
        name: crmImportMappings.name,
        import_count: crmImportMappings.importCount,
        last_used_at: crmImportMappings.lastUsedAt,
      });

    if (updated.length === 0) {
      return NextResponse.json({ error: "Mapeamento nao encontrado" }, { status: 404 });
    }

    return NextResponse.json({ mapping: updated[0] });
  } catch (error) {
    console.error("[import-mappings] PATCH error:", error);
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
