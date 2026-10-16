import { createHash } from "node:crypto";
import { canonicalizeJson } from "./canonicalize.js";

/**
 * The 64-zero SHA-256 hash used as the prev_hash for the genesis block (seq = 1).
 */
export const GENESIS_PREV_HASH = "0".repeat(64);

/**
 * Data payload of an audit event prior to hash seal.
 */
export interface AuditEventData {
  seq: number | string;
  ts: string | Date;
  actor: string;
  event_type: string;
  payload: unknown;
}

/**
 * Complete, cryptographically sealed audit event record.
 */
export interface AuditEventRecord {
  seq: number | string;
  ts: string | Date;
  actor: string;
  event_type: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

/**
 * Result of audit ledger chain verification.
 */
export interface ChainVerificationResult {
  valid: boolean;
  error?: string;
  failedSeq?: number;
}

/**
 * Normalizes an audit event into a deterministic JSON string according to RFC 8785 (JCS).
 * Ensures timestamps are formatted as ISO 8601 strings, sequence is a number, and keys are sorted deterministically.
 */
export function canonicalizeAuditEvent(event: AuditEventData): string {
  let normalizedTs: string;
  if (event.ts instanceof Date) {
    normalizedTs = event.ts.toISOString();
  } else {
    const d = new Date(event.ts);
    normalizedTs = Number.isNaN(d.getTime()) ? String(event.ts) : d.toISOString();
  }

  const canonicalObject = {
    actor: event.actor,
    event_type: event.event_type,
    payload: event.payload,
    seq: Number(event.seq),
    ts: normalizedTs,
  };

  return canonicalizeJson(canonicalObject);
}

/**
 * Computes the SHA-256 hash for an event chained to a previous hash:
 * hash_n = SHA-256(prev_hash || RFC8785Canonical(event_n))
 */
export function computeEventHash(prevHash: string, event: AuditEventData): string {
  const canonicalBytes = canonicalizeAuditEvent(event);
  return createHash("sha256")
    .update(prevHash + canonicalBytes)
    .digest("hex");
}

/**
 * Verifies that a single audit event record matches its expected prev_hash
 * and its hash matches the RFC 8785 canonical SHA-256 computation.
 */
export function verifySingleEvent(
  event: AuditEventRecord,
  expectedPrevHash: string,
): boolean {
  if (event.prev_hash !== expectedPrevHash) {
    return false;
  }
  const computed = computeEventHash(event.prev_hash, event);
  return computed === event.hash;
}

/**
 * Options for audit chain verification.
 */
export interface VerifyAuditChainOptions {
  /**
   * If true (default when initialPrevHash is GENESIS_PREV_HASH), requires events[0].seq === 1.
   * Set to false only when deliberately verifying a contiguous sub-range of the ledger.
   */
  requireGenesisStart?: boolean;
}

/**
 * Verifies an ordered sequence of audit event records from genesis (or a given starting prev_hash).
 * Checks contiguous sequence numbers, unbroken prev_hash links, and SHA-256 integrity.
 */
export function verifyAuditChain(
  events: AuditEventRecord[],
  initialPrevHash: string = GENESIS_PREV_HASH,
  opts: VerifyAuditChainOptions = {},
): ChainVerificationResult {
  if (events.length === 0) {
    return { valid: true };
  }

  // Invariant 7 (C1): Ledger must start at genesis seq 1 to prevent prefix-truncation attacks
  if (initialPrevHash === GENESIS_PREV_HASH && opts.requireGenesisStart !== false) {
    const firstSeq = Number(events[0]!.seq);
    if (firstSeq !== 1) {
      return {
        valid: false,
        error: `Ledger does not start at genesis: first seq is ${firstSeq}, expected 1 (possible prefix truncation)`,
        failedSeq: firstSeq,
      };
    }
  }

  let expectedPrevHash = initialPrevHash;
  let expectedSeq = Number(events[0]!.seq);

  // If the chain starts at seq 1, verify that initialPrevHash is GENESIS_PREV_HASH
  if (expectedSeq === 1 && expectedPrevHash !== GENESIS_PREV_HASH) {
    return {
      valid: false,
      error: `Genesis prev_hash must be 64 zeros, got: "${expectedPrevHash}"`,
      failedSeq: 1,
    };
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const currentSeq = Number(event.seq);

    if (currentSeq !== expectedSeq) {
      return {
        valid: false,
        error: `Sequence discontinuity at index ${i}: expected seq ${expectedSeq}, got ${currentSeq}`,
        failedSeq: expectedSeq,
      };
    }

    if (event.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        error:
          currentSeq === 1 && expectedPrevHash === GENESIS_PREV_HASH
            ? `Genesis prev_hash must be 64 zeros, got: "${event.prev_hash}"`
            : `Broken prev_hash link at seq ${currentSeq}: expected "${expectedPrevHash}", got "${event.prev_hash}"`,
        failedSeq: currentSeq,
      };
    }

    const computed = computeEventHash(event.prev_hash, event);
    if (computed !== event.hash) {
      return {
        valid: false,
        error: `Hash mismatch at seq ${currentSeq}: computed "${computed}", recorded "${event.hash}"`,
        failedSeq: currentSeq,
      };
    }

    expectedPrevHash = event.hash;
    expectedSeq += 1;
  }

  return { valid: true };
}
