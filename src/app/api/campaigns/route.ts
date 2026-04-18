/**
 * /api/campaigns — CRUD de campanhas do workspace.
 *
 * GET   — lista todas as campanhas do workspace
 * POST  — cria nova campanha
 * PATCH — atualiza campanha existente (merge shallow em config)
 *
 * MIGRADO NA FASE 1C (Wave 2):
 *  - getDb() → withWorkspace (db app role com RLS)
 *  - Manual WHERE workspace_id = ? removido — RLS enforça no Postgres
 *  - uuid() manual removido — schema usa defaultRandom()
 *  - JSON.stringify(config) removido — jsonb serializa nativamente
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { desc, eq, sql } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const rows = await withWorkspace(auth.workspace_id, async (tx) => {
      return tx
        .select()
        .from(campaigns)
        .orderBy(desc(campaigns.createdAt));
    });
    return NextResponse.json({ campaigns: rows });
  } catch (error) {
    console.error("List campaigns error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list campaigns" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();

    const inserted = await withWorkspace(auth.workspace_id, async (tx) => {
      return tx
        .insert(campaigns)
        .values({
          workspaceId: auth.workspace_id,
          name: body.name,
          metaCampaignId: body.meta_campaign_id,
          metaAccountId: body.meta_account_id,
          pixelId: body.pixel_id ?? null,
          pageId: body.page_id ?? null,
          instagramUserId: body.instagram_user_id ?? null,
          objective: body.objective ?? "OUTCOME_LEADS",
          cplTarget: body.cpl_target ?? null,
          status: body.status ?? "active",
          config: body.config ?? {},
        })
        .returning();
    });

    return NextResponse.json(inserted[0], { status: 201 });
  } catch (error) {
    console.error("Create campaign error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create campaign" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/campaigns
 * Body: { id: string, ...campos a atualizar }
 *
 * Atualiza campos permitidos. Para `config`, faz merge shallow com o existente.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();

    if (!body.id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const result = await withWorkspace(auth.workspace_id, async (tx) => {
      // Fetch current row to merge config (RLS garante workspace_id)
      const curRows = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, body.id))
        .limit(1);

      if (curRows.length === 0) return { error: "not_found" as const };
      const row = curRows[0];

      // Merge config: top-level keys do body substituem, objetos aninhados
      // fazem shallow merge
      const mergedConfig: Record<string, unknown> = {
        ...((row.config as Record<string, unknown>) ?? {}),
      };
      if (body.config && typeof body.config === "object") {
        for (const [k, v] of Object.entries(body.config)) {
          if (
            v && typeof v === "object" && !Array.isArray(v)
            && mergedConfig[k] && typeof mergedConfig[k] === "object"
          ) {
            mergedConfig[k] = {
              ...(mergedConfig[k] as Record<string, unknown>),
              ...(v as Record<string, unknown>),
            };
          } else {
            mergedConfig[k] = v;
          }
        }
      }

      // Build dynamic update set (só campos presentes no body)
      const setValues: Record<string, unknown> = {
        config: mergedConfig,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      };
      if (body.name !== undefined) setValues.name = body.name;
      if (body.meta_campaign_id !== undefined) setValues.metaCampaignId = body.meta_campaign_id;
      if (body.meta_account_id !== undefined) setValues.metaAccountId = body.meta_account_id;
      if (body.pixel_id !== undefined) setValues.pixelId = body.pixel_id;
      if (body.page_id !== undefined) setValues.pageId = body.page_id;
      if (body.instagram_user_id !== undefined) setValues.instagramUserId = body.instagram_user_id;
      if (body.objective !== undefined) setValues.objective = body.objective;
      if (body.cpl_target !== undefined) setValues.cplTarget = body.cpl_target;
      if (body.status !== undefined) setValues.status = body.status;

      const updated = await tx
        .update(campaigns)
        .set(setValues)
        .where(eq(campaigns.id, body.id))
        .returning();

      return { campaign: updated[0] };
    });

    if ("error" in result && result.error === "not_found") {
      return NextResponse.json({ error: "campaign not found" }, { status: 404 });
    }

    return NextResponse.json({ updated: true, campaign: result.campaign });
  } catch (error) {
    console.error("Update campaign error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update campaign" },
      { status: 500 },
    );
  }
}
