// =============================================================================
// GET /api/metrics — Prometheus scrape target
// =============================================================================
// Protegido por bearer token (env PROMETHEUS_SCRAPE_TOKEN). Resposta em
// formato text/plain do prom-client.
//
// Por que bearer + não /api/auth:
//   Prometheus scrapes de uma máquina externa (ou container irmão) sem cookie
//   de sessão. Token longo no env + comparação constant-time evita timing
//   attacks em força bruta.
//
// Setup:
//   export PROMETHEUS_SCRAPE_TOKEN="$(openssl rand -hex 32)"
//   # prometheus.yml:
//   # scrape_configs:
//   #   - job_name: pegasus-ads
//   #     authorization: { type: Bearer, credentials: "$TOKEN" }

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { register } from "@/lib/metrics";

export const runtime = "nodejs";
// Não cacheia — precisa refletir estado atual do registry.
export const dynamic = "force-dynamic";

function bearerMatches(headerValue: string | null, expected: string): boolean {
  if (!headerValue) return false;
  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) return false;
  const token = headerValue.slice(prefix.length);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const expected = process.env.PROMETHEUS_SCRAPE_TOKEN;
  if (!expected) {
    // Sem token configurado, endpoint fica fechado por padrão — fail-safe.
    return NextResponse.json(
      { error: "METRICS_DISABLED", message: "PROMETHEUS_SCRAPE_TOKEN not set" },
      { status: 503 },
    );
  }

  const auth = request.headers.get("authorization");
  if (!bearerMatches(auth, expected)) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "Invalid or missing bearer token" },
      { status: 401 },
    );
  }

  const body = await register.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": register.contentType },
  });
}
