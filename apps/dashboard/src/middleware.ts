import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySessionToken, getDevSessionUser } from "@/lib/auth";
import { hasRolePermission } from "@/lib/domain";
import type { OidcSessionUser } from "@/lib/types";

export interface RouteAccessResult {
  action: "allow" | "redirect" | "forbidden" | "unauthorized";
  redirectUrl?: string;
  user?: OidcSessionUser;
}

const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/api/auth",
  "/_next",
  "/favicon.ico",
  "/robots.txt",
];

/**
 * Pure route access check logic, isolated for automated testing and Next.js middleware execution.
 */
export function checkRouteAccess(
  pathname: string,
  sessionCookie: string | undefined,
  secret: string,
  devAuthEnabled: boolean = false
): RouteAccessResult {
  // 1. Allow public static assets and auth callback routes
  if (PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return { action: "allow" };
  }

  // 2. Validate session token if present
  let user: OidcSessionUser | null = null;
  if (sessionCookie) {
    user = verifySessionToken(sessionCookie, secret);
  }

  // 3. Fallback to dev operator session if dev auth is enabled and no valid cookie
  if (!user && devAuthEnabled) {
    user = getDevSessionUser("operator");
  }

  // 4. If no valid session user, challenge unauthenticated request
  if (!user) {
    if (pathname.startsWith("/api/")) {
      return { action: "unauthorized" };
    }
    return { action: "redirect", redirectUrl: "/login" };
  }

  // 5. Enforce RBAC permissions on mutation routes
  if (pathname.startsWith("/api/actions/revoke")) {
    if (!hasRolePermission(user.role, "revoke")) {
      return { action: "forbidden" };
    }
  }

  return { action: "allow", user };
}

/**
 * Next.js Edge Middleware entry point
 */
export function middleware(request: NextRequest) {
  const secret =
    process.env.SESSION_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "default-development-session-secret-min-32-chars-long";

  const devAuthEnabled =
    process.env.NODE_ENV !== "production" ||
    process.env.SYNAPSE_DEV_AUTH === "true";

  const cookie = request.cookies.get("synapse_session")?.value;
  const result = checkRouteAccess(request.nextUrl.pathname, cookie, secret, devAuthEnabled);

  if (result.action === "allow") {
    const res = NextResponse.next();
    if (result.user) {
      res.headers.set("x-synapse-user", result.user.login);
      res.headers.set("x-synapse-role", result.user.role);
    }
    return res;
  }

  if (result.action === "redirect" && result.redirectUrl) {
    const loginUrl = new URL(result.redirectUrl, request.url);
    loginUrl.searchParams.set("from", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (result.action === "forbidden") {
    return NextResponse.json(
      {
        error: "FORBIDDEN",
        message: "Your role does not have permission to execute this operation",
      },
      { status: 403 }
    );
  }

  return NextResponse.json(
    {
      error: "UNAUTHORIZED",
      message: "Authentication required to access this resource",
    },
    { status: 401 }
  );
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
