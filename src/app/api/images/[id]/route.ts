import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = await initDb();

    const result = await db.execute({
      sql: "SELECT * FROM images WHERE id = ?",
      args: [id],
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
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = await initDb();

    await db.execute({ sql: "DELETE FROM images WHERE id = ?", args: [id] });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("Delete image error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
