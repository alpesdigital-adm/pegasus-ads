/**
 * GET /api/workspaces/usage
 *
 * Retorna uso atual do workspace vs limites do plano.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getWorkspaceUsage } from "@/lib/billing";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const data = await getWorkspaceUsage(auth.workspace_id);

  return NextResponse.json({
    workspace_id: auth.workspace_id,
    plan: {
      name: data.plan.plan_name,
      display_name: data.plan.display_name,
      price_cents: data.plan.price_cents,
    },
    usage: data.usage,
    limits: {
      ai_generations_per_month: data.plan.ai_generations_per_month,
    },
  });
}
