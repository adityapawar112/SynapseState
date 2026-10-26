import {
  DEFAULT_SKEW_TOLERANCE_MS,
  DEFAULT_MAX_TTL_SECONDS,
  evaluateLeaseExpiry,
  verifyLeaseWithKeyset,
  verifyRevocationWithKeyset,
  verifyKeyRevocationWithKeyset,
  isKeyRevoked,
  type Keyset,
  type LeaseEnvelope,
  type RevocationEnvelope,
  type KeyRevocationEnvelope,
  type KeyRevocationPayload,
} from "@synapsestate/lease";
import type { ActiveLease, LeaseStoreMetrics } from "./types.js";
import { type SynapseSdkMetrics, safeInvokeMetricCallback } from "./metrics.js";

export const DEFAULT_MAX_TRACKED_MONOTONIC_LEASES = 2000;

export interface LeaseStoreOptions {
  keyset?: Keyset;
  skewToleranceMs?: number;
  maxTtlSeconds?: number;
  metrics?: SynapseSdkMetrics;
}

/**
 * Thread-safe, in-memory store holding cryptographically verified emergency leases.
 *
 * Enforces:
 * - Invariant 1: Fail-safe isolation (never throws uncaught errors).
 * - Invariant 2: Pinned Keyset Trust Root verification and eviction on keyset update / revocation.
 * - Invariant 3: Dual-Clock Expiry validation (wall-clock ceiling and process-relative monotonic limit).
 * - Deterministic conflict resolution (issued_at DESC, ULID lease_id DESC).
 */
export class LeaseStore {
  private readonly leases = new Map<string, ActiveLease>();
  private readonly revocations = new Map<string, RevocationEnvelope>();
  private readonly keyRevocations = new Map<string, KeyRevocationPayload>();
  private readonly firstSeenMonoByLeaseId = new Map<string, number>();

  private keyset: Keyset;
  private readonly skewToleranceMs: number;
  private readonly maxTtlSeconds: number;
  private readonly sdkMetrics?: SynapseSdkMetrics;

  private readonly metrics: LeaseStoreMetrics = {
    activeLeasesCount: 0,
    leasesAddedCount: 0,
    leasesEvictedExpiredCount: 0,
    leasesEvictedRevokedCount: 0,
    leasesRejectedCount: 0,
    internalErrorsCount: 0,
  };

  constructor(options?: LeaseStoreOptions) {
    this.keyset = options?.keyset ?? Object.create(null);
    this.skewToleranceMs =
      options?.skewToleranceMs ?? DEFAULT_SKEW_TOLERANCE_MS;
    this.maxTtlSeconds = options?.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
    this.sdkMetrics = options?.metrics;
  }

  private notifyActiveOverrides(): void {
    safeInvokeMetricCallback(
      this.sdkMetrics?.onActiveOverrides,
      this.leases.size,
    );
  }

  /**
   * Returns current active Keyset in memory.
   */
  getKeyset(): Keyset {
    return this.keyset;
  }

  /**
   * Returns active key revocations iterator.
   */
  getKeyRevocations(): Iterable<KeyRevocationPayload> {
    return this.keyRevocations.values();
  }

  /**
   * Returns a copy of operational metrics.
   */
  getMetrics(): LeaseStoreMetrics {
    return { ...this.metrics, activeLeasesCount: this.leases.size };
  }

  /**
   * Returns count of currently active leases.
   */
  getActiveLeasesCount(): number {
    return this.leases.size;
  }

