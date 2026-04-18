// =============================================================================
// Metrics (prom-client) — Prometheus scrape target para Pegasus Ads
// =============================================================================
// Uso:
//   import { httpRequestsTotal, pipelineRunsTotal } from "@/lib/metrics";
//   httpRequestsTotal.inc({ method, route, status });
//
// O registry é global/singleton do prom-client — reentrância em hot-reload
// (dev) causa "Metric <x> has already been registered", então registramos só
// uma vez via guard em globalThis.

import * as promClient from "prom-client";

const g = globalThis as unknown as { __pegasusMetricsReady?: boolean };

if (!g.__pegasusMetricsReady) {
  promClient.collectDefaultMetrics({ prefix: "pegasus_" });
  g.__pegasusMetricsReady = true;
}

export const register = promClient.register;

// Factory idempotente — se métrica já existe (hot-reload), reaproveita.
function counter(
  name: string,
  help: string,
  labelNames: string[] = [],
): promClient.Counter<string> {
  const existing = promClient.register.getSingleMetric(name);
  if (existing) return existing as promClient.Counter<string>;
  return new promClient.Counter({ name, help, labelNames });
}

function histogram(
  name: string,
  help: string,
  labelNames: string[] = [],
  buckets: number[] = [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
): promClient.Histogram<string> {
  const existing = promClient.register.getSingleMetric(name);
  if (existing) return existing as promClient.Histogram<string>;
  return new promClient.Histogram({ name, help, labelNames, buckets });
}

// ── HTTP ────────────────────────────────────────────────────────────────
export const httpRequestsTotal = counter(
  "http_requests_total",
  "Total HTTP requests por method/route/status",
  ["method", "route", "status"],
);

export const httpRequestDuration = histogram(
  "http_request_duration_seconds",
  "HTTP request duration em segundos",
  ["method", "route", "status"],
);

// ── Pipelines ───────────────────────────────────────────────────────────
export const pipelineRunsTotal = counter(
  "pipeline_runs_total",
  "Execuções de pipelines (generate, publish, sync-all) por status",
  ["pipeline", "status"],
);

// ── Meta Ads API ────────────────────────────────────────────────────────
export const metaApiCallsTotal = counter(
  "meta_api_calls_total",
  "Chamadas a Meta Graph API por endpoint/status",
  ["endpoint", "status"],
);

// ── Route wrapper — uso manual por rota ─────────────────────────────────
// Proxy/middleware roda em contexto isolado das routes em Next 16, então
// não dá pra instrumentar HTTP de lá. Esta wrapper aplica por route:
//
//   export const GET = instrumentRoute("/api/foo", async (req) => {...});
//
// Routes compartilham o mesmo process do /api/metrics scrape → o counter
// incrementado aqui aparece no /api/metrics.
type RouteHandler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string | string[]>> },
) => Promise<Response>;

export function instrumentRoute<H extends RouteHandler>(
  routeName: string,
  handler: H,
): H {
  const wrapped: RouteHandler = async (req, ctx) => {
    const start = process.hrtime.bigint();
    let status = "500";
    try {
      const response = await handler(req, ctx);
      status = String(response.status);
      return response;
    } finally {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { method: req.method, route: routeName, status };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, seconds);
    }
  };
  return wrapped as H;
}
