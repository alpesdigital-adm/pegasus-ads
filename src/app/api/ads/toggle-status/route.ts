/**
 * POST /api/ads/toggle-status
 * Body: { ad_id: string, status: "ACTIVE" | "PAUSED" }
 *
 * Toggle ad status via Meta API. Atualiza classified_insights local para
 * refletir imediatamente no dashboard.
 *
 * MIGRADO NA FASE 1C (Wave 2 ads):
 *  - getDb().execute() → dbAdmin (cross-workspace sync — classified_insights
 *    não tem workspace_id próprio, atribuído via ad_creatives.ad_name na RLS).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getTokenForWorkspace } from "@/lib/meta";
import { dbAdmin } from "@/lib/db";
import { classifiedInsights } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

const META_API = "https://graph.facebook.com/v25.0";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { ad_id, status } = await req.json();

    if (!ad_id || !["ACTIVE", "PAUSED"].includes(status)) {
      return NextResponse.json(
        { error: "ad_id and status (ACTIVE|PAUSED) required" },
        { status: 400 },
      );
    }

    const token = await getTokenForWorkspace(auth.workspace_id);

    const res = await fetch(`${META_API}/${ad_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status, access_token: token }),
    });

    if (res.ok) {
      // Update local classified_insights to reflect immediately
      try {
        await dbAdmin
          .update(classifiedInsights)
          .set({ effectiveStatus: status })
          .where(eq(classifiedInsights.adId, ad_id));
      } catch { /* non-critical */ }

      console.log(`[ToggleStatus] ad=${ad_id} → ${status}`);
      return NextResponse.json({ success: true, ad_id, status });
    }

    const err = await res.json();
    return NextResponse.json({ success: false, ad_id, error: err }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
