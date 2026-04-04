import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const db = getDb();

    const result = await db.execute({
      sql: "SELECT * FROM images WHERE id = ? AND workspace_id = ?",
      args: [id, auth.workspace_id],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    return NextResponse.json({ image: result.rows[0] });
  } catch (error) {
    console.error("Get image error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const db = getDb();

    await db.execute({ sql: "DELETE FROM images WHERE id = ? AND workspace_id = ?", args: [id, auth.workspace_id] });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("Delete image error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
