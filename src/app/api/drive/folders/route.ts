import { NextRequest, NextResponse } from "next/server";
import { listRoots, listFoldersInParent } from "@/lib/google-drive";
import { initDb } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    await initDb();

    const body = await request.json().catch(() => ({}));
    const parentId = body.parent_id as string | undefined;
    const driveId = body.drive_id as string | undefined;

    // If no parent_id, list roots (My Drive + Shared Drives)
    if (!parentId) {
      const roots = await listRoots();
      return NextResponse.json({
        type: "roots",
        items: roots.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          hasChildren: true,
        })),
      });
    }

    // List children of a specific folder
    const folders = await listFoldersInParent(parentId, driveId || undefined);
    return NextResponse.json({
      type: "children",
      parent_id: parentId,
      items: folders.map((f) => ({
        id: f.id,
        name: f.name,
        type: "folder" as const,
        hasChildren: true, // assume all folders can have children
      })),
    });
  } catch (error) {
    console.error("Folders error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list folders" },
      { status: 500 }
    );
  }
}
