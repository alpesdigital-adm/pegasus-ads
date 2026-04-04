import { NextRequest, NextResponse } from "next/server";
import { listRoots, listFoldersInParent } from "@/lib/google-drive";
import { requireAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json().catch(() => ({}));
    const parentId = body.parent_id as string | undefined;
    const driveId = body.drive_id as string | undefined;

    // If no parent_id, list roots (My Drive + Shared Drives)
    if (!parentId) {
      const roots = await listRoots(auth.workspace_id);
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
    const folders = await listFoldersInParent(auth.workspace_id, parentId, driveId || undefined);
    return NextResponse.json({
      type: "children",
      parent_id: parentId,
      items: folders.map((f) => ({
        id: f.id,
        name: f.name,
        type: "folder" as const,
        hasChildren: true,
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
