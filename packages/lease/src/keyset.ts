import {
  KeysetSchema,
  type Keyset,
  type KeysetKey,
  type KeyRevocationPayload,
} from "./schema.js";
import { resolvePublicKey } from "./crypto.js";

export class KeysetParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KeysetParseError";
  }
}

export class KeysetValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KeysetValidationError";
  }
}

/**
 * Safely parses and validates a keyset JSON document mounted from Git or Kubernetes ConfigMap.
 *
 * Requirements:
 * - Accepts string or Buffer input.
 * - Enforces valid empty JSON `{}` as an authoritative "revoke all keys" directive.
 * - Rejects malformed JSON syntax.
 * - Validates schema conformance (operator | admin role, TTL bounds).
 * - Cryptographically verifies that each public_key entry resolves to a valid Ed25519 key.
 */
export function parseKeysetJson(content: string | Buffer): Keyset {
  const jsonString = Buffer.isBuffer(content)
    ? content.toString("utf8")
    : content;

  if (typeof jsonString !== "string" || jsonString.trim().length === 0) {
    throw new KeysetParseError("Keyset content cannot be empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new KeysetParseError(
      `Failed to parse keyset JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const result = KeysetSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeysetValidationError(
      `Keyset failed schema validation: ${result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`,
    );
  }

  const keyset = result.data;

  // Validate each public key format
  for (const [kid, entry] of Object.entries(keyset)) {
    try {
      resolvePublicKey(entry.public_key);
    } catch (err) {
      throw new KeysetValidationError(
        `Invalid Ed25519 public key for kid "${kid}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  return keyset;
}

/**
 * Retrieves a key entry for a given kid from a keyset dictionary safely.
 */
export function getKey(keyset: Keyset, kid: string): KeysetKey | undefined {
  if (Object.prototype.hasOwnProperty.call(keyset, kid)) {
    return keyset[kid];
  }
  return undefined;
}

/**
 * Checks if a kid exists in the keyset dictionary safely.
 */
export function hasKey(keyset: Keyset, kid: string): boolean {
  return Object.prototype.hasOwnProperty.call(keyset, kid);
}

/**
 * Checks if a given key ID has been explicitly revoked via signed key revocations.
 */
export function isKeyRevoked(
  kid: string,
  keyRevocations: Iterable<KeyRevocationPayload>,
): boolean {
  for (const revocation of keyRevocations) {
    if (revocation.kid === kid) {
      return true;
    }
  }
  return false;
}
