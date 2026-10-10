import {
  KeysetSchema,
  KID_REGEX,
  FORBIDDEN_KID_NAMES,
  type Keyset,
  type KeysetKey,
  type KeyRevocationPayload,
  type LeaseEnvelope,
  type RevocationEnvelope,
  type KeyRevocationEnvelope,
} from "./schema.js";
import {
  resolvePublicKey,
  verifyLease,
  verifyRevocation,
  verifyKeyRevocation,
} from "./crypto.js";

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
 * - Defensively rejects prototype pollution attempts (__proto__, constructor, prototype).
 * - Enforces kid charset and length limits (KID_REGEX, max 64 chars).
 * - Validates schema conformance (roles, status, TTL bounds).
 * - Cryptographically verifies that each public_key entry resolves to a valid Ed25519 key.
 * - Returns a clean null-prototype dictionary.
 */
export function parseKeysetJson(content: string | Buffer): Keyset {
  if (typeof content !== "string" && !Buffer.isBuffer(content)) {
    throw new TypeError(
      `Expected string or Buffer for keyset, received ${content === null ? "null" : typeof content}`,
    );
  }

  const jsonString = Buffer.isBuffer(content)
    ? content.toString("utf8")
    : content;

  if (jsonString.trim().length === 0) {
    throw new KeysetParseError("Keyset content cannot be empty");
  }

  // Pre-parse lexical check for forbidden prototype keys
  if (
    /(?:^|[{,\s])\s*"(?:__proto__|constructor|prototype)"\s*:/i.test(jsonString)
  ) {
    throw new KeysetValidationError(
      "Keyset JSON contains forbidden reserved prototype identifier (__proto__, constructor, or prototype)",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString, (key, value) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new KeysetValidationError(
          `Keyset JSON contains forbidden reserved identifier: "${key}"`,
        );
      }
      return value;
    });
  } catch (err) {
    if (err instanceof KeysetValidationError) {
      throw err;
    }
    throw new KeysetParseError(
      `Failed to parse keyset JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KeysetValidationError("Keyset JSON root must be an object");
  }

  // Check all own keys of parsed object for kid constraints
  for (const kid of Object.keys(parsed)) {
    if ((FORBIDDEN_KID_NAMES as readonly string[]).includes(kid)) {
      throw new KeysetValidationError(
        `Keyset contains forbidden reserved identifier: "${kid}"`,
      );
    }
    if (!KID_REGEX.test(kid)) {
      throw new KeysetValidationError(
        `Keyset key "${kid}" violates kid format requirements (must match ${KID_REGEX})`,
      );
    }
  }

  const result = KeysetSchema.safeParse(parsed);
  if (!result.success) {
    throw new KeysetValidationError(
      `Keyset failed schema validation: ${result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`,
    );
  }

  // Build null-prototype dictionary
  const cleanKeyset: Keyset = Object.create(null);

  // Validate each public key format and populate cleanKeyset
  for (const [kid, entry] of Object.entries(result.data)) {
    try {
      resolvePublicKey(entry.public_key);
    } catch (err) {
      throw new KeysetValidationError(
        `Invalid Ed25519 public key for kid "${kid}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    cleanKeyset[kid] = entry;
  }

  return cleanKeyset;
}

/**
 * Retrieves a key entry for a given kid from a keyset dictionary safely.
 */
export function getKey(keyset: Keyset, kid: string): KeysetKey | undefined {
  return Object.hasOwn(keyset, kid) ? keyset[kid] : undefined;
}

/**
 * Checks if a kid exists in the keyset dictionary safely.
 */
export function hasKey(keyset: Keyset, kid: string): boolean {
  return Object.hasOwn(keyset, kid);
}

/**
 * Checks if a key entry is in active status.
 */
export function isKeyActive(key: KeysetKey): boolean {
  return key.status === "active";
}

/**
 * Checks whether a key is authorized to sign emergency feature leases.
 * Requires active status and lease_signer permission.
 */
export function canSignLease(key: KeysetKey): boolean {
  if (!isKeyActive(key)) {
    return false;
  }
  return key.roles.includes("lease_signer");
}

/**
 * Checks whether a key is authorized to sign lease revocations.
 * Requires active status and lease_signer permission.
 */
export function canRevokeLease(key: KeysetKey): boolean {
  return canSignLease(key);
}

/**
 * Checks whether a key is authorized to sign key revocations (ARCHITECTURE.md:286).
 * Requires active status and explicit key_revoker permission.
 */
export function canRevokeKey(key: KeysetKey): boolean {
  if (!isKeyActive(key)) {
    return false;
  }
  return key.roles.includes("key_revoker");
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

/**
 * Cryptographically verifies a lease envelope against a trusted keyset while enforcing:
 * 1. Pinned keyset existence (kid exists in keyset)
 * 2. Active status (status === "active")
 * 3. Key authorization policy (canSignLease)
 * 4. Maximum TTL ceiling policy (payload.ttl_seconds <= key.max_ttl_seconds)
 * 5. Ed25519 signature validity
 */
export function verifyLeaseWithKeyset(
  envelope: LeaseEnvelope,
  keyset: Keyset,
): boolean {
  try {
    const kid = envelope.payload.kid;
    const key = getKey(keyset, kid);
    if (!key) {
      return false;
    }
    if (!canSignLease(key)) {
      return false;
    }
    if (
      key.max_ttl_seconds !== undefined &&
      envelope.payload.ttl_seconds > key.max_ttl_seconds
    ) {
      return false;
    }
    return verifyLease(envelope, key.public_key);
  } catch {
    return false;
  }
}

/**
 * Cryptographically verifies a lease revocation envelope against a trusted keyset while enforcing:
 * 1. Pinned keyset existence (kid exists in keyset)
 * 2. Active status (status === "active")
 * 3. Key authorization policy (canRevokeLease)
 * 4. Ed25519 signature validity
 */
export function verifyRevocationWithKeyset(
  envelope: RevocationEnvelope,
  keyset: Keyset,
): boolean {
  try {
    const kid = envelope.payload.kid;
    const key = getKey(keyset, kid);
    if (!key) {
      return false;
    }
    if (!canRevokeLease(key)) {
      return false;
    }
    return verifyRevocation(envelope, key.public_key);
  } catch {
    return false;
  }
}

/**
 * Cryptographically verifies a key revocation envelope against a trusted keyset while enforcing:
 * 1. Pinned keyset existence (revoked_by_kid exists in keyset)
 * 2. Active status (status === "active")
 * 3. Key authorization policy (canRevokeKey: requires key_revoker or admin role)
 * 4. Ed25519 signature validity
 */
export function verifyKeyRevocationWithKeyset(
  envelope: KeyRevocationEnvelope,
  keyset: Keyset,
  signerKid?: string,
): boolean {
  try {
    const kid = signerKid ?? envelope.payload.revoked_by_kid;
    if (!kid) {
      return false;
    }
    const key = getKey(keyset, kid);
    if (!key) {
      return false;
    }
    if (!canRevokeKey(key)) {
      return false;
    }
    return verifyKeyRevocation(envelope, key.public_key);
  } catch {
    return false;
  }
}
