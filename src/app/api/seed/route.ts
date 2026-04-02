import { NextResponse } from "next/server";
import { initDb } from "@/lib/db";

export async function POST() {
  try {
    const db = await initDb();
    return NextResponse.json({ message: "Database initialized successfully" });
  } catch (error) {
    console.error("Seed error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
