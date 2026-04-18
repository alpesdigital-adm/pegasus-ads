import { NextRequest, NextResponse } from "next/server";
import { httpRequestsTotal, httpRequestDuration } from "@/lib/metrics";

const PUBLIC_PATHS = ["/login", "/register", "/api/auth/", "/api/docs"];

// Normaliza path pra evitar cardinality explosion nos labels Prometheus.
// /api/campaigns/abc-123/drill → /api/campaigns/:id/drill
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
function routeLabel(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (UUID_RE.test(seg) || NUMERIC_RE.test(seg) ? ":id" : seg))
    .join("/");
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const startNs = process.hrtime.bigint();

  // Não auto-observa o próprio scrape — o Prometheus bateria em si mesmo.
  const skipMetrics = pathname === "/api/metrics";

  let response: NextResponse;

  // ── Auth redirect existente (preservado) ────────────────────────────
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    response = NextResponse.next();
  } else if (pathname.startsWith("/api/")) {
    // API routes têm requireAuth interno — middleware só passa.
    response = NextResponse.next();
  } else if (pathname.startsWith("/_next/") || pathname.startsWith("/favicon")) {
    response = NextResponse.next();
  } else {
    const session = req.cookies.get("pegasus_session");
    if (!session?.value) {
      response = NextResponse.redirect(new URL("/login", req.url));
    } else {
      response = NextResponse.next();
    }
  }

  // ── Métricas ────────────────────────────────────────────────────────
  if (!skipMetrics) {
    const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    const labels = {
      method: req.method,
      route: routeLabel(pathname),
      status: String(response.status),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, seconds);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
