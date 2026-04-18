/**
 * GET    /api/images/[id]  — detalhes de uma imagem
 * DELETE /api/images/[id]  — remove metadata (blob permanece)
 *
 * MIGRADO NA FASE 1C (Wave 4):
 *  - getDb() → withWorkspace (RLS escopa images)
 *  - Queries tipadas via Drizzle
 *  - Filtros workspace_id manuais removidos (RLS cobre)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { images } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    const rows = await withWorkspace(auth.workspace_id, async (tx) =>
      tx.select().from(images).where(eq(images.id, id)).limit(1),
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    return NextResponse.json({ image: rows[0] });
  } catch (error) {
    console.error("Get image error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;

    await withWorkspace(auth.workspace_id, async (tx) => {
      await tx.delete(images).where(eq(images.id, id));
    });

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("Delete image error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
