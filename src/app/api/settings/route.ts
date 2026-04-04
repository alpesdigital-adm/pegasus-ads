import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/settings?key=xxx — Busca uma configuração.
 * GET /api/settings — Lista todas as configurações.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const key = request.nextUrl.searchParams.get("key");

    if (key) {
      const result = await db.execute({
        sql: "SELECT key, value, updated_at FROM settings WHERE key = ?",
        args: [key],
      });
      if (result.rows.length === 0) {
        return NextResponse.json({ error: "Setting not found" }, { status: 404 });
      }
      return NextResponse.json(result.rows[0]);
    }

    const result = await db.execute({
      sql: "SELECT key, value, updated_at FROM settings ORDER BY key",
    });
    return NextResponse.json({ settings: result.rows });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read settings" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/settings — Upsert de uma configuração.
 * Body: { key: string, value: string }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const db = getDb();
    const body = await request.json();

    if (!body.key || body.value === undefined) {
      return NextResponse.json({ error: "key and value are required" }, { status: 400 });
    }

    await db.execute({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      args: [body.key, String(body.value)],
    });

    return NextResponse.json({ key: body.key, value: body.value });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save setting" },
      { status: 500 }
    );
  }
}
