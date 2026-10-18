import type { OidcSessionUser, UserRole } from "@/lib/types";

export interface AuthConfig {
  adminUsers?: string[];
  adminTeams?: string[];
  operatorUsers?: string[];
  operatorTeams?: string[];
}

/**
 * Returns the session signing secret.
 * Throws a fatal configuration error in production if SESSION_SECRET is unset.
 */
export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "CRITICAL SECURITY CONFIGURATION ERROR: SESSION_SECRET environment variable must be set in production"
      );
    }
    return "development-only-session-secret-min-32-chars-long";
  }
  return secret;
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
 * Encodes a Uint8Array to base64url format without Node.js Buffer (Edge Runtime compatible).
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decodes a base64url string to Uint8Array without Node.js Buffer (Edge Runtime compatible).
 */
export function base64UrlToBytes(base64url: string): Uint8Array {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function stringToBase64Url(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str));
}

export function base64UrlToString(base64url: string): string {
  return new TextDecoder().decode(base64UrlToBytes(base64url));
}

/**
 * Imports an HMAC key using standard WebCrypto API.
 */
async function getHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

/**
 * Signs string data with HMAC-SHA256 using standard WebCrypto.
 */
export async function signData(data: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret, ["sign"]);
  const sigBuf = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return bytesToBase64Url(new Uint8Array(sigBuf));
}

/**
 * Verifies an HMAC-SHA256 signature using standard WebCrypto (timing-safe by design).
 */
export async function verifySignature(
  data: string,
  signatureBase64Url: string,
  secret: string
): Promise<boolean> {
  try {
    const key = await getHmacKey(secret, ["verify"]);
    const sigBytes = base64UrlToBytes(signatureBase64Url);
    return await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes as unknown as BufferSource,
      new TextEncoder().encode(data)
    );
  } catch {
    return false;
  }
}

/**
 * Creates a signed compact session token (base64url(payload).signature) using WebCrypto.
 */
export async function createSessionToken(
  user: OidcSessionUser,
  secret: string = getSessionSecret()
): Promise<string> {
  const payloadStr = JSON.stringify(user);
  const encodedPayload = stringToBase64Url(payloadStr);
  const signature = await signData(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies a compact session token, validates HMAC signature via WebCrypto, and checks expiry.
 * Returns OidcSessionUser if valid, null otherwise.
 */
export async function verifySessionToken(
  token: string,
  secret: string = getSessionSecret()
): Promise<OidcSessionUser | null> {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, providedSig] = parts;
  const isValid = await verifySignature(encodedPayload, providedSig, secret);
  if (!isValid) {
    return null;
  }

  try {
    const rawJson = base64UrlToString(encodedPayload);
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
 * Generates a CSRF token bound to a session identifier using WebCrypto HMAC.
 */
export async function generateCsrfToken(
  sessionId: string,
  secret: string = getSessionSecret()
): Promise<string> {
  return signData(`csrf:${sessionId}`, secret);
}

/**
 * Validates a CSRF token for a given session identifier using WebCrypto HMAC.
 */
export async function validateCsrfToken(
  csrfToken: string,
  sessionId: string,
  secret: string = getSessionSecret()
): Promise<boolean> {
  if (!csrfToken || !sessionId || !secret) {
    return false;
  }
  return verifySignature(`csrf:${sessionId}`, csrfToken, secret);
}
