import type { LeaseEnvelope } from "@synapsestate/lease";
import type {
  ActiveLeaseView,
  AuditChainVerificationResult,
  AuditLedgerRecord,
  FlagQuiescenceResult,
  RolePermission,
  UserRole,
  VariantCount,
  VariantDistribution,
} from "@/lib/types";

export * from "@/lib/types";

/**
 * Calculates display metrics, remaining duration, and expiry flags for a lease envelope.
 * Threshold for `isNearExpiry` is 300 seconds (5 minutes).
 */
export function calculateLeaseExpiryView(
  envelope: LeaseEnvelope,
  referenceTime: Date = new Date()
): ActiveLeaseView {
  const { payload, sig } = envelope;
  const issuedAtMs = new Date(payload.issued_at).getTime();
  const ttlMs = payload.ttl_seconds * 1000;
  const expiresAtMs = issuedAtMs + ttlMs;
  const nowMs = referenceTime.getTime();

  const remainingMs = expiresAtMs - nowMs;
  const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const isExpired = remainingSeconds <= 0;
  const isNearExpiry = !isExpired && remainingSeconds <= 300;

  return {
    leaseId: payload.lease_id,
    flagKey: payload.flag_key,
    env: payload.env,
    value: payload.value,
    reason: payload.reason,
    kid: payload.kid,
    status: isExpired ? "EXPIRED" : "ACTIVE",
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ttlSeconds: payload.ttl_seconds,
    remainingSeconds,
    isNearExpiry,
    sig,
  };
}

/**
 * Computes variant evaluation distribution percentages rounded to two decimal places.
 */
export function calculateVariantDistribution(
  counts: VariantCount[]
): VariantDistribution[] {
  const total = counts.reduce((acc, c) => acc + c.count, 0);
  if (total === 0) {
    return counts.map((c) => ({
      variant: c.variant,
      count: c.count,
      percentage: 0,
    }));
  }

  return counts.map((c) => ({
    variant: c.variant,
    count: c.count,
    percentage: Math.round((c.count / total) * 10000) / 100,
  }));
}

/**
 * Evaluates whether a flag is quiescent (>99% evaluations on one variant) and qualifies as a purge candidate.
 * Requires minimum 100 evaluations to qualify as a candidate to prevent false positives on cold paths.
 */
export function evaluateFlagQuiescence(
  variants: VariantDistribution[],
  totalEvaluations: number,
  quiescenceThresholdPct: number = 99
): FlagQuiescenceResult {
  if (variants.length === 0 || totalEvaluations === 0) {
    return {
      isQuiescent: false,
      isCandidateForPurge: false,
    };
  }

  const dominant = variants.find((v) => v.percentage >= quiescenceThresholdPct);
  if (!dominant) {
    return {
      isQuiescent: false,
      isCandidateForPurge: false,
    };
  }

  const isCandidateForPurge = totalEvaluations >= 100;

  return {
    isQuiescent: true,
    winningVariant: dominant.variant,
    isCandidateForPurge,
  };
}

/**
 * Validates unbroken sequence order and SHA-256 hash chaining of audit ledger records.
 */
export function verifyAuditLedgerChain(
  records: AuditLedgerRecord[]
): AuditChainVerificationResult {
  if (records.length <= 1) {
    return { valid: true };
  }

  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const curr = records[i];

    // Check strict sequence monotonicity (1, 2, 3...)
    if (curr.seq !== prev.seq + 1) {
      return {
        valid: false,
        brokenAtSeq: curr.seq,
      };
    }

    // Check cryptographic hash linking
    if (curr.prevHash !== prev.hash) {
      return {
        valid: false,
        brokenAtSeq: curr.seq,
      };
    }
  }

  return { valid: true };
}

/**
 * Role hierarchy and permission check.
 * - viewer: read
 * - operator: read, revoke, promote
 * - admin: read, revoke, promote, admin
 */
const ROLE_PERMISSIONS: Record<UserRole, Set<RolePermission>> = {
  viewer: new Set(["read"]),
  operator: new Set(["read", "revoke", "promote"]),
  admin: new Set(["read", "revoke", "promote", "admin"]),
};

export function hasRolePermission(role: UserRole, permission: RolePermission): boolean {
  const allowed = ROLE_PERMISSIONS[role];
  return allowed ? allowed.has(permission) : false;
}