  /**
   * Adds and verifies a new lease envelope.
   *
   * Verifies against pinned keyset, enforces role authorization, max TTL,
   * checks key/lease revocations, evaluates dual-clock expiry, and resolves conflicts.
   */
  addLease(envelope: LeaseEnvelope, keyset?: Keyset): boolean {
    try {
      const activeKeyset = keyset ?? this.keyset;

      // 1. Verify envelope against pinned keyset policy
      if (!verifyLeaseWithKeyset(envelope, activeKeyset)) {
        this.metrics.leasesRejectedCount++;
        return false;
      }

      // 2. Reject if signing key is revoked
      if (isKeyRevoked(envelope.payload.kid, this.keyRevocations.values())) {
        this.metrics.leasesRejectedCount++;
        return false;
      }

      // 3. Reject if this specific lease has already been revoked
      if (this.revocations.has(envelope.payload.lease_id)) {
        this.metrics.leasesRejectedCount++;
        return false;
      }

      // 4. Invariant 3 Monotonic Clock Anchoring:
      // If lease already seen in this process incarnation, preserve firstSeenMono
      // to prevent monotonic TTL extension attacks. Consult both the monotonic
      // tracking map and any active in-memory lease to survive tracking map pruning.
      const nowMono = performance.now();
      const existingLeaseForFlag = this.leases.get(envelope.payload.flag_key);
      const firstSeenMonoMs =
        this.firstSeenMonoByLeaseId.get(envelope.payload.lease_id) ??
        (existingLeaseForFlag &&
        existingLeaseForFlag.leaseId === envelope.payload.lease_id
          ? existingLeaseForFlag.firstSeenMonoMs
          : nowMono);

      const nowWall = Date.now();
      const expiryEval = evaluateLeaseExpiry({
        issuedAt: envelope.payload.issued_at,
        ttlSeconds: envelope.payload.ttl_seconds,
        firstSeenMonoMs,
        nowWallMs: nowWall,
        nowMonoMs: nowMono,
        skewToleranceMs: this.skewToleranceMs,
        maxTtlSeconds: this.maxTtlSeconds,
      });

      if (!expiryEval.isValid) {
        this.metrics.leasesRejectedCount++;
        return false;
      }

      // 5. Conflict Resolution (ARCHITECTURE.md:374-376):
      // When multiple leases exist for the same flag_key, winner is:
      // issued_at DESC, breaking ties with lease_id (ULID) DESC.
      const existing = existingLeaseForFlag;
      if (existing) {
        const newIssuedMs = Date.parse(envelope.payload.issued_at);
        const existingIssuedMs = Date.parse(existing.issuedAt);

        if (newIssuedMs < existingIssuedMs) {
          // Reject older lease arriving after a newer lease
          this.metrics.leasesRejectedCount++;
          return false;
        }

        if (newIssuedMs === existingIssuedMs) {
          if (envelope.payload.lease_id < existing.leaseId) {
            // Reject lower ULID on identical timestamp
            this.metrics.leasesRejectedCount++;
            return false;
          }
        }
      }

      // Calculate effective remaining wall-clock date for metadata
      const effectiveRemainingMs = expiryEval.remainingEffectiveMs;
      const effectiveExpiry = new Date(
        nowWall + Math.max(0, effectiveRemainingMs),
      );

      const activeLease: ActiveLease = {
        leaseId: envelope.payload.lease_id,
        flagKey: envelope.payload.flag_key,
        env: envelope.payload.env,
        value: envelope.payload.value,
        kid: envelope.payload.kid,
        issuedAt: envelope.payload.issued_at,
        ttlSeconds: envelope.payload.ttl_seconds,
        firstSeenMonoMs,
        effectiveExpiry,
        envelope,
      };

      // Bounded tracking: FIFO evict oldest non-active monotonic anchor if capacity reached
      if (
        this.firstSeenMonoByLeaseId.size >= DEFAULT_MAX_TRACKED_MONOTONIC_LEASES
      ) {
        const activeLeaseIds = new Set(
          Array.from(this.leases.values()).map((l) => l.leaseId),
        );
        let keyToEvict: string | undefined;
        for (const k of this.firstSeenMonoByLeaseId.keys()) {
          if (!activeLeaseIds.has(k)) {
            keyToEvict = k;
            break;
          }
        }
        this.firstSeenMonoByLeaseId.delete(
          keyToEvict ?? this.firstSeenMonoByLeaseId.keys().next().value!,
        );
      }

      this.firstSeenMonoByLeaseId.set(
        envelope.payload.lease_id,
        firstSeenMonoMs,
      );
      this.leases.set(envelope.payload.flag_key, activeLease);
      this.metrics.leasesAddedCount++;
      this.metrics.activeLeasesCount = this.leases.size;
      this.notifyActiveOverrides();
      return true;
    } catch {
      this.metrics.internalErrorsCount++;
      return false;
    }
  }

  /**
   * Retrieves an active lease for a given flag key.
   * Enforces dual-clock expiry on read: if expired, evicts immediately and returns undefined.
   */
  getActiveLease(flagKey: string): ActiveLease | undefined {
    try {
      const lease = this.leases.get(flagKey);
      if (!lease) {
        return undefined;
      }

      // Enforce Invariant 3: Dual-clock expiry check
      const expiryEval = evaluateLeaseExpiry({
        issuedAt: lease.issuedAt,
        ttlSeconds: lease.ttlSeconds,
        firstSeenMonoMs: lease.firstSeenMonoMs,
        nowWallMs: Date.now(),
        nowMonoMs: performance.now(),
        skewToleranceMs: this.skewToleranceMs,
        maxTtlSeconds: this.maxTtlSeconds,
      });

      if (!expiryEval.isValid) {
        this.leases.delete(flagKey);
        this.metrics.leasesEvictedExpiredCount++;
        this.metrics.activeLeasesCount = this.leases.size;
        this.notifyActiveOverrides();
        return undefined;
      }

      return lease;
    } catch {
      this.metrics.internalErrorsCount++;
      return undefined;
    }
  }

