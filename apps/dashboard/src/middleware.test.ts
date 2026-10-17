import { describe, it, expect } from "vitest";
import { checkRouteAccess } from "@/middleware";
import { createSessionToken } from "@/lib/auth";
import type { OidcSessionUser } from "@/lib/types";

describe("Dashboard Middleware Route Protection", () => {
  const secret = "test-secret-at-least-32-characters-long";

  const operatorUser: OidcSessionUser = {
    id: "user-1",
    login: "alice",
    name: "Alice Operator",
    role: "operator",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };

  const viewerUser: OidcSessionUser = {
    id: "user-2",
    login: "bob",
    name: "Bob Viewer",
    role: "viewer",
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };

  it("permits public routes without session cookie", () => {
    expect(checkRouteAccess("/login", undefined, secret, false).action).toBe("allow");
    expect(checkRouteAccess("/api/auth/github", undefined, secret, false).action).toBe("allow");
    expect(checkRouteAccess("/_next/static/chunk.js", undefined, secret, false).action).toBe("allow");
    expect(checkRouteAccess("/favicon.ico", undefined, secret, false).action).toBe("allow");
  });

  it("redirects unauthenticated user from protected page to /login in production", () => {
    const result = checkRouteAccess("/leases", undefined, secret, false);
    expect(result.action).toBe("redirect");
    expect(result.redirectUrl).toBe("/login");
  });

  it("permits protected page access with valid session cookie", () => {
    const token = createSessionToken(viewerUser, secret);
    const result = checkRouteAccess("/leases", token, secret, false);
    expect(result.action).toBe("allow");
    expect(result.user?.role).toBe("viewer");
  });

  it("blocks viewer role from mutation API routes with 403 Forbidden", () => {
    const token = createSessionToken(viewerUser, secret);
    const result = checkRouteAccess("/api/actions/revoke", token, secret, false);
    expect(result.action).toBe("forbidden");
  });

  it("permits operator role to access revocation API route", () => {
    const token = createSessionToken(operatorUser, secret);
    const result = checkRouteAccess("/api/actions/revoke", token, secret, false);
    expect(result.action).toBe("allow");
  });

  it("allows dev mode bypass when devAuthEnabled is true", () => {
    const result = checkRouteAccess("/leases", undefined, secret, true);
    expect(result.action).toBe("allow");
    expect(result.user?.role).toBe("operator");
  });
});
