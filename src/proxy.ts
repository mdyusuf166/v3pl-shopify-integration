import { NextResponse, type NextRequest } from "next/server";
import { PORTAL_LOGIN_PATH, SESSION_COOKIE, STAFF_LOGIN_PATH } from "@/lib/auth-constants";

/**
 * Request proxy (edge). Fast-fails requests to protected areas that carry no
 * session cookie at all. This is a convenience redirect only — the real
 * verification (signature, DB status, role, ownership) happens server-side in
 * the protected layouts and route handlers (src/server/auth/guards.ts).
 */
export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (pathname.startsWith("/admin") && pathname !== STAFF_LOGIN_PATH && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = STAFF_LOGIN_PATH;
    url.search = pathname === "/admin" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith("/portal") && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = PORTAL_LOGIN_PATH;
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/portal/:path*"],
};
