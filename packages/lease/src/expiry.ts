/**
 * Default clock skew tolerance between control plane and workload SDK nodes (30 seconds).
 */
export const DEFAULT_SKEW_TOLERANCE_MS = 30_000;

/**
 * Hard upper limit on maximum allowed lease TTL (24 hours).
 */
export const DEFAULT_MAX_TTL_SECONDS = 86_400;

export type ExpiryStatus =
  | "VALID"
  | "EXPIRED_WALL_CLOCK"
  | "EXPIRED_MONOTONIC"
  | "FUTURE_DATED"
  | "INVALID_TIMESTAMP"
  | "TTL_EXCEEDED"
  | "INVALID_PARAMETERS";

export interface LeaseExpiryParams {
  /** ISO 8601 UTC timestamp when lease was issued */
  issuedAt: string;
  /** Duration of validity in seconds */
  ttlSeconds: number;
  /** Monotonic process time (in milliseconds, e.g. performance.now()) when lease was first verified */
  firstSeenMonoMs: number;
  /** Current wall clock time in milliseconds (defaults to Date.now()) */
  nowWallMs?: number;
  /** Current monotonic time in milliseconds (defaults to performance.now()) */
  nowMonoMs?: number;
  /** Permitted wall clock skew tolerance in milliseconds (defaults to 30,000ms) */
  skewToleranceMs?: number;
  /** Maximum allowable TTL in seconds (e.g. from keyset policy) */
  maxTtlSeconds?: number;
}

export type ValidLeaseExpiry = {
  /** Whether the lease is currently active and eligible for override evaluation */
  isValid: true;
  /** Granular categorization of lease validity status */
  status: "VALID";
  /** Absolute wall-clock expiry ceiling timestamp (ms) */
  wallExpiryMs: number;
  /** Process-relative monotonic expiry timestamp (ms) */
  monoExpiryMs: number;
  /** Remaining wall-clock validity duration in milliseconds */
  remainingWallMs: number;
  /** Remaining monotonic validity duration in milliseconds */
  remainingMonoMs: number;
  /** Effective remaining duration in ms: min(remainingWallMs, remainingMonoMs) */
  remainingEffectiveMs: number;
  reason?: undefined;
};

export type InvalidLeaseExpiry = {
  /** Whether the lease is currently active and eligible for override evaluation */
  isValid: false;
  /** Granular categorization of lease expiration / invalidity status */
  status: Exclude<ExpiryStatus, "VALID">;
  /** Absolute wall-clock expiry ceiling timestamp (ms) */
  wallExpiryMs: number;
  /** Process-relative monotonic expiry timestamp (ms) */
  monoExpiryMs: number;
  /** Remaining wall-clock validity duration in milliseconds */
  remainingWallMs: number;
  /** Remaining monotonic validity duration in milliseconds */
  remainingMonoMs: number;
  /** Effective remaining duration in ms: strictly 0 when invalid */
  remainingEffectiveMs: 0;
  /** Human-readable explanation of why the lease is expired or invalid */
  reason: string;
};

export type LeaseExpiryEvaluation = ValidLeaseExpiry | InvalidLeaseExpiry;

/**
 * Evaluates dual-clock expiry for emergency feature flag leases.
 *
 * Implements Invariant 3:
 * - Overrides enforce both monotonic relative time per process incarnation
 *   (first_seen_mono + ttl_seconds) and wall-clock absolute bounds
 *   (issued_at + ttl_seconds + SKEW_TOLERANCE).
 * - Overrides are honored for <= min(wall_expiry, mono_expiry).
 * - Zero leases may survive past their deadline, even under NTP clock manipulation.
 */
