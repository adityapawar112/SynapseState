import type {
  LeaseEnvelope,
  RevocationEnvelope,
  KeyRevocationEnvelope,
  Keyset,
} from "@synapsestate/lease";

/**
 * Clock parameters supplied for testing lease dual-clock expiry evaluation.
 */
export interface VectorClockParams {
  /** Current wall clock time in milliseconds */
  nowWallMs: number;
  /** Current monotonic process time in milliseconds */
  nowMonoMs: number;
  /** Monotonic process time when lease was first verified */
  firstSeenMonoMs: number;
  /** Allowed clock skew tolerance in milliseconds (default 30,000ms) */
  skewToleranceMs?: number;
  /** Max TTL in seconds */
  maxTtlSeconds?: number;
}

/**
 * Valid Keyset Test Vector model.
 */
export interface ValidKeysetVector {
  id: string;
  description: string;
  type: "keyset";
  valid: true;
  keyset: Keyset;
  expectedKeyCount: number;
}

/**
 * Invalid Keyset Test Vector model.
 */
export interface InvalidKeysetVector {
  id: string;
  description: string;
  type: "keyset";
  valid: false;
  raw: string;
  expectedError: "KeysetParseError" | "KeysetValidationError";
}

/**
 * Valid Lease Test Vector model.
 */
export interface ValidLeaseVector {
  id: string;
  description: string;
  type: "lease";
  valid: true;
  envelope: LeaseEnvelope;
  expected: {
    flagKey: string;
    resolvedValue: unknown;
    reason: "OVERRIDE";
    kid: string;
  };
  clockParams?: VectorClockParams;
}

/**
 * Categorization of expected failure modes for invalid lease test vectors.
 */
export type LeaseFailureCategory =
  | "SCHEMA_VALIDATION_FAILED"
  | "SIGNATURE_VERIFICATION_FAILED"
  | "DOMAIN_SEPARATION_MISMATCH"
  | "EXPIRED_WALL_CLOCK"
  | "EXPIRED_MONOTONIC"
  | "FUTURE_DATED"
  | "UNKNOWN_KEY_ID";

/**
 * Invalid Lease Test Vector model.
 */
export interface InvalidLeaseVector {
  id: string;
  description: string;
  type: "lease";
  valid: false;
  envelope: unknown;
  expectedFailure: LeaseFailureCategory;
  clockParams?: VectorClockParams;
}

/**
 * Valid Revocation Test Vector model.
 */
export interface ValidRevocationVector {
  id: string;
  description: string;
  type: "revocation";
  valid: true;
  envelope: RevocationEnvelope;
  expected: {
    leaseId: string;
    kid: string;
  };
}

/**
 * Categorization of expected failure modes for invalid revocation test vectors.
 */
export type RevocationFailureCategory =
  | "SCHEMA_VALIDATION_FAILED"
  | "SIGNATURE_VERIFICATION_FAILED"
  | "DOMAIN_SEPARATION_MISMATCH"
  | "UNKNOWN_KEY_ID";

/**
 * Invalid Revocation Test Vector model.
 */
export interface InvalidRevocationVector {
  id: string;
  description: string;
  type: "revocation";
  valid: false;
  envelope: unknown;
  expectedFailure: RevocationFailureCategory;
}

/**
 * Valid Key Revocation Test Vector model.
 */
export interface ValidKeyRevocationVector {
  id: string;
  description: string;
  type: "key_revocation";
  valid: true;
  envelope: KeyRevocationEnvelope;
  expected: {
    kid: string;
    revokedKid: string;
  };
}

/**
 * Categorization of expected failure modes for invalid key revocation test vectors.
 */
export type KeyRevocationFailureCategory =
  | "SCHEMA_VALIDATION_FAILED"
  | "SIGNATURE_VERIFICATION_FAILED"
  | "DOMAIN_SEPARATION_MISMATCH"
  | "UNAUTHORIZED_SIGNER"
  | "UNKNOWN_KEY_ID";

/**
 * Invalid Key Revocation Test Vector model.
 */
export interface InvalidKeyRevocationVector {
  id: string;
  description: string;
  type: "key_revocation";
  valid: false;
  envelope: unknown;
  expectedFailure: KeyRevocationFailureCategory;
}

/**
 * Discriminated union of valid vector models.
 */
export type ValidVector =
  | ValidKeysetVector
  | ValidLeaseVector
  | ValidRevocationVector
  | ValidKeyRevocationVector;

/**
 * Discriminated union of invalid vector models.
 */
export type InvalidVector =
  | InvalidKeysetVector
  | InvalidLeaseVector
  | InvalidRevocationVector
  | InvalidKeyRevocationVector;

/**
 * Unified discriminated union for any conformance test vector.
 */
export type ConformanceVector = ValidVector | InvalidVector;

/**
 * Individual test execution result from the vector runner.
 */
export interface VectorResult {
  vectorId: string;
  type: "keyset" | "lease" | "revocation" | "key_revocation";
  passed: boolean;
  message?: string;
  actualStatus?: string;
  expectedStatus?: string;
}

/**
 * Summary report returned after executing conformance vector suites.
 */
export interface ConformanceSuiteReport {
  total: number;
  passed: number;
  failed: number;
  results: VectorResult[];
}
