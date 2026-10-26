import { describe, it, expect } from "vitest";
import {
  calculateLeaseExpiryView,
  calculateVariantDistribution,
  evaluateFlagQuiescence,
  verifyAuditLedgerChain,
  hasRolePermission,
  type ActiveLeaseView,
  type AuditLedgerRecord,
} from "@/lib/domain";
import type { LeaseEnvelope } from "@synapsestate/lease";

describe("Dashboard Domain Utilities", () => {
  describe("calculateLeaseExpiryView", () => {
    const sampleLeaseEnvelope: LeaseEnvelope = {
      payload: {
        v: 1,
        lease_id: "01J9X57YTRPQ8A7F4E12345678",
        flag_key: "killswitch-checkout",
        env: "prod",
        value: true,
        reason: "Incident #4492: Gateway latency spike",
        issued_at: "2026-10-18T00:00:00.000Z",
        ttl_seconds: 1800, // 30 mins
        kid: "ops-ed25519-key-1",
        nonce: "test-nonce-12345",
      },
      sig: "sample-valid-signature",
    };

    it("computes remaining seconds, expiry timestamp, and nearExpiry status correctly", () => {
      // 10 minutes into the 30 minute lease
      const now = new Date("2026-10-18T00:10:00.000Z");
      const view: ActiveLeaseView = calculateLeaseExpiryView(
        sampleLeaseEnvelope,
        now,
      );

      expect(view.leaseId).toBe("01J9X57YTRPQ8A7F4E12345678");
      expect(view.flagKey).toBe("killswitch-checkout");
      expect(view.env).toBe("prod");
      expect(view.value).toBe(true);
      expect(view.reason).toBe("Incident #4492: Gateway latency spike");
      expect(view.kid).toBe("ops-ed25519-key-1");
      expect(view.ttlSeconds).toBe(1800);
      expect(view.expiresAt).toBe("2026-10-18T00:30:00.000Z");
      expect(view.remainingSeconds).toBe(1200); // 20 minutes left
      expect(view.isNearExpiry).toBe(false);
      expect(view.status).toBe("ACTIVE");
    });

    it("marks lease as near expiry when <= 300 seconds remain", () => {
      // 27 minutes into the 30 minute lease (3 minutes left)
      const now = new Date("2026-10-18T00:27:00.000Z");
      const view = calculateLeaseExpiryView(sampleLeaseEnvelope, now);

      expect(view.remainingSeconds).toBe(180);
      expect(view.isNearExpiry).toBe(true);
      expect(view.status).toBe("ACTIVE");
    });

    it("marks lease as EXPIRED when remaining seconds <= 0", () => {
      // 35 minutes after issue (past 30 min ttl)
      const now = new Date("2026-10-18T00:35:00.000Z");
      const view = calculateLeaseExpiryView(sampleLeaseEnvelope, now);

      expect(view.remainingSeconds).toBe(0);
      expect(view.isNearExpiry).toBe(false);
      expect(view.status).toBe("EXPIRED");
    });
  });

  describe("calculateVariantDistribution", () => {
    it("computes variant percentages rounded accurately", () => {
      const counts = [
        { variant: "on", count: 800 },
        { variant: "off", count: 200 },
      ];

      const distribution = calculateVariantDistribution(counts);

      expect(distribution).toEqual([
        { variant: "on", count: 800, percentage: 80 },
        { variant: "off", count: 200, percentage: 20 },
      ]);
    });

    it("handles zero total evaluations gracefully", () => {
      const counts = [
        { variant: "control", count: 0 },
        { variant: "treatment", count: 0 },
      ];

      const distribution = calculateVariantDistribution(counts);

      expect(distribution).toEqual([
        { variant: "control", count: 0, percentage: 0 },
        { variant: "treatment", count: 0, percentage: 0 },
      ]);
    });
  });

  describe("evaluateFlagQuiescence", () => {
    it("identifies a quiescent flag when >99% evaluations are on a single winning variant", () => {
      const variants = [
        { variant: "v2-new-cart", count: 995, percentage: 99.5 },
        { variant: "v1-legacy", count: 5, percentage: 0.5 },
      ];

      const quiescence = evaluateFlagQuiescence(variants, 1000);

      expect(quiescence.isQuiescent).toBe(true);
      expect(quiescence.winningVariant).toBe("v2-new-cart");
      expect(quiescence.isCandidateForPurge).toBe(true);
    });

    it("rejects quiescence when evaluations are distributed across multiple variants", () => {
      const variants = [
        { variant: "v2-new-cart", count: 600, percentage: 60 },
        { variant: "v1-legacy", count: 400, percentage: 40 },
      ];

      const quiescence = evaluateFlagQuiescence(variants, 1000);

      expect(quiescence.isQuiescent).toBe(false);
      expect(quiescence.winningVariant).toBeUndefined();
      expect(quiescence.isCandidateForPurge).toBe(false);
    });

    it("rejects candidate status if total evaluation volume is insufficient (< 100)", () => {
      const variants = [{ variant: "v2", count: 50, percentage: 100 }];

      const quiescence = evaluateFlagQuiescence(variants, 50);

      expect(quiescence.isQuiescent).toBe(true);
      expect(quiescence.winningVariant).toBe("v2");
      expect(quiescence.isCandidateForPurge).toBe(false); // Insufficient data volume
    });
  });

  describe("verifyAuditLedgerChain", () => {
    it("verifies sequential hash chain continuity correctly", () => {
      const records: AuditLedgerRecord[] = [
        {
          seq: 1,
          ts: "2026-10-18T00:00:00.000Z",
          actor: "ops-key-1",
          eventType: "LEASE_CREATED",
          payload: { lease_id: "01J9X" },
          prevHash:
            "0000000000000000000000000000000000000000000000000000000000000000",
          hash: "hash-1",
        },
        {
          seq: 2,
          ts: "2026-10-18T00:01:00.000Z",
          actor: "ops-key-1",
          eventType: "LEASE_REVOKED",
          payload: { lease_id: "01J9X" },
          prevHash: "hash-1",
          hash: "hash-2",
        },
        {
          seq: 3,
          ts: "2026-10-18T00:02:00.000Z",
          actor: "system",
          eventType: "CHECKPOINT_CREATED",
          payload: { checkpoint_seq: 2 },
          prevHash: "hash-2",
          hash: "hash-3",
        },
      ];

      const result = verifyAuditLedgerChain(records);
      expect(result.valid).toBe(true);
      expect(result.brokenAtSeq).toBeUndefined();
    });

    it("detects a broken hash chain when prevHash does not match previous hash", () => {
      const records: AuditLedgerRecord[] = [
        {
          seq: 1,
          ts: "2026-10-18T00:00:00.000Z",
          actor: "ops-key-1",
          eventType: "LEASE_CREATED",
          payload: {},
          prevHash:
            "0000000000000000000000000000000000000000000000000000000000000000",
          hash: "hash-1",
        },
        {
          seq: 2,
          ts: "2026-10-18T00:01:00.000Z",
          actor: "attacker",
          eventType: "TAMPERED_EVENT",
          payload: {},
          prevHash: "corrupted-hash", // Mismatch!
          hash: "hash-2",
        },
      ];

      const result = verifyAuditLedgerChain(records);
      expect(result.valid).toBe(false);
      expect(result.brokenAtSeq).toBe(2);
    });

    it("detects broken sequence order if seq is not strictly sequential", () => {
      const records: AuditLedgerRecord[] = [
        {
          seq: 1,
          ts: "2026-10-18T00:00:00.000Z",
          actor: "ops",
          eventType: "A",
          payload: {},
          prevHash: "genesis",
          hash: "hash-1",
        },
        {
          seq: 3, // Skipped seq 2!
          ts: "2026-10-18T00:01:00.000Z",
          actor: "ops",
          eventType: "B",
          payload: {},
          prevHash: "hash-1",
          hash: "hash-3",
        },
      ];

      const result = verifyAuditLedgerChain(records);
      expect(result.valid).toBe(false);
      expect(result.brokenAtSeq).toBe(3);
    });
  });

  describe("hasRolePermission", () => {
    it("enforces RBAC hierarchy correctly: admin > operator > viewer", () => {
      // Viewer permissions
      expect(hasRolePermission("viewer", "read")).toBe(true);
      expect(hasRolePermission("viewer", "revoke")).toBe(false);
      expect(hasRolePermission("viewer", "promote")).toBe(false);
      expect(hasRolePermission("viewer", "admin")).toBe(false);

      // Operator permissions
      expect(hasRolePermission("operator", "read")).toBe(true);
      expect(hasRolePermission("operator", "revoke")).toBe(true);
      expect(hasRolePermission("operator", "promote")).toBe(true);
      expect(hasRolePermission("operator", "admin")).toBe(false);

      // Admin permissions
      expect(hasRolePermission("admin", "read")).toBe(true);
      expect(hasRolePermission("admin", "revoke")).toBe(true);
      expect(hasRolePermission("admin", "promote")).toBe(true);
      expect(hasRolePermission("admin", "admin")).toBe(true);
    });
  });
});
