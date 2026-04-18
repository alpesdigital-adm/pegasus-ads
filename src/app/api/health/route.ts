/**
 * GET /api/health
 *
 * Healthcheck estrutural pro cluster. Retorna 200 se tudo OK, 503 se
 * alguma dependência crítica tá quebrada.
 *
 * Uso: uptime monitor externo (UptimeRobot, Grafana Synthetic, etc)
 * bate aqui a cada 1-5min. Se retornar 503, alerta.
 *
 * Não requer auth — é probe pública. NÃO expõe detalhes de schema/users
 * no response; só status agregado.
 *
 * Criado em 2026-04-18 como follow-up #4 da peer review do TD-014.
 */

import { NextResponse } from "next/server";
import { db, sql } from "@/lib/db";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const log = logger.child({ route: "/api/health" });

interface CheckResult {
  name: string;
  ok: boolean;
  duration_ms: number;
  error?: string;
}

async function timed<T>(name: string, fn: () => Promise<T>): Promise<CheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, duration_ms: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, ok: false, duration_ms: Date.now() - start, error: msg };
  }
}

export async function GET() {
  const checks: CheckResult[] = [];

  // 1. DB pool — conectividade básica via pool Supavisor
  //    Se a role supavisor_meta quebrar ou Supavisor estiver down, falha aqui.
  checks.push(
    await timed("db_pool", async () => {
      const result = await db.execute(sql`SELECT 1 AS ok`);
      const rows = result as unknown as Array<{ ok: number }>;
      if (rows[0]?.ok !== 1) throw new Error("unexpected result");
    }),
  );

  // 2. workspace RLS — prova que set_config funciona em transaction mode
  //    (se Supavisor passar a session mode ou perder state, quebra aqui)
  checks.push(
    await timed("rls_set_local", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.workspace_id', 'healthcheck-sentinel', true)`);
        const r = await tx.execute(
          sql`SELECT current_setting('app.workspace_id', true) AS v`,
        );
        const rows = r as unknown as Array<{ v: string }>;
        if (rows[0]?.v !== "healthcheck-sentinel") {
          throw new Error("SET LOCAL não persistiu em transaction mode");
        }
      });
    }),
  );

  const allOk = checks.every((c) => c.ok);
  const totalMs = checks.reduce((s, c) => s + c.duration_ms, 0);

  if (!allOk) {
    log.error({ checks }, "health check failed");
  }

  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      checks,
      total_duration_ms: totalMs,
      timestamp: new Date().toISOString(),
    },
    { status: allOk ? 200 : 503 },
  );
}
