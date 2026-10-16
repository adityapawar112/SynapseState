// @synapsestate/lease — Cryptographic Lease Core & Expiry Engine

// Domain Separation Prefixes
export {
  LEASE_DOMAIN_PREFIX,
  REVOCATION_DOMAIN_PREFIX,
  KEYREVOCATION_DOMAIN_PREFIX,
  CHECKPOINT_DOMAIN_PREFIX,
} from "./domains.js";

// RFC 8785 JSON Canonicalization Scheme (JCS)
export { canonicalizeJson } from "./canonicalize.js";

// Zod Schemas & Inferred Types
export {
  FLAG_KEY_REGEX,
  BASE64URL_REGEX,
  ULID_REGEX,
  KID_REGEX,
  FORBIDDEN_KID_NAMES,
  KidSchema,
  KEY_ROLE_VALUES,
  type KeyRole,
  KEY_STATUS_VALUES,
  type KeyStatus,
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
  CheckpointPayloadSchema,
  type CheckpointPayload,
  CheckpointEnvelopeSchema,
  type CheckpointEnvelope,
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
  type AsyncSigner,
  signLeaseWithSigner,
  signRevocationWithSigner,
} from "./crypto.js";

// Audit Checkpoint Signing & Keyset Verification
export {
  signCheckpoint,
  verifyCheckpoint,
  signCheckpointWithSigner,
  verifyCheckpointWithKeyset,
} from "./checkpoint.js";

// Audit Ledger Chain Primitives (RFC 8785 + SHA-256)
export {
  GENESIS_PREV_HASH,
  type AuditEventData,
  type AuditEventRecord,
  type ChainVerificationResult,
  canonicalizeAuditEvent,
  computeEventHash,
  verifySingleEvent,
  verifyAuditChain,
} from "./chain.js";

// Dual-Clock Expiry Validator (Invariant 3)
export {
  DEFAULT_SKEW_TOLERANCE_MS,
  DEFAULT_MAX_TTL_SECONDS,
  type ExpiryStatus,
  type LeaseExpiryParams,
  type LeaseExpiryEvaluation,
  type ValidLeaseExpiry,
  type InvalidLeaseExpiry,
  evaluateLeaseExpiry,
  isLeaseActive,
} from "./expiry.js";

// Keyset Parser, Policy Enforcement & Verification
export {
  KeysetParseError,
  KeysetValidationError,
  parseKeysetJson,
  getKey,
  hasKey,
  isKeyActive,
  canSignLease,
  canRevokeLease,
  canRevokeKey,
  canSignCheckpoint,
  isKeyRevoked,
  verifyLeaseWithKeyset,
  verifyRevocationWithKeyset,
  verifyKeyRevocationWithKeyset,
} from "./keyset.js";

// ULID Generation
export {
  generateUlid,
  MAX_ULID_TIME_MS,
  resetUlidMonotonicStateForTest,
} from "./ulid.js";
