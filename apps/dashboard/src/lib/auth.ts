import crypto from "crypto";
import type { OidcSessionUser, UserRole } from "@/lib/types";

export interface AuthConfig {
  adminUsers?: string[];
  adminTeams?: string[];
  operatorUsers?: string[];
  operatorTeams?: string[];
}

/**
 * Loads auth role configuration from environment variables if not provided.
 */
export function getAuthConfigFromEnv(): AuthConfig {
  const parseList = (val?: string): string[] =>
    val
      ? val
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : [];

  return {
    adminUsers: parseList(process.env.SYNAPSE_ADMIN_USERS),
    adminTeams: parseList(process.env.SYNAPSE_ADMIN_TEAMS),
    operatorUsers: parseList(process.env.SYNAPSE_OPERATOR_USERS),
    operatorTeams: parseList(process.env.SYNAPSE_OPERATOR_TEAMS),
  };
}

/**
 * Signs payload data with HMAC-SHA256.
 */
function signData(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Creates a signed compact session token (base64url(payload).signature).
 */
export function createSessionToken(user: OidcSessionUser, secret: string): string {
  const payloadStr = JSON.stringify(user);
  const encodedPayload = Buffer.from(payloadStr, "utf-8").toString("base64url");
  const signature = signData(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies a compact session token and checks expiry.
 * Returns OidcSessionUser if valid, null otherwise.
 */
export function verifySessionToken(token: string, secret: string): OidcSessionUser | null {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, providedSig] = parts;
  const expectedSig = signData(encodedPayload, secret);

  const sigBuffer = Buffer.from(providedSig);
  const expectedBuffer = Buffer.from(expectedSig);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const rawJson = Buffer.from(encodedPayload, "base64url").toString("utf-8");
    const user = JSON.parse(rawJson) as OidcSessionUser;

    // Verify expiry timestamp
    const expiresAtMs = new Date(user.expiresAt).getTime();
    if (isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

/**
 * Resolves user role based on login and teams against AuthConfig.
 * Priority: admin > operator > viewer.
 */
export function resolveUserRole(
  user: { login: string; teams?: string[]; email?: string },
  config: AuthConfig
): UserRole {
  const login = user.login.toLowerCase();
  const userTeams = new Set((user.teams || []).map((t) => t.toLowerCase()));

  const adminUsers = new Set((config.adminUsers || []).map((u) => u.toLowerCase()));
  const adminTeams = config.adminTeams || [];

  if (adminUsers.has(login) || adminTeams.some((t) => userTeams.has(t.toLowerCase()))) {
    return "admin";
  }

  const operatorUsers = new Set((config.operatorUsers || []).map((u) => u.toLowerCase()));
  const operatorTeams = config.operatorTeams || [];

  if (operatorUsers.has(login) || operatorTeams.some((t) => userTeams.has(t.toLowerCase()))) {
    return "operator";
  }

  return "viewer";
}

/**
 * Provides a mock development session user for local testing without external OIDC providers.
 */
export function getDevSessionUser(role: UserRole = "operator"): OidcSessionUser {
  return {
    id: `dev-${role}-id`,
    login: `dev-${role}`,
    name: `Dev ${role.charAt(0).toUpperCase() + role.slice(1)}`,
    avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4",
    email: `${role}@synapsestate.local`,
    role,
    teams: role === "admin" ? ["platform-admins"] : ["sre-team"],
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  };
}

/**
 * Generates a CSRF token bound to a session ID using HMAC.
 */
export function generateCsrfToken(sessionId: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("hex");
}

/**
 * Validates a CSRF token for a given session ID.
 */
export function validateCsrfToken(
  csrfToken: string,
  sessionId: string,
  secret: string
): boolean {
  if (!csrfToken || !sessionId || !secret) {
    return false;
  }

  const expected = generateCsrfToken(sessionId, secret);
  if (csrfToken.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(csrfToken), Buffer.from(expected));
}
