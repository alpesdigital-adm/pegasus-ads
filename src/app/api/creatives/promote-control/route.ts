/**
 * POST /api/creatives/promote-control  — Tarefa 3.2: Promoção automática de controle
 *
 * Quando um criativo atinge L5 (Winner Potencial: CPL < 80% do controle),
 * esta rota o promove a ser o novo controle da campanha.
 *
 * Body: { creative_id: string }
 *
 * MIGRADO NA FASE 1C (Wave 3):
 *  - getDb() → withWorkspace (RLS scoped)
 *  - SELECT + UPDATE em Drizzle typed; LIKE group em sql`` OR chain
 *  - Bulk UPDATE group_ids via inArray (antes: loop N UPDATEs)
 *  - Edge INSERT em Drizzle (id via defaultRandom)
 *  - 8 filtros manuais workspace_id removidos (RLS cobre)
 */

import { NextRequest, NextResponse } from "next/server";
import { withWorkspace, sql } from "@/lib/db";
import { creatives, creativeEdges, alerts } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { and, asc, eq, inArray } from "drizzle-orm";

export const runtime = "nodejs";

function getAdBaseName(creativeName: string): string {
  let name = creativeName.replace(/\.\w+$/, "");
  name = name.replace(/[FS]$/, "");
  return name;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  interface Body { creative_id?: string }
  let body: Body = {};
  try { body = await req.json(); } catch { /* ok */ }

  if (!body.creative_id) {
    return NextResponse.json({ error: "creative_id is required" }, { status: 400 });
  }

  const result = await withWorkspace(auth.workspace_id, async (tx) => {
    // ── 1. Buscar o criativo alvo ──
    const targetRows = await tx
      .select({
        id: creatives.id,
        name: creatives.name,
        status: creatives.status,
        generation: creatives.generation,
        is_control: creatives.isControl,
      })
      .from(creatives)
      .where(eq(creatives.id, body.creative_id as string))
      .limit(1);

    if (targetRows.length === 0) {
      return { error: "not_found" as const };
    }

    const target = targetRows[0];
    const baseName = getAdBaseName(target.name as string);

    // ── 2. Encontrar todos do AD group (baseName + F/S variants + exact) ──
    const groupResult = await tx.execute(sql`
      SELECT id, name FROM creatives
      WHERE name LIKE ${`${baseName}F%`}
         OR name LIKE ${`${baseName}S%`}
         OR name = ${baseName}
    `);
    const groupRows = groupResult as unknown as Array<{ id: string; name: string }>;
    const groupIds = groupRows.map((r) => r.id);

    if (groupIds.length === 0) {
      return { error: "no_group" as const };
    }

    // ── 3. Identificar controle anterior ──
    const prevControlRows = await tx
      .select({ id: creatives.id, name: creatives.name })
      .from(creatives)
      .where(eq(creatives.isControl, true))
      .orderBy(asc(creatives.createdAt))
      .limit(1);

    const previousControlId = prevControlRows[0]?.id ?? null;

    // ── 4. Revogar is_control em massa + promover AD group alvo em massa ──
    await tx.update(creatives).set({ isControl: false });

    await tx
      .update(creatives)
      .set({ isControl: true, status: "winner" })
      .where(inArray(creatives.id, groupIds));

    // ── 5. Criar edge 'iteration' (promoted_to_control) ──
    let edgeCreated = false;
    if (previousControlId && previousControlId !== body.creative_id) {
      try {
        await tx.insert(creativeEdges).values({
          workspaceId: auth.workspace_id,
          sourceId: previousControlId,
          targetId: body.creative_id as string,
          relationship: "iteration",
          variableIsolated: "promoted_to_control",
        });
        edgeCreated = true;
      } catch {
        /* ignore — edge é opcional */
      }
    }

    // ── 6. Resolver alertas L5 do criativo promovido ──
    await tx
      .update(alerts)
      .set({ resolved: true })
      .where(
        and(
          eq(alerts.creativeId, body.creative_id as string),
          eq(alerts.level, "L5"),
          eq(alerts.resolved, false),
        ),
      );

    return {
      baseName,
      groupIds,
      previousControlId,
      edgeCreated,
    };
  });

  if ("error" in result) {
    if (result.error === "not_found") {
      return NextResponse.json({ error: "Creative not found" }, { status: 404 });
    }
    if (result.error === "no_group") {
      return NextResponse.json({ error: "No creatives found for this AD group" }, { status: 404 });
    }
  }

  const { baseName, groupIds, previousControlId, edgeCreated } = result as {
    baseName: string;
    groupIds: string[];
    previousControlId: string | null;
    edgeCreated: boolean;
  };

  console.log(`[PromoteControl] AD group '${baseName}' promovido a controle. IDs: ${groupIds.join(", ")} | anterior: ${previousControlId}`);

  return NextResponse.json({
    ok: true,
    promoted_ad: baseName,
    promoted_ids: groupIds,
    previous_control_id: previousControlId,
    edge_created: edgeCreated,
  });
}

// GET — retorna o controle atual + generation=0 candidates
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const rows = await withWorkspace(auth.workspace_id, async (tx) => {
    const result = await tx.execute(sql`
      SELECT c.id, c.name, c.generation, c.is_control, c.status,
        SUM(m.spend)  AS total_spend,
        SUM(m.leads)  AS total_leads,
        CASE WHEN SUM(m.leads) > 0 THEN SUM(m.spend) / SUM(m.leads) ELSE NULL END AS cpl
      FROM creatives c
      LEFT JOIN metrics m ON m.creative_id = c.id
      WHERE (c.is_control = TRUE OR c.generation = 0)
      GROUP BY c.id, c.name, c.generation, c.is_control, c.status
      ORDER BY c.is_control DESC, c.created_at ASC
      LIMIT 4
    `);
    return result as unknown as Array<Record<string, unknown>>;
  });

  return NextResponse.json({ controls: rows });
}