export function evaluateLeaseExpiry(
  params: LeaseExpiryParams,
): LeaseExpiryEvaluation {
  // Validate ttlSeconds: must be finite integer
  if (
    typeof params.ttlSeconds !== "number" ||
    !Number.isFinite(params.ttlSeconds) ||
    !Number.isInteger(params.ttlSeconds)
  ) {
    return {
      isValid: false,
      status: "INVALID_PARAMETERS",
      wallExpiryMs: 0,
      monoExpiryMs: 0,
      remainingWallMs: 0,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: `ttl_seconds (${params.ttlSeconds}) must be a finite integer`,
    };
  }

  const maxTtl = params.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
  if (
    typeof maxTtl !== "number" ||
    !Number.isFinite(maxTtl) ||
    !Number.isInteger(maxTtl) ||
    maxTtl <= 0
  ) {
    return {
      isValid: false,
      status: "INVALID_PARAMETERS",
      wallExpiryMs: 0,
      monoExpiryMs: 0,
      remainingWallMs: 0,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: `maxTtlSeconds (${maxTtl}) must be a positive finite integer`,
    };
  }

  // TTL range check (<= 0 or > maxTtl)
  if (params.ttlSeconds <= 0 || params.ttlSeconds > maxTtl) {
    return {
      isValid: false,
      status: "TTL_EXCEEDED",
      wallExpiryMs: 0,
      monoExpiryMs: 0,
      remainingWallMs: 0,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: `ttl_seconds (${params.ttlSeconds}) must be positive and <= ${maxTtl}`,
    };
  }

  if (
    typeof params.firstSeenMonoMs !== "number" ||
    !Number.isFinite(params.firstSeenMonoMs)
  ) {
    return {
      isValid: false,
      status: "INVALID_PARAMETERS",
      wallExpiryMs: 0,
      monoExpiryMs: 0,
      remainingWallMs: 0,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: "firstSeenMonoMs must be a finite number",
    };
  }

  const nowWall = params.nowWallMs ?? Date.now();
  if (typeof nowWall !== "number" || !Number.isFinite(nowWall)) {
    return {
      isValid: false,
      status: "INVALID_PARAMETERS",
      wallExpiryMs: 0,
      monoExpiryMs: 0,
      remainingWallMs: 0,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: "nowWallMs must be a finite number",
    };
  }

  const nowMono = params.nowMonoMs ?? performance.now();
  if (typeof nowMono !== "number" || !Number.isFinite(nowMono)) {
    return {
      isValid: false,
      status: "INVALID_PARAMETERS",
      wallExpiryMs: 0,
      monoExpiryMs: 0,
      remainingWallMs: 0,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: "nowMonoMs must be a finite number",
    };
  }

  const skewTolerance = params.skewToleranceMs ?? DEFAULT_SKEW_TOLERANCE_MS;
  if (
    typeof skewTolerance !== "number" ||
    !Number.isFinite(skewTolerance) ||
    skewTolerance < 0
  ) {
    return {
      isValid: false,
      status: "INVALID_PARAMETERS",
      wallExpiryMs: 0,
      monoExpiryMs: 0,
      remainingWallMs: 0,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: "skewToleranceMs must be a non-negative finite number",
    };
  }

  // Parse issued_at
  const issuedAtMs = Date.parse(params.issuedAt);
  if (Number.isNaN(issuedAtMs)) {
    return {
      isValid: false,
      status: "INVALID_TIMESTAMP",
      wallExpiryMs: 0,
      monoExpiryMs: 0,
      remainingWallMs: 0,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: `Unable to parse issued_at timestamp: "${params.issuedAt}"`,
    };
  }

  // Wall-Clock Expiration (Global Ceiling):
  // wall_expiry = issued_at + ttl_seconds + SKEW_TOLERANCE
  const wallExpiryMs = issuedAtMs + params.ttlSeconds * 1000 + skewTolerance;
  const remainingWallMs = Math.max(0, wallExpiryMs - nowWall);

  // Monotonic Expiration (Per Process Incarnation):
  // mono_expiry = first_seen_mono + ttl_seconds
  const monoExpiryMs = params.firstSeenMonoMs + params.ttlSeconds * 1000;
  const remainingMonoMs = Math.max(0, monoExpiryMs - nowMono);

  // Effective remaining duration: min(wall, mono)
  const remainingEffectiveMs = Math.min(remainingWallMs, remainingMonoMs);

  // Check monotonic expiry (prevents NTP clock rewind attacks)
  if (nowMono >= monoExpiryMs) {
    return {
      isValid: false,
      status: "EXPIRED_MONOTONIC",
      wallExpiryMs,
      monoExpiryMs,
      remainingWallMs,
      remainingMonoMs: 0,
      remainingEffectiveMs: 0,
      reason: `Monotonic TTL of ${params.ttlSeconds}s elapsed for this process incarnation`,
    };
  }

  // Check wall clock expiry (prevents process restart extension beyond global bound)
  if (nowWall >= wallExpiryMs) {
    return {
      isValid: false,
      status: "EXPIRED_WALL_CLOCK",
      wallExpiryMs,
      monoExpiryMs,
      remainingWallMs: 0,
      remainingMonoMs,
      remainingEffectiveMs: 0,
      reason: `Wall-clock lifetime exceeded (issued_at + TTL + ${skewTolerance}ms skew tolerance)`,
    };
  }

  // Anti-Future Skew Check: reject if issued_at > now_wall + SKEW_TOLERANCE
  if (issuedAtMs - nowWall > skewTolerance) {
    return {
      isValid: false,
      status: "FUTURE_DATED",
      wallExpiryMs,
      monoExpiryMs,
      remainingWallMs: 0,
      remainingMonoMs,
      remainingEffectiveMs: 0,
      reason: `Lease issued in future: issued_at is ${issuedAtMs - nowWall}ms ahead of wall clock (exceeds ${skewTolerance}ms tolerance)`,
    };
  }

  return {
    isValid: true,
    status: "VALID",
    wallExpiryMs,
    monoExpiryMs,
    remainingWallMs,
    remainingMonoMs,
    remainingEffectiveMs,
  };
}

/**
 * Convenience helper returning boolean activity state of a lease under dual-clock evaluation.
 */
export function isLeaseActive(params: LeaseExpiryParams): boolean {
  return evaluateLeaseExpiry(params).isValid;
}
