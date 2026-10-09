// @synapsestate/lease — Cryptographic Lease Core & Expiry Engine

// Domain Separation Prefixes
export const LEASE_DOMAIN_PREFIX = "synapsestate/lease/v1\n";
export const REVOCATION_DOMAIN_PREFIX = "synapsestate/revocation/v1\n";
export const KEYREVOCATION_DOMAIN_PREFIX = "synapsestate/keyrevocation/v1\n";

// RFC 8785 JSON Canonicalization Scheme (JCS)
export { canonicalizeJson } from "./canonicalize.js";

// Zod Schemas & Inferred Types
export {
  FLAG_KEY_REGEX,
  BASE64URL_REGEX,
  ULID_REGEX,
  LeasePayloadSchema,
  type LeasePayload,
  LeaseEnvelopeSchema,
  type LeaseEnvelope,
  RevocationPayloadSchema,
  type RevocationPayload,
  RevocationEnvelopeSchema,
  type RevocationEnvelope,
  KeyRevocationPayloadSchema,
  type KeyRevocationPayload,
  KeyRevocationEnvelopeSchema,
  type KeyRevocationEnvelope,
  KeysetKeySchema,
  type KeysetKey,
  KeysetSchema,
  type Keyset,
} from "./schema.js";

// Ed25519 Cryptographic Signing & Verification
export {
  type PublicKeyInput,
  type PrivateKeyInput,
  resolvePublicKey,
  resolvePrivateKey,
  formatPublicKeyToHex,
  formatPublicKeyToBase64Url,
  signEnvelope,
  verifyEnvelope,
  signLease,
  verifyLease,
  signRevocation,
  verifyRevocation,
  signKeyRevocation,
  verifyKeyRevocation,
} from "./crypto.js";

// Dual-Clock Expiry Validator (Invariant 3)
export {
  DEFAULT_SKEW_TOLERANCE_MS,
  DEFAULT_MAX_TTL_SECONDS,
  type ExpiryStatus,
  type LeaseExpiryParams,
  type LeaseExpiryEvaluation,
  evaluateLeaseExpiry,
  isLeaseActive,
} from "./expiry.js";

// Keyset Parser & Validator
export {
  KeysetParseError,
  KeysetValidationError,
  parseKeysetJson,
  getKey,
  hasKey,
  isKeyRevoked,
} from "./keyset.js";
