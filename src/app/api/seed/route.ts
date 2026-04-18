import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

/**
 * POST /api/seed — endpoint legado de "inicialização" do schema.
 *
 * DEPRECATED: schema agora é gerenciado por Drizzle migrations
 * (drizzle/*.sql). Esta rota ficou como stub durante a Fase 1C — mantida
 * apenas para não quebrar clients que ainda fazem ping aqui no startup.
 *
 * MIGRADO NA FASE 1C (cleanup):
 *  - Removido import getDb + instanciação (era dead code desde a Fase 1B).
 *  - Responde 200 como antes (preserva contrato).
 *
 * TODO: remover após 30 dias de Fase 1C estabilizada — ninguém deve
 * depender disso.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    message: "Database initialized successfully",
    note: "No-op endpoint — schema managed by Drizzle migrations since Fase 1B.",
  });
}
