import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { OpenFeature, InMemoryProvider } from "@openfeature/server-sdk";
import {
  signLease,
  formatPublicKeyToBase64Url,
  generateUlid,
  evaluateLeaseExpiry,
  DEFAULT_SKEW_TOLERANCE_MS,
  type Keyset,
  type LeasePayload,
} from "@synapsestate/lease";
import { OverrideProvider, LeaseStore } from "@synapsestate/sdk";

/**
 * Chaos Drill 2: Clock-Skew Injection & Dual-Clock Expiry
 *
 * Charter Reference: AGENTS.md §2 Invariant 3 (Deterministic Dual-Clock Expiry), docs/ARCHITECTURE.md §10
 *
 * Invariant 3 Rules:
 * - Overrides enforce both monotonic relative time per process incarnation
 *   (first_seen_mono + ttl_seconds) and wall-clock absolute bounds
 *   (issued_at + ttl_seconds + SKEW_TOLERANCE).
 * - Overrides are honored for <= min(wall_expiry, mono_expiry).
 * - Zero leases may survive past their deadline, even under NTP clock manipulation.
 */
describe("Chaos Drill 2: Clock-Skew Injection & Dual-Clock Expiry (Invariant 3)", () => {
  let tmpDir: string;
  let keysetPath: string;
  let emergencyDir: string;

  const signerPair = crypto.generateKeyPairSync("ed25519");
  const signerPubB64 = formatPublicKeyToBase64Url(signerPair.publicKey);

  const pinnedKeyset: Keyset = {
    "sre-alice": {
      public_key: signerPubB64,
      role: "operator",
      roles: ["lease_signer"],
      status: "active",
      max_ttl_seconds: 3600,
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-drill2-clock-"));
    keysetPath = path.join(tmpDir, "keyset.json");
    emergencyDir = path.join(tmpDir, "emergency-leases");
    fs.writeFileSync(keysetPath, JSON.stringify(pinnedKeyset, null, 2), "utf8");
    fs.mkdirSync(emergencyDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    OpenFeature.clearProviders();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Scenario 2.1: Clock Rewind Attack — Prevents lease extension when NTP wall clock is rewound backwards", () => {
    const baseWallMs = Date.parse("2026-10-17T12:00:00.000Z");
    const baseMonoMs = 1000.0;
    const ttlSeconds = 60; // 1 minute TTL

    const issuedAt = new Date(baseWallMs).toISOString();

    // 1. Initial evaluation at T=0: valid
    const initialEval = evaluateLeaseExpiry({
      issuedAt,
      ttlSeconds,
      firstSeenMonoMs: baseMonoMs,
      nowWallMs: baseWallMs,
      nowMonoMs: baseMonoMs,
    });
    expect(initialEval.isValid).toBe(true);
    expect(initialEval.status).toBe("VALID");
    expect(initialEval.remainingEffectiveMs).toBe(60_000);

    // 2. Monotonic time elapses past TTL (baseMono + 60_001ms), BUT attacker rewinds wall clock by 2 hours (-7,200s)
    const rewoundWallMs = baseWallMs - 7_200_000; // 2 hours in the past!
    const elapsedMonoMs = baseMonoMs + 60_001; // monotonic time advanced normally

    const rewoundEval = evaluateLeaseExpiry({
      issuedAt,
      ttlSeconds,
      firstSeenMonoMs: baseMonoMs,
      nowWallMs: rewoundWallMs,
      nowMonoMs: elapsedMonoMs,
    });

    // Invariant 3 strictly asserts: Monotonic expiry caught it!
    expect(rewoundEval.isValid).toBe(false);
    expect(rewoundEval.status).toBe("EXPIRED_MONOTONIC");
    expect(rewoundEval.remainingEffectiveMs).toBe(0);
    expect(rewoundEval.reason).toContain(
      "Monotonic TTL of 60s elapsed for this process incarnation",
    );
  });

  it("Scenario 2.2: Clock Jump Forward — Evicts lease immediately when system time jumps past wall-clock ceiling", () => {
    const baseWallMs = Date.parse("2026-10-17T12:00:00.000Z");
    const baseMonoMs = 1000.0;
    const ttlSeconds = 300; // 5 minutes TTL
    const issuedAt = new Date(baseWallMs).toISOString();

    // System wall clock jumps forward by 10 minutes (+600s), e.g. VM resume or sudden NTP sync
    const jumpedWallMs = baseWallMs + 600_000;
    // Even if monotonic clock only advanced by 50 seconds (e.g. host sleep/freeze)
    const shortMonoMs = baseMonoMs + 50_000;

    const forwardEval = evaluateLeaseExpiry({
      issuedAt,
      ttlSeconds,
      firstSeenMonoMs: baseMonoMs,
      nowWallMs: jumpedWallMs,
      nowMonoMs: shortMonoMs,
      skewToleranceMs: 60_000,
    });

    // Invariant 3: Wall clock ceiling catches the jump and evicts immediately
    expect(forwardEval.isValid).toBe(false);
    expect(forwardEval.status).toBe("EXPIRED_WALL_CLOCK");
    expect(forwardEval.remainingEffectiveMs).toBe(0);
    expect(forwardEval.reason).toContain("Wall-clock lifetime exceeded");
  });

  it("Scenario 2.3: Anti-Future Skew Defense — Rejects leases issued in the future beyond SKEW_TOLERANCE", () => {
    const nowWallMs = Date.parse("2026-10-17T12:00:00.000Z");
    const nowMonoMs = 5000.0;
    const skewToleranceMs = DEFAULT_SKEW_TOLERANCE_MS; // 30,000ms (30s default per ARCH §5.4)

    // Future-skewed lease: issued 120 seconds ahead of server/workload clock
    const futureIssuedAt = new Date(nowWallMs + 120_000).toISOString();

    const futureEval = evaluateLeaseExpiry({
      issuedAt: futureIssuedAt,
      ttlSeconds: 300,
      firstSeenMonoMs: nowMonoMs,
      nowWallMs,
      nowMonoMs,
      skewToleranceMs,
    });

    expect(futureEval.isValid).toBe(false);
    expect(futureEval.status).toBe("FUTURE_DATED");
    expect(futureEval.reason).toContain("Lease issued in future");

    // Tolerated skew: issued 15 seconds ahead (within 30s tolerance) -> ACCEPTED
    const toleratedIssuedAt = new Date(nowWallMs + 15_000).toISOString();
    const toleratedEval = evaluateLeaseExpiry({
      issuedAt: toleratedIssuedAt,
      ttlSeconds: 300,
      firstSeenMonoMs: nowMonoMs,
      nowWallMs,
      nowMonoMs,
      skewToleranceMs,
    });

    expect(toleratedEval.isValid).toBe(true);
    expect(toleratedEval.status).toBe("VALID");
  });

  it("Scenario 2.4: Cold Process Restart — Rejects stale leases on cold boot without granting fresh monotonic window", () => {
    const store = new LeaseStore({ keyset: pinnedKeyset });

    // Lease was issued 40 minutes ago with 30-minute TTL (1800s)
    const staleIssuedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const stalePayload: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "stale-on-boot-flag",
      value: true,
      reason: "DRILL-2: Stale lease from prior incarnation",
      issued_at: staleIssuedAt,
      ttl_seconds: 1800,
      kid: "sre-alice",
      nonce: "stale-nonce-1",
    };
    const signedEnvelope = signLease(stalePayload, signerPair.privateKey);

    // In a freshly booted store (firstSeenMonoMs would be initialized now),
    // addLease must reject the lease because wall-clock ceiling has expired.
    const accepted = store.addLease(signedEnvelope);
    expect(accepted).toBe(false);
    expect(store.getActiveLease("stale-on-boot-flag")).toBeUndefined();
    expect(store.getMetrics().leasesRejectedCount).toBe(1);
  });

  it("Scenario 2.5: Monotonic Non-Extension — Subsequent addLease preserves original firstSeenMonoMs", async () => {
    const store = new LeaseStore({ keyset: pinnedKeyset });
    const leaseId = generateUlid();
    const issuedAt = new Date().toISOString();

    const payload: LeasePayload = {
      v: 1,
      lease_id: leaseId,
      env: "prod",
      flag_key: "mon-preservation-flag",
      value: true,
      reason: "DRILL-2: Test monotonic timestamp preservation",
      issued_at: issuedAt,
      ttl_seconds: 300,
      kid: "sre-alice",
      nonce: "nonce-preservation",
    };
    const envelope = signLease(payload, signerPair.privateKey);

    // First ingestion records firstSeenMonoMs
    expect(store.addLease(envelope)).toBe(true);
    const active1 = store.getActiveLease("mon-preservation-flag");
    expect(active1).toBeDefined();
    const originalFirstSeenMono = active1!.firstSeenMonoMs;

    // Re-ingest the exact same lease through store.addLease after a delay
    await new Promise((r) => setTimeout(r, 20));
    expect(store.addLease(envelope)).toBe(true);
    const active2 = store.getActiveLease("mon-preservation-flag");
    expect(active2).toBeDefined();

    // firstSeenMonoMs must NOT be reset or extended
    expect(active2!.firstSeenMonoMs).toBe(originalFirstSeenMono);
  });

  it("Scenario 2.6: In-Process OverrideProvider Integration Under Injected Clock Skew", async () => {
    const delegate = new InMemoryProvider({
      "incident-toggle": {
        disabled: false,
        variants: { active: true, disabled: false },
        defaultVariant: "disabled",
      },
    });

    const provider = new OverrideProvider(delegate, {
      keysetPath,
      emergencyDir,
      enableKeysetWatcher: true,
      enableEmergencyScanner: false,
    });

    await OpenFeature.setProviderAndWait("drill2-domain", provider);
    const client = OpenFeature.getClient("drill2-domain");

    // Add active lease with 2-second TTL
    const leasePayload: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "incident-toggle",
      value: true,
      reason: "DRILL-2: In-process clock skew simulation",
      issued_at: new Date().toISOString(),
      ttl_seconds: 2,
      kid: "sre-alice",
      nonce: "nonce-drill2-provider",
    };
    const envelope = signLease(leasePayload, signerPair.privateKey);
    const store = provider.getLeaseStore();
    expect(store.addLease(envelope, pinnedKeyset)).toBe(true);

    // Initial evaluation: Override active
    const activeEval = await client.getBooleanDetails("incident-toggle", false);
    expect(activeEval.value).toBe(true);
    expect(activeEval.reason).toBe("OVERRIDE");

    // Injected Clock Chaos: Mock Date.now to jump forward by 1 hour (NTP forward step)
    const originalDateNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(
      () => originalDateNow() + 3_600_000,
    );

    // Immediate next evaluation detects wall-clock expiration and evicts
    const skewedEval = await client.getBooleanDetails("incident-toggle", false);
    expect(skewedEval.value).toBe(false);
    expect(skewedEval.reason).toBe("STATIC");

    // Verify lease is completely evicted from in-memory store
    expect(store.getActiveLeasesCount()).toBe(0);

    await provider.onClose();
  });

  it("Scenario 2.7: Exhaustive Skew Space Sweep — Effective duration is strictly <= min(wall_expiry, mono_expiry)", () => {
    const testCases = [
      { skewSeconds: -86400, label: "-24h wall rollback" },
      { skewSeconds: -3600, label: "-1h wall rollback" },
      { skewSeconds: -300, label: "-5m wall rollback" },
      { skewSeconds: 0, label: "0s synchronized" },
      { skewSeconds: 30, label: "+30s tolerated NTP ahead" },
      { skewSeconds: 300, label: "+5m wall jump forward" },
      { skewSeconds: 3600, label: "+1h wall jump forward" },
      { skewSeconds: 86400, label: "+24h wall jump forward" },
    ];

    const baseWallMs = Date.parse("2026-10-17T12:00:00.000Z");
    const baseMonoMs = 10_000.0;
    const ttlSeconds = 600; // 10 minutes

    for (const { skewSeconds } of testCases) {
      const issuedAt = new Date(baseWallMs).toISOString();
      const nowWallMs = baseWallMs + skewSeconds * 1000;
      const nowMonoMs = baseMonoMs; // monotonic not yet elapsed

      const evaluation = evaluateLeaseExpiry({
        issuedAt,
        ttlSeconds,
        firstSeenMonoMs: baseMonoMs,
        nowWallMs,
        nowMonoMs,
      });

      if (evaluation.isValid) {
        // When valid, remaining effective time MUST NOT exceed min(wall, mono)
        expect(evaluation.remainingEffectiveMs).toBeLessThanOrEqual(
          Math.min(evaluation.remainingWallMs, evaluation.remainingMonoMs),
        );
        // And MUST NOT exceed ttl + skewTolerance
        expect(evaluation.remainingEffectiveMs).toBeLessThanOrEqual(
          (ttlSeconds + DEFAULT_SKEW_TOLERANCE_MS / 1000) * 1000,
        );
      } else {
        expect(evaluation.remainingEffectiveMs).toBe(0);
      }
    }
  });
});
