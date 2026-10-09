import crypto from "node:crypto";
import { canonicalizeJson } from "./canonicalize.js";
import {
  LEASE_DOMAIN_PREFIX,
  REVOCATION_DOMAIN_PREFIX,
  KEYREVOCATION_DOMAIN_PREFIX,
} from "./index.js";
import {
  BASE64URL_REGEX,
  type LeasePayload,
  type LeaseEnvelope,
  type RevocationPayload,
  type RevocationEnvelope,
  type KeyRevocationPayload,
  type KeyRevocationEnvelope,
} from "./schema.js";

/**
 * Standard ASN.1 SPKI header prefix for Ed25519 public keys (RFC 8410).
 * 12 bytes: 302a 3005 0603 2b6570 032100
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type PublicKeyInput = crypto.KeyObject | string | Buffer;
export type PrivateKeyInput = crypto.KeyObject | string | Buffer;

/**
 * Normalizes an Ed25519 public key input into a `crypto.KeyObject`.
 * Supports:
 * - existing `crypto.KeyObject` (must be ed25519)
 * - PEM string
 * - 64-character hex string (32-byte raw public key)
 * - 88-character hex string (44-byte SPKI DER)
 * - 43-character base64url string (32-byte raw public key)
 * - raw 32-byte Buffer
 * - 44-byte SPKI DER Buffer
 */
export function resolvePublicKey(input: PublicKeyInput): crypto.KeyObject {
  if (input instanceof crypto.KeyObject) {
    if (input.type === "public" && input.asymmetricKeyType === "ed25519") {
      return input;
    }
    throw new TypeError(
      `Expected ed25519 public key, got ${input.asymmetricKeyType}`,
    );
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.includes("BEGIN PUBLIC KEY")) {
      const key = crypto.createPublicKey(trimmed);
      if (key.asymmetricKeyType !== "ed25519") {
        throw new TypeError(
          `Expected ed25519 PEM key, got ${key.asymmetricKeyType}`,
        );
      }
      return key;
    }

    // Hex representation
    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      if (trimmed.length === 64) {
        // 32-byte raw key in hex
        const rawBytes = Buffer.from(trimmed, "hex");
        const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawBytes]);
        return crypto.createPublicKey({
          key: spki,
          format: "der",
          type: "spki",
        });
      } else if (trimmed.length === 88) {
        // 44-byte SPKI DER in hex
        return crypto.createPublicKey({
          key: Buffer.from(trimmed, "hex"),
          format: "der",
          type: "spki",
        });
      }
    }

    // Base64url representation (43 chars = 32 raw bytes)
    if (BASE64URL_REGEX.test(trimmed)) {
      const rawBytes = Buffer.from(trimmed, "base64url");
      if (rawBytes.length === 32) {
        const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawBytes]);
        return crypto.createPublicKey({
          key: spki,
          format: "der",
          type: "spki",
        });
      } else if (rawBytes.length === 44) {
        return crypto.createPublicKey({
          key: rawBytes,
          format: "der",
          type: "spki",
        });
      }
    }

    // Try generic string key creation
    const key = crypto.createPublicKey(trimmed);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError(`Expected ed25519 key, got ${key.asymmetricKeyType}`);
    }
    return key;
  }

  if (Buffer.isBuffer(input)) {
    if (input.length === 32) {
      const spki = Buffer.concat([ED25519_SPKI_PREFIX, input]);
      return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    } else if (input.length === 44) {
      return crypto.createPublicKey({
        key: input,
        format: "der",
        type: "spki",
      });
    }
    const key = crypto.createPublicKey({
      key: input,
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError(`Expected ed25519 key, got ${key.asymmetricKeyType}`);
    }
    return key;
  }

  throw new TypeError("Unsupported public key input type");
}

/**
 * Normalizes an Ed25519 private key input into a `crypto.KeyObject`.
 */
export function resolvePrivateKey(input: PrivateKeyInput): crypto.KeyObject {
  if (input instanceof crypto.KeyObject) {
    if (input.type === "private" && input.asymmetricKeyType === "ed25519") {
      return input;
    }
    throw new TypeError(
      `Expected ed25519 private key, got ${input.asymmetricKeyType}`,
    );
  }

  const key = crypto.createPrivateKey(input);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(
      `Expected ed25519 private key, got ${key.asymmetricKeyType}`,
    );
  }
  return key;
}

/**
 * Formats an Ed25519 public key as a 64-character lowercase hex string (raw 32-byte public key).
 */
