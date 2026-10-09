import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  evaluateLeaseExpiry,
  isLeaseActive,
  DEFAULT_SKEW_TOLERANCE_MS,
  type LeaseExpiryParams,
} from "./expiry.js";

describe("Dual-Clock Expiry Validator", () => {
  const baseIssuedAt = "2026-10-06T02:00:00.000Z";
  const baseIssuedAtMs = Date.parse(baseIssuedAt); // 1791252000000 approx
  const ttlSeconds = 600; // 10 minutes = 600,000 ms

  it("judges a newly verified lease within TTL as VALID", () => {
    const firstSeenMonoMs = 10_000;
    const nowMonoMs = 15_000; // 5 seconds elapsed
    const nowWallMs = baseIssuedAtMs + 5_000;

    const result = evaluateLeaseExpiry({
      issuedAt: baseIssuedAt,
      ttlSeconds,
      firstSeenMonoMs,
      nowWallMs,
      nowMonoMs,
    });

    expect(result.isValid).toBe(true);
    expect(result.status).toBe("VALID");
    expect(result.remainingWallMs).toBeGreaterThan(0);
    expect(result.remainingMonoMs).toBe(595_000); // 600_000 - 5_000
    expect(
      isLeaseActive({
        issuedAt: baseIssuedAt,
        ttlSeconds,
        firstSeenMonoMs,
        nowWallMs,
        nowMonoMs,
      }),
    ).toBe(true);
  });

  describe("Monotonic Expiry Enforcement", () => {
    it("expires lease once monotonic duration exceeds TTL, even if wall-clock was rewound (Clock Rewind Attack)", () => {
      const firstSeenMonoMs = 10_000;
      const nowMonoMs = firstSeenMonoMs + ttlSeconds * 1000 + 1; // 600,001 ms elapsed
      // Attacker rewinds wall clock by 1 hour (NTP clock skew attack)
      const nowWallMs = baseIssuedAtMs - 3600_000;

      const result = evaluateLeaseExpiry({
        issuedAt: baseIssuedAt,
        ttlSeconds,
        firstSeenMonoMs,
        nowWallMs,
        nowMonoMs,
      });

      expect(result.isValid).toBe(false);
      expect(result.status).toBe("EXPIRED_MONOTONIC");
      expect(result.remainingMonoMs).toBe(0);
      expect(result.remainingEffectiveMs).toBe(0);
      expect(
        isLeaseActive({
          issuedAt: baseIssuedAt,
          ttlSeconds,
          firstSeenMonoMs,
          nowWallMs,
          nowMonoMs,
        }),
      ).toBe(false);
    });
  });

  describe("Wall-Clock Ceiling Enforcement", () => {
    it("expires lease once wall-clock exceeds issued_at + TTL + skew tolerance", () => {
      const firstSeenMonoMs = 100_000;
      const nowMonoMs = 105_000; // only 5s monotonic elapsed (e.g. process just restarted)
      // Wall clock has passed issued_at + ttl_seconds * 1000 + SKEW_TOLERANCE_MS
      const nowWallMs =
        baseIssuedAtMs + ttlSeconds * 1000 + DEFAULT_SKEW_TOLERANCE_MS + 100;

      const result = evaluateLeaseExpiry({
        issuedAt: baseIssuedAt,
        ttlSeconds,
        firstSeenMonoMs,
        nowWallMs,
        nowMonoMs,
      });

      expect(result.isValid).toBe(false);
      expect(result.status).toBe("EXPIRED_WALL_CLOCK");
      expect(result.remainingWallMs).toBe(0);
      expect(result.remainingEffectiveMs).toBe(0);
      expect(
        isLeaseActive({
          issuedAt: baseIssuedAt,
          ttlSeconds,
          firstSeenMonoMs,
          nowWallMs,
          nowMonoMs,
        }),
      ).toBe(false);
    });
  });

  describe("Anti-Future Skew Check", () => {
    it("rejects future-dated leases when issued_at is beyond skew tolerance", () => {
      const nowWallMs = baseIssuedAtMs;
      // issued_at is 60 seconds into the future (default skew tolerance is 30s)
      const futureIssuedAt = new Date(nowWallMs + 60_000).toISOString();

      const result = evaluateLeaseExpiry({
        issuedAt: futureIssuedAt,
        ttlSeconds,
        firstSeenMonoMs: 10_000,
        nowWallMs,
        nowMonoMs: 10_000,
      });

      expect(result.isValid).toBe(false);
      expect(result.status).toBe("FUTURE_DATED");
    });

    it("accepts leases with small forward clock skew within tolerance (e.g. 15s)", () => {
      const nowWallMs = baseIssuedAtMs;
      // issued_at is 15 seconds in future (within 30s tolerance)
      const nearFutureIssuedAt = new Date(nowWallMs + 15_000).toISOString();

      const result = evaluateLeaseExpiry({
        issuedAt: nearFutureIssuedAt,
        ttlSeconds,
        firstSeenMonoMs: 10_000,
        nowWallMs,
        nowMonoMs: 10_000,
      });

      expect(result.isValid).toBe(true);
      expect(result.status).toBe("VALID");
    });
  });

  describe("Max TTL & Parameter Validations", () => {
    it("rejects leases exceeding maxTtlSeconds policy", () => {
      const result = evaluateLeaseExpiry({
        issuedAt: baseIssuedAt,
        ttlSeconds: 7200,
        firstSeenMonoMs: 10_000,
        nowWallMs: baseIssuedAtMs,
        nowMonoMs: 10_000,
        maxTtlSeconds: 3600, // Policy limit 1h
      });

      expect(result.isValid).toBe(false);
      expect(result.status).toBe("TTL_EXCEEDED");
    });

    it("rejects negative or zero TTL", () => {
      const resultZero = evaluateLeaseExpiry({
        issuedAt: baseIssuedAt,
        ttlSeconds: 0,
        firstSeenMonoMs: 10_000,
        nowWallMs: baseIssuedAtMs,
        nowMonoMs: 10_000,
      });
      expect(resultZero.isValid).toBe(false);
      expect(resultZero.status).toBe("TTL_EXCEEDED");

      const resultNeg = evaluateLeaseExpiry({
        issuedAt: baseIssuedAt,
        ttlSeconds: -10,
        firstSeenMonoMs: 10_000,
        nowWallMs: baseIssuedAtMs,
        nowMonoMs: 10_000,
      });
      expect(resultNeg.isValid).toBe(false);
      expect(resultNeg.status).toBe("TTL_EXCEEDED");
    });

    it("rejects unparseable timestamps", () => {
      const result = evaluateLeaseExpiry({
        issuedAt: "invalid-timestamp",
        ttlSeconds: 300,
        firstSeenMonoMs: 10_000,
        nowWallMs: baseIssuedAtMs,
        nowMonoMs: 10_000,
      });
      expect(result.isValid).toBe(false);
      expect(result.status).toBe("INVALID_TIMESTAMP");
    });
  });

  describe("Effective Expiry Invariant: <= min(wall_expiry, mono_expiry)", () => {
    it("ensures remaining effective time is always <= min(wall, mono)", () => {
      const firstSeenMonoMs = 10_000;
      const nowMonoMs = 10_000 + 100_000; // 100s mono elapsed
      const nowWallMs = baseIssuedAtMs + 50_000; // 50s wall elapsed

      const result = evaluateLeaseExpiry({
        issuedAt: baseIssuedAt,
        ttlSeconds: 300,
        firstSeenMonoMs,
        nowWallMs,
        nowMonoMs,
      });

      expect(result.remainingEffectiveMs).toBeLessThanOrEqual(
        result.remainingWallMs,
      );
      expect(result.remainingEffectiveMs).toBeLessThanOrEqual(
        result.remainingMonoMs,
      );
      expect(result.remainingEffectiveMs).toBe(
        Math.min(result.remainingWallMs, result.remainingMonoMs),
      );
    });
  });

  describe("Property-based testing (fast-check)", () => {
    it("monotonic clock advancement never re-activates an expired lease", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 3600 }), // ttlSeconds
          fc.integer({ min: 0, max: 100000 }), // firstSeenMonoMs
          fc.integer({ min: 0, max: 100000 }), // deltaMonoMs
          (ttl, firstSeen, delta) => {
            const monoExpiryMs = firstSeen + ttl * 1000;
            const pastExpiryMono = monoExpiryMs + 1 + delta;

            const params: LeaseExpiryParams = {
              issuedAt: baseIssuedAt,
              ttlSeconds: ttl,
              firstSeenMonoMs: firstSeen,
              nowWallMs: baseIssuedAtMs, // keep wall clock fresh
              nowMonoMs: pastExpiryMono,
            };

            const result = evaluateLeaseExpiry(params);
            return (
              result.isValid === false && result.status === "EXPIRED_MONOTONIC"
            );
          },
        ),
        { numRuns: 50 },
      );
    });

    it("wall clock advancement past wall ceiling never leaves a lease active", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 3600 }), // ttlSeconds
          fc.integer({ min: 1, max: 100000 }), // deltaWallMs past wall expiry
          (ttl, delta) => {
            const wallExpiryMs =
              baseIssuedAtMs + ttl * 1000 + DEFAULT_SKEW_TOLERANCE_MS;
            const pastWallMs = wallExpiryMs + delta;

            const params: LeaseExpiryParams = {
              issuedAt: baseIssuedAt,
              ttlSeconds: ttl,
              firstSeenMonoMs: 10_000,
              nowWallMs: pastWallMs,
              nowMonoMs: 10_000, // keep mono fresh
            };

            const result = evaluateLeaseExpiry(params);
            return (
              result.isValid === false && result.status === "EXPIRED_WALL_CLOCK"
            );
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
