/**
 * GET    /api/workspaces/api-keys — Lista API keys do workspace
 * POST   /api/workspaces/api-keys — Cria nova API key
 * DELETE /api/workspaces/api-keys?id=xxx — Revoga API key
 *
 * POST Body: { name: "My Integration" }
 *
 * A key completa só é retornada no POST (criação). Depois, só o prefixo é visível.
 *
 * Errors:
 * - 401 UNAUTHORIZED
 * - 403 FORBIDDEN: apenas owner/admin
 * - 400 VALIDATION_ERROR
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, AuthContext } from "@/lib/auth";
import { initDb } from "@/lib/db";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/workspace";

export async function GET(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  const keys = await listApiKeys(ctx.workspace_id);
  return NextResponse.json({ keys });
}

export async function POST(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  if (ctx.role === "member") {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "Only owner or admin can create API keys" },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { name } = body;

  if (!name) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Field required: name" },
      { status: 400 }
    );
  }

  const { id, key } = await createApiKey(ctx.workspace_id, ctx.user_id, name);

  return NextResponse.json(
    {
      id,
      name,
      key, // Only shown once!
      warning: "Save this key now — it will not be shown again.",
    },
    { status: 201 }
  );
}

export async function DELETE(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  if (ctx.role === "member") {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "Only owner or admin can revoke API keys" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const keyId = searchParams.get("id");

  if (!keyId) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Query param required: id" },
      { status: 400 }
    );
  }

  await revokeApiKey(ctx.workspace_id, keyId);
  return NextResponse.json({ ok: true });
}