export function formatPublicKeyToHex(
  publicKey: crypto.KeyObject | PublicKeyInput,
): string {
  const resolved = resolvePublicKey(publicKey);
  const der = resolved.export({ type: "spki", format: "der" });
  return der.subarray(12).toString("hex");
}

/**
 * Formats an Ed25519 public key as a 43-character base64url string (raw 32-byte public key).
 */
export function formatPublicKeyToBase64Url(
  publicKey: crypto.KeyObject | PublicKeyInput,
): string {
  const resolved = resolvePublicKey(publicKey);
  const der = resolved.export({ type: "spki", format: "der" });
  return der.subarray(12).toString("base64url");
}

/**
 * Low-level signing function that prepends a domain separation prefix,
 * serializes payload via RFC 8785 canonicalization, and computes an Ed25519 signature.
 */
export function signEnvelope<T>(
  domainPrefix: string,
  payload: T,
  privateKeyInput: PrivateKeyInput,
): { payload: T; sig: string } {
  const canonical = canonicalizeJson(payload);
  const messageBuffer = Buffer.concat([
    Buffer.from(domainPrefix, "utf8"),
    Buffer.from(canonical, "utf8"),
  ]);

  const privateKey = resolvePrivateKey(privateKeyInput);
  const signatureBuffer = crypto.sign(null, messageBuffer, privateKey);

  return {
    payload,
    sig: signatureBuffer.toString("base64url"),
  };
}

/**
 * Low-level verification function.
 * Fails closed (returns false) on any verification mismatch, malformed payload, or invalid key.
 */
export function verifyEnvelope<T>(
  domainPrefix: string,
  envelope: { payload: T; sig: string },
  publicKeyInput: PublicKeyInput,
): boolean {
  try {
    if (
      !envelope ||
      typeof envelope !== "object" ||
      typeof envelope.sig !== "string"
    ) {
      return false;
    }

    if (!BASE64URL_REGEX.test(envelope.sig)) {
      return false;
    }

    const signatureBuffer = Buffer.from(envelope.sig, "base64url");
    if (signatureBuffer.length !== 64) {
      return false;
    }

    // Enforce strict canonical base64url representation (no unused padding malleability)
    if (signatureBuffer.toString("base64url") !== envelope.sig) {
      return false;
    }

    const publicKey = resolvePublicKey(publicKeyInput);
    const canonical = canonicalizeJson(envelope.payload);
    const messageBuffer = Buffer.concat([
      Buffer.from(domainPrefix, "utf8"),
      Buffer.from(canonical, "utf8"),
    ]);

    return crypto.verify(null, messageBuffer, publicKey, signatureBuffer);
  } catch {
    return false;
  }
}

/**
 * Signs an emergency lease payload with domain prefix LEASE_DOMAIN_PREFIX.
 */
export function signLease(
  payload: LeasePayload,
  privateKey: PrivateKeyInput,
): LeaseEnvelope {
  return signEnvelope(LEASE_DOMAIN_PREFIX, payload, privateKey);
}

/**
 * Verifies an emergency lease envelope against a trusted public key.
 */
export function verifyLease(
  envelope: LeaseEnvelope,
  publicKey: PublicKeyInput,
): boolean {
  return verifyEnvelope(LEASE_DOMAIN_PREFIX, envelope, publicKey);
}

/**
 * Signs a lease revocation payload with domain prefix REVOCATION_DOMAIN_PREFIX.
 */
export function signRevocation(
  payload: RevocationPayload,
  privateKey: PrivateKeyInput,
): RevocationEnvelope {
  return signEnvelope(REVOCATION_DOMAIN_PREFIX, payload, privateKey);
}

/**
 * Verifies a lease revocation envelope against a trusted public key.
 */
export function verifyRevocation(
  envelope: RevocationEnvelope,
  publicKey: PublicKeyInput,
): boolean {
  return verifyEnvelope(REVOCATION_DOMAIN_PREFIX, envelope, publicKey);
}

/**
 * Signs a key revocation payload with domain prefix KEYREVOCATION_DOMAIN_PREFIX.
 */
export function signKeyRevocation(
  payload: KeyRevocationPayload,
  privateKey: PrivateKeyInput,
): KeyRevocationEnvelope {
  return signEnvelope(KEYREVOCATION_DOMAIN_PREFIX, payload, privateKey);
}

/**
 * Verifies a key revocation envelope against a trusted public key.
 */
export function verifyKeyRevocation(
  envelope: KeyRevocationEnvelope,
  publicKey: PublicKeyInput,
): boolean {
  return verifyEnvelope(KEYREVOCATION_DOMAIN_PREFIX, envelope, publicKey);
}
