import { NextResponse } from "next/server.js";
import type { NextRequest } from "next/server.js";
import { authFailure, authResponseHeaders, terminalSession } from "./lib/auth/session.ts";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/login" || path === "/api/auth/login" || path === "/api/auth/logout") return NextResponse.next();
  try {
    if (await terminalSession(request)) {
      const response = NextResponse.next();
      response.headers.set("Cache-Control", "no-store, private");
      return response;
    }
    if (path.startsWith("/api/")) return Response.json({ error: "Sign in to the terminal first.", terminalAuthRequired: true }, {
      status: 401, headers: authResponseHeaders,
    });
    return NextResponse.redirect(new URL("/login", request.url));
  } catch { return authFailure(); }
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
