import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { listVariableTypes } from "@/lib/ai-prompt";

/**
 * GET /api/variable-types — Lista os tipos de variáveis disponíveis para testes.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ variable_types: listVariableTypes() });
}
