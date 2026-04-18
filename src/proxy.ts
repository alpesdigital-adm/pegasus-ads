import { NextRequest, NextResponse } from "next/server";
import {
  SUPABASE_ACCESS_COOKIE,
  SUPABASE_REFRESH_COOKIE,
} from "@/lib/supabase-auth";

const PUBLIC_PATHS = ["/login", "/register", "/api/auth/", "/api/docs"];

// Fase 2 introduziu cookies sb-access-token + sb-refresh-token (gotrue).
// Aceitar qualquer um dos três como "tem auth" — validação real fica com
// requireAuth() nos route handlers / pages.
const AUTH_COOKIES = [
  "pegasus_session",
  SUPABASE_ACCESS_COOKIE,
  SUPABASE_REFRESH_COOKIE,
];

// Proxy (sucessor de middleware em Next 16) roda em contexto isolado das
// routes — module-level state NÃO é compartilhado. Por isso não
// instrumentamos prom-client aqui: o counter incrementaria em um registry
// diferente do que /api/metrics lê. HTTP metrics ficam pra um wrapper de
// route handler numa iteração futura (ver docs/observability.md TODOs).
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow all API routes (they have their own auth via requireAuth)
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Allow static assets
  if (pathname.startsWith("/_next/") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // Check for any auth cookie on protected pages
  const hasAuthCookie = AUTH_COOKIES.some((name) => req.cookies.get(name)?.value);
  if (!hasAuthCookie) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
