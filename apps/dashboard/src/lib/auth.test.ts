import { describe, it, expect } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  resolveUserRole,
  getDevSessionUser,
  generateCsrfToken,
  validateCsrfToken,
  type AuthConfig,
} from "@/lib/auth";
import type { OidcSessionUser } from "@/lib/types";

describe("Dashboard Auth & RBAC Session Validator", () => {
  const testSecret = "test-session-secret-key-at-least-32-chars-long";

  const sampleUser: OidcSessionUser = {
    id: "gh-12345",
    login: "alice-sre",
    name: "Alice Engineer",
    avatarUrl: "https://avatars.githubusercontent.com/u/12345",
    email: "alice@company.internal",
    role: "operator",
    teams: ["sre-team", "oncall"],
    authenticatedAt: "2026-10-18T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  };

  describe("createSessionToken & verifySessionToken", () => {
    it("creates and successfully verifies a signed session token", () => {
      const token = createSessionToken(sampleUser, testSecret);
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(2); // payload.signature

      const verified = verifySessionToken(token, testSecret);
      expect(verified).not.toBeNull();
      expect(verified?.login).toBe("alice-sre");
      expect(verified?.role).toBe("operator");
      expect(verified?.id).toBe("gh-12345");
    });

    it("rejects token with invalid signature / tampered payload", () => {
      const token = createSessionToken(sampleUser, testSecret);
      const [payload, sig] = token.split(".");

      // Tamper with payload (e.g. elevate role to admin)
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
      decoded.role = "admin";
      const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      const tamperedToken = `${tamperedPayload}.${sig}`;

      const result = verifySessionToken(tamperedToken, testSecret);
      expect(result).toBeNull();
    });

    it("rejects expired session tokens", () => {
      const expiredUser: OidcSessionUser = {
        ...sampleUser,
        expiresAt: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
      };

      const token = createSessionToken(expiredUser, testSecret);
      const result = verifySessionToken(token, testSecret);
      expect(result).toBeNull();
    });

    it("rejects malformed token strings", () => {
      expect(verifySessionToken("invalid-token", testSecret)).toBeNull();
      expect(verifySessionToken("", testSecret)).toBeNull();
      expect(verifySessionToken("a.b.c.d", testSecret)).toBeNull();
    });
  });

  describe("resolveUserRole", () => {
    const config: AuthConfig = {
      adminUsers: ["charlie-admin"],
      adminTeams: ["platform-admins"],
      operatorUsers: ["alice-sre"],
      operatorTeams: ["sre-oncall"],
    };

    it("resolves admin role when user login is in adminUsers", () => {
      const role = resolveUserRole({ login: "charlie-admin" }, config);
      expect(role).toBe("admin");
    });

    it("resolves admin role when user belongs to an admin team", () => {
      const role = resolveUserRole({ login: "bob", teams: ["platform-admins"] }, config);
      expect(role).toBe("admin");
    });

    it("resolves operator role when user is in operatorUsers", () => {
      const role = resolveUserRole({ login: "alice-sre" }, config);
      expect(role).toBe("operator");
    });

    it("resolves operator role when user belongs to an operator team", () => {
      const role = resolveUserRole({ login: "dave", teams: ["sre-oncall"] }, config);
      expect(role).toBe("operator");
    });

    it("defaults to viewer role for unrecognized users", () => {
      const role = resolveUserRole({ login: "guest-user", teams: ["general"] }, config);
      expect(role).toBe("viewer");
    });
  });

  describe("getDevSessionUser", () => {
    it("returns a valid dev operator user for local testing", () => {
      const devUser = getDevSessionUser("operator");
      expect(devUser.login).toBe("dev-operator");
      expect(devUser.role).toBe("operator");
      expect(new Date(devUser.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("allows requesting dev admin user", () => {
      const devAdmin = getDevSessionUser("admin");
      expect(devAdmin.login).toBe("dev-admin");
      expect(devAdmin.role).toBe("admin");
    });
  });

  describe("CSRF Protection", () => {
    it("generates and validates matching CSRF token", () => {
      const sessionId = "session-xyz-123";
      const csrf = generateCsrfToken(sessionId, testSecret);
      expect(typeof csrf).toBe("string");

      expect(validateCsrfToken(csrf, sessionId, testSecret)).toBe(true);
      expect(validateCsrfToken(csrf, "different-session", testSecret)).toBe(false);
      expect(validateCsrfToken("invalid-csrf", sessionId, testSecret)).toBe(false);
    });
  });
});
