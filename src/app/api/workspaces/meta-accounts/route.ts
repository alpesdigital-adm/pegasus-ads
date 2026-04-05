/**
 * GET  /api/workspaces/meta-accounts — Lista contas Meta do workspace
 * POST /api/workspaces/meta-accounts — Adiciona conta Meta (token ou OAuth)
 *
 * POST Body:
 *   {
 *     label: "Minha Conta",
 *     meta_account_id: "act_1234567890",
 *     auth_method: "token" | "oauth",
 *     token?: "EAAx...",          // required when auth_method = "token"
 *     oauth_tokens?: { ... },     // required when auth_method = "oauth"
 *     page_id?: "...",
 *     pixel_id?: "...",
 *     instagram_user_id?: "..."
 *   }
 *
 * Errors:
 * - 401 UNAUTHORIZED
 * - 400 VALIDATION_ERROR: campos ausentes
 * - 403 FORBIDDEN: apenas owner/admin
 * - 409 ACCOUNT_EXISTS: conta já vinculada ao workspace
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, AuthContext } from "@/lib/auth";
import { initDb, getDb } from "@/lib/db";
import { addMetaAccount, getMetaAccounts } from "@/lib/workspace";

export async function GET(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  const accounts = await getMetaAccounts(ctx.workspace_id);

  return NextResponse.json({ accounts });
}

export async function POST(req: NextRequest) {
  await initDb();
  const authResult = await requireAuth(req);
  if (authResult instanceof NextResponse) return authResult;
  const ctx = authResult as AuthContext;

  if (ctx.role === "member") {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "Only owner or admin can manage Meta accounts" },
      { status: 403 }
    );
  }

  const body = await req.json();
  const { label, meta_account_id, auth_method, token, oauth_tokens, page_id, pixel_id, instagram_user_id } = body;

  if (!label || !meta_account_id || !auth_method) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: "Fields required: label, meta_account_id, auth_method",
      },
      { status: 400 }
    );
  }

  if (!["token", "oauth"].includes(auth_method)) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "auth_method must be 'token' or 'oauth'" },
      { status: 400 }
    );
  }

  if (auth_method === "token" && !token) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "token is required when auth_method = 'token'" },
      { status: 400 }
    );
  }

  if (auth_method === "oauth" && !oauth_tokens) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "oauth_tokens is required when auth_method = 'oauth'" },
      { status: 400 }
    );
  }

  // Check duplicate
  const db = getDb();
  const existing = await db.execute({
    sql: `SELECT id FROM workspace_meta_accounts WHERE workspace_id = ? AND meta_account_id = ?`,
    args: [ctx.workspace_id, meta_account_id],
  });
  if (existing.rows.length > 0) {
    return NextResponse.json(
      { error: "ACCOUNT_EXISTS", message: "This Meta account is already linked to your workspace" },
      { status: 409 }
    );
  }

  const id = await addMetaAccount({
    workspace_id: ctx.workspace_id,
    label,
    meta_account_id,
    auth_method,
    token,
    oauth_tokens,
    page_id,
    pixel_id,
    instagram_user_id,
  });

  return NextResponse.json(
    { id, label, meta_account_id, auth_method, page_id, pixel_id, instagram_user_id },
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
      { error: "FORBIDDEN", message: "Only owner or admin can manage Meta accounts" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "VALIDATION_ERROR", message: "id is required" }, { status: 400 });
  }

  const db = getDb();
  await db.execute({
    sql: `DELETE FROM workspace_meta_accounts WHERE id = ? AND workspace_id = ?`,
    args: [id, ctx.workspace_id],
  });

  return NextResponse.json({ ok: true });
}
