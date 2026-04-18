/**
 * GET /api/settings?key=xxx — Busca uma configuração.
 * GET /api/settings — Lista todas as configurações.
 * POST /api/settings — Upsert. Body: { key: string, value: string }
 *
 * MIGRADO NA FASE 1C (Wave 4):
 *  - getDb() → dbAdmin (tabela global, sem workspace_id — legado)
 *  - Queries tipadas via Drizzle
 *  - Ver TD-005: futura consolidação em workspace_settings
 */
import { NextRequest, NextResponse } from "next/server";
import { dbAdmin } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { asc, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const key = request.nextUrl.searchParams.get("key");

    if (key) {
      const rows = await dbAdmin
        .select({
          key: settings.key,
          value: settings.value,
          updated_at: settings.updatedAt,
        })
        .from(settings)
        .where(eq(settings.key, key))
        .limit(1);
      if (rows.length === 0) {
        return NextResponse.json({ error: "Setting not found" }, { status: 404 });
      }
      return NextResponse.json(rows[0]);
    }

    const rows = await dbAdmin
      .select({
        key: settings.key,
        value: settings.value,
        updated_at: settings.updatedAt,
      })
      .from(settings)
      .orderBy(asc(settings.key));
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

    await dbAdmin
      .insert(settings)
      .values({ key: body.key, value: String(body.value) })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: sql`EXCLUDED.value`,
          updatedAt: sql`NOW()`,
        },
      });

    return NextResponse.json({ key: body.key, value: body.value });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save setting" },
      { status: 500 },
    );
  }
}
