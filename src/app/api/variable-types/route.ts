import { NextResponse } from "next/server";
import { listVariableTypes } from "@/lib/ai-prompt";

/**
 * GET /api/variable-types — Lista os tipos de variáveis disponíveis para testes.
 */
export async function GET() {
  return NextResponse.json({ variable_types: listVariableTypes() });
}