  /**
   * Applies a cryptographically verified lease revocation and evicts any active matching lease.
   */
  applyRevocation(envelope: RevocationEnvelope, keyset?: Keyset): boolean {
    try {
      const activeKeyset = keyset ?? this.keyset;

      if (!verifyRevocationWithKeyset(envelope, activeKeyset)) {
        return false;
      }

      if (isKeyRevoked(envelope.payload.kid, this.keyRevocations.values())) {
        return false;
      }

      this.revocations.set(envelope.payload.lease_id, envelope);
      this.firstSeenMonoByLeaseId.delete(envelope.payload.lease_id);

      // Evict any active lease matching the revoked lease_id
      for (const [flagKey, lease] of this.leases.entries()) {
        if (lease.leaseId === envelope.payload.lease_id) {
          this.leases.delete(flagKey);
          this.metrics.leasesEvictedRevokedCount++;
        }
      }

      this.metrics.activeLeasesCount = this.leases.size;
      this.notifyActiveOverrides();
      return true;
    } catch {
      this.metrics.internalErrorsCount++;
      return false;
    }
  }

  /**
   * Applies a signed key revocation, purges all active leases signed by that key,
   * and blocks future leases from that key.
   */
  applyKeyRevocation(
    envelope: KeyRevocationEnvelope,
    keyset?: Keyset,
  ): boolean {
    try {
      const activeKeyset = keyset ?? this.keyset;

      if (!verifyKeyRevocationWithKeyset(envelope, activeKeyset)) {
        return false;
      }

      if (
        envelope.payload.revoked_by_kid &&
        isKeyRevoked(
          envelope.payload.revoked_by_kid,
          this.keyRevocations.values(),
        )
      ) {
        return false;
      }

      const revokedKid = envelope.payload.kid;
      this.keyRevocations.set(revokedKid, envelope.payload);

      // Evict all active leases signed by this revoked kid
      for (const [flagKey, lease] of this.leases.entries()) {
        if (lease.kid === revokedKid) {
          this.leases.delete(flagKey);
          this.metrics.leasesEvictedRevokedCount++;
        }
      }

      this.metrics.activeLeasesCount = this.leases.size;
      this.notifyActiveOverrides();
      return true;
    } catch {
      this.metrics.internalErrorsCount++;
      return false;
    }
  }

  /**
   * Scans and evicts all expired leases from memory.
   * Returns the count of leases evicted.
   */
  evictExpiredLeases(): number {
    let evicted = 0;
    const nowWall = Date.now();
    const nowMono = performance.now();

    for (const [flagKey, lease] of this.leases.entries()) {
      const expiryEval = evaluateLeaseExpiry({
        issuedAt: lease.issuedAt,
        ttlSeconds: lease.ttlSeconds,
        firstSeenMonoMs: lease.firstSeenMonoMs,
        nowWallMs: nowWall,
        nowMonoMs: nowMono,
        skewToleranceMs: this.skewToleranceMs,
        maxTtlSeconds: this.maxTtlSeconds,
      });

      if (!expiryEval.isValid) {
        this.leases.delete(flagKey);
        evicted++;
      }
    }

    if (evicted > 0) {
      this.metrics.leasesEvictedExpiredCount += evicted;
      this.metrics.activeLeasesCount = this.leases.size;
      this.notifyActiveOverrides();
    }

    return evicted;
  }

  /**
   * Handles keyset reload: re-validates all active in-memory leases against newKeyset.
   * Any lease signed by a missing, non-active, or unpermitted key is immediately evicted.
   * If newKeyset is empty ({}), immediately purges all active leases.
   */
  handleKeysetUpdate(newKeyset: Keyset): void {
    this.keyset = newKeyset;

    for (const [flagKey, lease] of this.leases.entries()) {
      const isValid =
        verifyLeaseWithKeyset(lease.envelope, newKeyset) &&
        !isKeyRevoked(lease.kid, this.keyRevocations.values());

      if (!isValid) {
        this.leases.delete(flagKey);
        this.firstSeenMonoByLeaseId.delete(lease.leaseId);
        this.metrics.leasesEvictedRevokedCount++;
      }
    }

    this.metrics.activeLeasesCount = this.leases.size;
    this.notifyActiveOverrides();
  }

  /**
   * Revokes an active lease by lease_id and updates active override metrics.
   */
  revokeLease(leaseId: string): boolean {
    let evicted = false;
    for (const [flagKey, lease] of this.leases.entries()) {
      if (lease.leaseId === leaseId) {
        this.leases.delete(flagKey);
        this.firstSeenMonoByLeaseId.delete(leaseId);
        this.metrics.leasesEvictedRevokedCount++;
        evicted = true;
      }
    }
    if (evicted) {
      this.metrics.activeLeasesCount = this.leases.size;
      this.notifyActiveOverrides();
    }
    return evicted;
  }
}
