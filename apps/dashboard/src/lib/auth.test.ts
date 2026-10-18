import { describe, it, expect } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  resolveUserRole,
  getDevSessionUser,
  generateCsrfToken,
  validateCsrfToken,
  getSessionSecret,
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

  describe("getSessionSecret", () => {
    const setNodeEnv = (val: string | undefined) => {
      (process.env as Record<string, string | undefined>).NODE_ENV = val;
    };

    it("returns development secret when unset in non-production", () => {
      const origEnv = process.env.NODE_ENV;
      const origSecret = process.env.SESSION_SECRET;
      delete process.env.SESSION_SECRET;
      delete process.env.NEXTAUTH_SECRET;
      setNodeEnv("development");

      try {
        const secret = getSessionSecret();
        expect(secret).toBe("development-only-session-secret-min-32-chars-long");
      } finally {
        setNodeEnv(origEnv);
        if (origSecret) process.env.SESSION_SECRET = origSecret;
      }
    });

    it("throws critical error in production if secret is unset", () => {
      const origEnv = process.env.NODE_ENV;
      const origSecret = process.env.SESSION_SECRET;
      delete process.env.SESSION_SECRET;
      delete process.env.NEXTAUTH_SECRET;
      setNodeEnv("production");

      try {
        expect(() => getSessionSecret()).toThrow(/SESSION_SECRET environment variable must be set in production/);
      } finally {
        setNodeEnv(origEnv);
        if (origSecret) process.env.SESSION_SECRET = origSecret;
      }
    });
  });

  describe("createSessionToken & verifySessionToken", () => {
    it("creates and successfully verifies a signed session token", async () => {
      const token = await createSessionToken(sampleUser, testSecret);
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(2); // payload.signature

      const verified = await verifySessionToken(token, testSecret);
      expect(verified).not.toBeNull();
      expect(verified?.login).toBe("alice-sre");
      expect(verified?.role).toBe("operator");
      expect(verified?.id).toBe("gh-12345");
    });

    it("rejects token with invalid signature / tampered payload", async () => {
      const token = await createSessionToken(sampleUser, testSecret);
      const [payload, sig] = token.split(".");

      // Tamper with payload (e.g. elevate role to admin)
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
      decoded.role = "admin";
      const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      const tamperedToken = `${tamperedPayload}.${sig}`;

      const result = await verifySessionToken(tamperedToken, testSecret);
      expect(result).toBeNull();
    });

    it("rejects expired session tokens", async () => {
      const expiredUser: OidcSessionUser = {
        ...sampleUser,
        expiresAt: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
      };

      const token = await createSessionToken(expiredUser, testSecret);
      const result = await verifySessionToken(token, testSecret);
      expect(result).toBeNull();
    });

    it("rejects malformed token strings", async () => {
      expect(await verifySessionToken("invalid-token", testSecret)).toBeNull();
      expect(await verifySessionToken("", testSecret)).toBeNull();
      expect(await verifySessionToken("a.b.c.d", testSecret)).toBeNull();
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
    it("generates and validates matching CSRF token", async () => {
      const sessionId = "session-xyz-123";
      const csrf = await generateCsrfToken(sessionId, testSecret);
      expect(typeof csrf).toBe("string");

      expect(await validateCsrfToken(csrf, sessionId, testSecret)).toBe(true);
      expect(await validateCsrfToken(csrf, "different-session", testSecret)).toBe(false);
      expect(await validateCsrfToken("invalid-csrf", sessionId, testSecret)).toBe(false);
    });
  });
});
