import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/crm/import-mappings — list saved mappings
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const result = await db.execute({
      sql: `SELECT id, name, description, column_mappings, target_fields,
                   last_used_at, import_count, created_at, updated_at
            FROM crm_import_mappings
            WHERE workspace_id = ?
            ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
      args: [auth.workspace_id],
    });

    return NextResponse.json({ mappings: result.rows });
  } catch (error: any) {
    console.error("[import-mappings] GET error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}

// POST /api/crm/import-mappings — upsert mapping by name
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

    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Try update first
    const existing = await db.execute({
      sql: "SELECT id FROM crm_import_mappings WHERE workspace_id = ? AND name = ?",
      args: [auth.workspace_id, name],
    });

    if (existing.rows.length > 0) {
      const existingId = existing.rows[0].id as string;
      await db.execute({
        sql: `UPDATE crm_import_mappings
              SET description = ?, column_mappings = ?, target_fields = ?, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
        args: [
          description || null,
          JSON.stringify(column_mappings),
          JSON.stringify(target_fields || []),
          now,
          existingId,
          auth.workspace_id,
        ],
      });

      const updated = await db.execute({
        sql: "SELECT id, name, description, column_mappings, target_fields, created_at, updated_at FROM crm_import_mappings WHERE id = ?",
        args: [existingId],
      });

      return NextResponse.json({ mapping: updated.rows[0], message: "Mapeamento atualizado" });
    }

    // Insert new
    await db.execute({
      sql: `INSERT INTO crm_import_mappings (id, workspace_id, name, description, column_mappings, target_fields, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        auth.workspace_id,
        name,
        description || null,
        JSON.stringify(column_mappings),
        JSON.stringify(target_fields || []),
        now,
        now,
      ],
    });

    const inserted = await db.execute({
      sql: "SELECT id, name, description, column_mappings, target_fields, created_at, updated_at FROM crm_import_mappings WHERE id = ?",
      args: [id],
    });

    return NextResponse.json({ mapping: inserted.rows[0], message: "Mapeamento criado" });
  } catch (error: any) {
    console.error("[import-mappings] POST error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
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
      id = (body as any).id;
    }

    if (!id) {
      return NextResponse.json({ error: "id e obrigatorio" }, { status: 400 });
    }

    const db = getDb();
    const result = await db.execute({
      sql: "DELETE FROM crm_import_mappings WHERE id = ? AND workspace_id = ? RETURNING id, name",
      args: [id, auth.workspace_id],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Mapeamento nao encontrado" }, { status: 404 });
    }

    return NextResponse.json({ deleted: result.rows[0], message: "Mapeamento removido" });
  } catch (error: any) {
    console.error("[import-mappings] DELETE error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
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

    const db = getDb();
    const now = new Date().toISOString();

    const result = await db.execute({
      sql: `UPDATE crm_import_mappings
            SET last_used_at = ?, import_count = import_count + 1, updated_at = ?
            WHERE id = ? AND workspace_id = ?
            RETURNING id, name, import_count, last_used_at`,
      args: [now, now, id, auth.workspace_id],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Mapeamento nao encontrado" }, { status: 404 });
    }

    return NextResponse.json({ mapping: result.rows[0] });
  } catch (error: any) {
    console.error("[import-mappings] PATCH error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
