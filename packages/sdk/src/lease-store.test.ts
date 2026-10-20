import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  signLease,
  signRevocation,
  signKeyRevocation,
  formatPublicKeyToBase64Url,
  type Keyset,
  type LeasePayload,
  type RevocationPayload,
  type KeyRevocationPayload,
} from "@synapsestate/lease";
import { LeaseStore } from "./lease-store.js";

describe("LeaseStore", () => {
  // Test Ed25519 Keypairs
  const alicePair = crypto.generateKeyPairSync("ed25519");
  const bobPair = crypto.generateKeyPairSync("ed25519");
  const adminPair = crypto.generateKeyPairSync("ed25519");

  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);
  const bobPubB64 = formatPublicKeyToBase64Url(bobPair.publicKey);
  const adminPubB64 = formatPublicKeyToBase64Url(adminPair.publicKey);

  let trustedKeyset: Keyset;
  let store: LeaseStore;

  beforeEach(() => {
    trustedKeyset = {
      "sre-alice": {
        public_key: alicePubB64,
        role: "operator",
        roles: ["lease_signer"],
        status: "active",
        max_ttl_seconds: 3600,
      },
      "sre-bob": {
        public_key: bobPubB64,
        role: "operator",
        roles: ["lease_signer"],
        status: "active",
        max_ttl_seconds: 3600,
      },
      "admin-carol": {
        public_key: adminPubB64,
        role: "admin",
        roles: ["lease_signer", "key_revoker"],
        status: "active",
        max_ttl_seconds: 86400,
      },
    };
    store = new LeaseStore({ keyset: trustedKeyset });
  });

  const createLeasePayload = (
    overrides?: Partial<LeasePayload>,
  ): LeasePayload => ({
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E12345678",
    env: "prod",
    flag_key: "killswitch-cart",
    value: true,
    reason: "INC-999: Emergency killswitch",
    issued_at: new Date().toISOString(),
    ttl_seconds: 300,
    kid: "sre-alice",
    nonce: "YWJjZGVmZ2hpams",
    ...overrides,
  });

  it("adds and retrieves a valid signed lease", () => {
    const payload = createLeasePayload();
    const envelope = signLease(payload, alicePair.privateKey);

    const added = store.addLease(envelope, trustedKeyset);
    expect(added).toBe(true);

    const active = store.getActiveLease("killswitch-cart");
    expect(active).toBeDefined();
    expect(active?.leaseId).toBe(payload.lease_id);
    expect(active?.flagKey).toBe("killswitch-cart");
    expect(active?.value).toBe(true);
    expect(active?.kid).toBe("sre-alice");
    expect(active?.effectiveExpiry).toBeInstanceOf(Date);
    expect(active?.effectiveExpiry.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects leases with invalid signatures or unauthorized keys", () => {
    const payload = createLeasePayload();
    // Signed with bob's key but claims alice's kid
    const tamperedSigEnvelope = signLease(payload, bobPair.privateKey);

    const added = store.addLease(tamperedSigEnvelope, trustedKeyset);
    expect(added).toBe(false);
    expect(store.getActiveLease("killswitch-cart")).toBeUndefined();
    expect(store.getMetrics().leasesRejectedCount).toBe(1);
  });

  it("evicts expired leases on getActiveLease (Invariant 3: Dual-Clock Expiry)", () => {
    // Lease issued in past whose TTL has expired
    const pastIssuedAt = new Date(Date.now() - 100_000).toISOString();
    const payload = createLeasePayload({
      issued_at: pastIssuedAt,
      ttl_seconds: 60, // expired 40s ago (exceeding 30s skew tolerance)
    });
    const envelope = signLease(payload, alicePair.privateKey);

    // addLease should reject already expired lease
    const added = store.addLease(envelope, trustedKeyset);
    expect(added).toBe(false);
    expect(store.getActiveLease("killswitch-cart")).toBeUndefined();
  });

  it("handles duplicate and superseding leases deterministically (issued_at DESC, lease_id DESC)", () => {
    const olderTime = new Date(Date.now() - 5000).toISOString();
    const newerTime = new Date(Date.now()).toISOString();

    const oldPayload = createLeasePayload({
      lease_id: "01J9X57YTRPQ8A7F4E12345671",
      issued_at: olderTime,
      value: false,
    });
    const newPayload = createLeasePayload({
      lease_id: "01J9X57YTRPQ8A7F4E12345679",
      issued_at: newerTime,
      value: true,
    });

    const oldEnv = signLease(oldPayload, alicePair.privateKey);
    const newEnv = signLease(newPayload, alicePair.privateKey);

    // Add old first, then new -> new should supersede old
    expect(store.addLease(oldEnv, trustedKeyset)).toBe(true);
    expect(store.getActiveLease("killswitch-cart")?.value).toBe(false);

    expect(store.addLease(newEnv, trustedKeyset)).toBe(true);
    expect(store.getActiveLease("killswitch-cart")?.value).toBe(true);

    // If an older lease arrives late, it should NOT overwrite the newer lease
    expect(store.addLease(oldEnv, trustedKeyset)).toBe(false);
    expect(store.getActiveLease("killswitch-cart")?.value).toBe(true);
  });

  it("applies signed lease revocation and immediately evicts active lease", () => {
    const payload = createLeasePayload();
    const leaseEnv = signLease(payload, alicePair.privateKey);
    store.addLease(leaseEnv, trustedKeyset);
    expect(store.getActiveLease("killswitch-cart")).toBeDefined();

    const revPayload: RevocationPayload = {
      v: 1,
      lease_id: payload.lease_id,
      revoked_at: new Date().toISOString(),
      kid: "sre-alice",
      reason: "Incident resolved",
    };
    const revEnv = signRevocation(revPayload, alicePair.privateKey);

    const revoked = store.applyRevocation(revEnv, trustedKeyset);
    expect(revoked).toBe(true);
    expect(store.getActiveLease("killswitch-cart")).toBeUndefined();
    expect(store.getMetrics().leasesEvictedRevokedCount).toBe(1);

    // Subsequent attempts to re-add the revoked lease must fail
    expect(store.addLease(leaseEnv, trustedKeyset)).toBe(false);
  });

  it("applies signed key revocation and purges all leases signed by that key", () => {
    const alicePayload1 = createLeasePayload({
      flag_key: "flag-a",
      lease_id: "01J9X57YTRPQ8A7F4E12345671",
      kid: "sre-alice",
    });
    const alicePayload2 = createLeasePayload({
      flag_key: "flag-b",
      lease_id: "01J9X57YTRPQ8A7F4E12345672",
      kid: "sre-alice",
    });
    const bobPayload = createLeasePayload({
      flag_key: "flag-c",
      lease_id: "01J9X57YTRPQ8A7F4E12345673",
      kid: "sre-bob",
    });

    store.addLease(
      signLease(alicePayload1, alicePair.privateKey),
      trustedKeyset,
    );
    store.addLease(
      signLease(alicePayload2, alicePair.privateKey),
      trustedKeyset,
    );
    store.addLease(signLease(bobPayload, bobPair.privateKey), trustedKeyset);

    expect(store.getActiveLease("flag-a")).toBeDefined();
    expect(store.getActiveLease("flag-b")).toBeDefined();
    expect(store.getActiveLease("flag-c")).toBeDefined();

    // Revoke Alice's key signed by Carol (who has key_revoker role)
    const keyRevPayload: KeyRevocationPayload = {
      v: 1,
      kid: "sre-alice",
      revoked_at: new Date().toISOString(),
      revoked_by_kid: "admin-carol",
      reason: "Compromised laptop",
    };
    const keyRevEnv = signKeyRevocation(keyRevPayload, adminPair.privateKey);

    const applied = store.applyKeyRevocation(keyRevEnv, trustedKeyset);
    expect(applied).toBe(true);

    // All Alice's leases must be purged immediately
    expect(store.getActiveLease("flag-a")).toBeUndefined();
    expect(store.getActiveLease("flag-b")).toBeUndefined();
    // Bob's lease remains active
    expect(store.getActiveLease("flag-c")).toBeDefined();

    // Future leases signed by Alice must be rejected
    const newAlicePayload = createLeasePayload({
      flag_key: "flag-d",
      lease_id: "01J9X57YTRPQ8A7F4E12345674",
      kid: "sre-alice",
    });
    expect(
      store.addLease(
        signLease(newAlicePayload, alicePair.privateKey),
        trustedKeyset,
      ),
    ).toBe(false);
  });

  it("purges invalid leases upon keyset update and purges all on empty keyset {}", () => {
    const alicePayload = createLeasePayload({
      flag_key: "flag-alice",
      kid: "sre-alice",
      lease_id: "01J9X57YTRPQ8A7F4E12345671",
    });
    const bobPayload = createLeasePayload({
      flag_key: "flag-bob",
      kid: "sre-bob",
      lease_id: "01J9X57YTRPQ8A7F4E12345672",
    });

    store.addLease(
      signLease(alicePayload, alicePair.privateKey),
      trustedKeyset,
    );
    store.addLease(signLease(bobPayload, bobPair.privateKey), trustedKeyset);

    expect(store.getActiveLease("flag-alice")).toBeDefined();
    expect(store.getActiveLease("flag-bob")).toBeDefined();

    // Keyset update removes bob
    const updatedKeyset: Keyset = {
      "sre-alice": trustedKeyset["sre-alice"]!,
    };
    store.handleKeysetUpdate(updatedKeyset);

    expect(store.getActiveLease("flag-alice")).toBeDefined();
    expect(store.getActiveLease("flag-bob")).toBeUndefined();

    // Authoritative empty keyset {} purges ALL active leases immediately
    store.handleKeysetUpdate({});
    expect(store.getActiveLease("flag-alice")).toBeUndefined();
    expect(store.getActiveLeasesCount()).toBe(0);
  });

  it("evicts lease when monotonic TTL expires even if wall clock is manipulated", () => {
    const payload = createLeasePayload({
      ttl_seconds: 1, // 1 second TTL
    });
    const env = signLease(payload, alicePair.privateKey);
    expect(store.addLease(env, trustedKeyset)).toBe(true);

    // Active right away
    expect(store.getActiveLease("killswitch-cart")).toBeDefined();

    // Fast-forward or sleep slightly over 1s (e.g. 1100ms)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(store.getActiveLease("killswitch-cart")).toBeUndefined();
        expect(store.getMetrics().leasesEvictedExpiredCount).toBe(1);
        resolve();
      }, 1100);
    });
  });

  it("tracks metrics across operations accurately", () => {
    const payload = createLeasePayload();
    const env = signLease(payload, alicePair.privateKey);
    store.addLease(env, trustedKeyset);

    const metrics = store.getMetrics();
    expect(metrics.leasesAddedCount).toBe(1);
    expect(metrics.activeLeasesCount).toBe(1);
    expect(metrics.leasesRejectedCount).toBe(0);
    expect(metrics.leasesEvictedExpiredCount).toBe(0);
    expect(metrics.leasesEvictedRevokedCount).toBe(0);
  });

  it("preserves firstSeenMonoMs from active lease if tracking map entry was evicted", () => {
    const payload = createLeasePayload();
    const env = signLease(payload, alicePair.privateKey);
    expect(store.addLease(env, trustedKeyset)).toBe(true);
    const originalMono = store.getActiveLease("killswitch-cart")!.firstSeenMonoMs;

    // Simulate eviction of the lease_id from the monotonic tracking map
    (
      store as unknown as { firstSeenMonoByLeaseId: Map<string, number> }
    ).firstSeenMonoByLeaseId.delete(payload.lease_id);

    // Re-ingest the exact same lease
    expect(store.addLease(env, trustedKeyset)).toBe(true);
    expect(store.getActiveLease("killswitch-cart")!.firstSeenMonoMs).toBe(
      originalMono,
    );
  });

  it("resolves timestamp ties using lease_id (ULID) DESC", () => {
    const fixedTime = new Date().toISOString();
    const payloadMid = createLeasePayload({
      lease_id: "01J9X57YTRPQ8A7F4E12345675",
      issued_at: fixedTime,
      value: "mid",
    });
    const payloadLower = createLeasePayload({
      lease_id: "01J9X57YTRPQ8A7F4E12345671",
      issued_at: fixedTime,
      value: "lower",
    });
    const payloadHigher = createLeasePayload({
      lease_id: "01J9X57YTRPQ8A7F4E12345679",
      issued_at: fixedTime,
      value: "higher",
    });

    const envMid = signLease(payloadMid, alicePair.privateKey);
    const envLower = signLease(payloadLower, alicePair.privateKey);
    const envHigher = signLease(payloadHigher, alicePair.privateKey);

    expect(store.addLease(envMid, trustedKeyset)).toBe(true);
    expect(store.getActiveLease("killswitch-cart")?.value).toBe("mid");

    // Lower ULID on identical timestamp must be rejected
    const prevRejected = store.getMetrics().leasesRejectedCount;
    expect(store.addLease(envLower, trustedKeyset)).toBe(false);
    expect(store.getActiveLease("killswitch-cart")?.value).toBe("mid");
    expect(store.getMetrics().leasesRejectedCount).toBe(prevRejected + 1);

    // Higher ULID on identical timestamp must supersede
    expect(store.addLease(envHigher, trustedKeyset)).toBe(true);
    expect(store.getActiveLease("killswitch-cart")?.value).toBe("higher");
  });

  it("evicts expired leases explicitly via evictExpiredLeases()", () => {
    // 0 expired leases returns 0 and does not change metrics
    expect(store.evictExpiredLeases()).toBe(0);

    const pastIssuedAt = new Date(Date.now() - 50_000).toISOString();
    const payload = createLeasePayload({
      issued_at: pastIssuedAt,
      ttl_seconds: 60, // 10s left initially with 30s skew tolerance
    });
    const env = signLease(payload, alicePair.privateKey);
    expect(store.addLease(env, trustedKeyset)).toBe(true);
    expect(store.getActiveLeasesCount()).toBe(1);

    // Manually force lease expiry by manipulating issuedAt
    const rawLease = (store as unknown as { leases: Map<string, { issuedAt: string }> }).leases.get("killswitch-cart")!;
    rawLease.issuedAt = new Date(Date.now() - 500_000).toISOString();

    const prevEvicted = store.getMetrics().leasesEvictedExpiredCount;
    const evictedCount = store.evictExpiredLeases();
    expect(evictedCount).toBe(1);
    expect(store.getActiveLeasesCount()).toBe(0);
    expect(store.getMetrics().leasesEvictedExpiredCount).toBe(prevEvicted + 1);
  });

  it("revokes active lease by leaseId directly via revokeLease", () => {
    const payload = createLeasePayload();
    const env = signLease(payload, alicePair.privateKey);
    store.addLease(env, trustedKeyset);
    expect(store.getActiveLeasesCount()).toBe(1);

    expect(store.revokeLease("non-existent-id")).toBe(false);
    expect(store.getActiveLeasesCount()).toBe(1);

    const prevEvictedRevoked = store.getMetrics().leasesEvictedRevokedCount;
    expect(store.revokeLease(payload.lease_id)).toBe(true);
    expect(store.getActiveLeasesCount()).toBe(0);
    expect(store.getMetrics().leasesEvictedRevokedCount).toBe(prevEvictedRevoked + 1);
    expect(store.getActiveLease("killswitch-cart")).toBeUndefined();
  });

  it("invokes onActiveOverrides callback on lifecycle events", () => {
    const onActiveOverrides = vi.fn();
    const trackedStore = new LeaseStore({
      keyset: trustedKeyset,
      metrics: { onActiveOverrides },
    });

    const payload = createLeasePayload();
    const env = signLease(payload, alicePair.privateKey);
    trackedStore.addLease(env, trustedKeyset);
    expect(onActiveOverrides).toHaveBeenCalledWith(1);

    trackedStore.revokeLease(payload.lease_id);
    expect(onActiveOverrides).toHaveBeenCalledWith(0);
  });

  it("evicts oldest non-active monotonic anchor when tracking capacity is reached", () => {
    const map = (store as unknown as { firstSeenMonoByLeaseId: Map<string, number> }).firstSeenMonoByLeaseId;
    // Fill up to 2000 entries
    for (let i = 0; i < 2000; i++) {
      map.set(`dummy-id-${i}`, i);
    }
    expect(map.size).toBe(2000);

    const payload = createLeasePayload({ lease_id: "01J9X57YTRPQ8A7F4ENEW00001" });
    const env = signLease(payload, alicePair.privateKey);
    expect(store.addLease(env, trustedKeyset)).toBe(true);

    // Oldest inactive key dummy-id-0 was evicted, size stays 2000
    expect(map.has("dummy-id-0")).toBe(false);
    expect(map.has("01J9X57YTRPQ8A7F4ENEW00001")).toBe(true);
    expect(map.size).toBe(2000);
  });

  it("fails safe and records internalErrorsCount on unexpected exceptions in store methods", () => {
    const throwingStore = new LeaseStore({ keyset: trustedKeyset });
    const payload = createLeasePayload({ lease_id: "01J9X57YTRPQ8A7F4ENEW00099" });
    const env = signLease(payload, alicePair.privateKey);

    // 1. Trigger catch block in addLease
    (throwingStore as any).revocations = {
      has: () => {
        throw new Error("Simulated revocations.has fault");
      },
    };
    expect(throwingStore.addLease(env)).toBe(false);
    expect(throwingStore.getMetrics().internalErrorsCount).toBe(1);

    // 2. Trigger catch block in getActiveLease
    (throwingStore as any).leases = {
      get: () => {
        throw new Error("Simulated leases.get fault");
      },
    };
    expect(throwingStore.getActiveLease("any-flag")).toBeUndefined();
    expect(throwingStore.getMetrics().internalErrorsCount).toBe(2);

    // 3. Trigger catch block in applyRevocation
    const revPayload: RevocationPayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4ENEW00099",
      revoked_at: new Date().toISOString(),
      kid: "sre-alice",
      reason: "manual",
    };
    const revEnv = signRevocation(revPayload, alicePair.privateKey);
    (throwingStore as any).revocations = {
      set: () => {
        throw new Error("Simulated revocations.set fault");
      },
    };
    expect(throwingStore.applyRevocation(revEnv, trustedKeyset)).toBe(false);
    expect(throwingStore.getMetrics().internalErrorsCount).toBe(3);

    // 4. Trigger catch block in applyKeyRevocation
    const keyRevPayload: KeyRevocationPayload = {
      v: 1,
      kid: "sre-alice",
      revoked_at: new Date().toISOString(),
      revoked_by_kid: "admin-carol",
      reason: "compromised",
    };
    const keyRevEnv = signKeyRevocation(keyRevPayload, adminPair.privateKey);
    (throwingStore as any).keyRevocations = {
      values: () => [],
      set: () => {
        throw new Error("Simulated keyRevocations.set fault");
      },
    };
    expect(throwingStore.applyKeyRevocation(keyRevEnv, trustedKeyset)).toBe(false);
    expect(throwingStore.getMetrics().internalErrorsCount).toBe(4);
  });

  it("rejects revocations with invalid signatures or revoked signer keys", () => {
    // 1. applyRevocation with invalid signature
    const invalidRevEnv = {
      payload: {
        v: 1 as const,
        lease_id: "01J9X57YTRPQ8A7F4E12345678",
        revoked_at: new Date().toISOString(),
        kid: "sre-alice",
        reason: "early",
      },
      sig: "invalid-signature",
    };
    expect(store.applyRevocation(invalidRevEnv as any, trustedKeyset)).toBe(false);

    // 2. applyKeyRevocation with invalid signature
    const invalidKeyRevEnv = {
      payload: {
        v: 1 as const,
        kid: "sre-alice",
        revoked_at: new Date().toISOString(),
        revoked_by_kid: "admin-carol",
        reason: "compromised",
      },
      sig: "invalid-signature",
    };
    expect(store.applyKeyRevocation(invalidKeyRevEnv as any, trustedKeyset)).toBe(false);

    // 3. applyRevocation when signing kid has already been revoked via applyKeyRevocation
    const keyRevPayload: KeyRevocationPayload = {
      v: 1,
      kid: "sre-alice",
      revoked_at: new Date().toISOString(),
      revoked_by_kid: "admin-carol",
      reason: "compromised",
    };
    const keyRevEnv = signKeyRevocation(keyRevPayload, adminPair.privateKey);
    expect(store.applyKeyRevocation(keyRevEnv, trustedKeyset)).toBe(true);

    const validRevPayload: RevocationPayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      revoked_at: new Date().toISOString(),
      kid: "sre-alice", // this kid is now revoked!
      reason: "early",
    };
    const revEnvWithRevokedKid = signRevocation(validRevPayload, alicePair.privateKey);
    expect(store.applyRevocation(revEnvWithRevokedKid, trustedKeyset)).toBe(false);

    // 4. applyKeyRevocation when revoked_by_kid is itself revoked
    const adminRevPayload: KeyRevocationPayload = {
      v: 1,
      kid: "admin-carol",
      revoked_by_kid: "admin-carol",
      revoked_at: new Date().toISOString(),
      reason: "compromised admin",
    };
    const adminRevEnv = signKeyRevocation(adminRevPayload, adminPair.privateKey);
    expect(store.applyKeyRevocation(adminRevEnv, trustedKeyset)).toBe(true);

    const chainedKeyRevPayload: KeyRevocationPayload = {
      v: 1,
      kid: "sre-bob",
      revoked_at: new Date().toISOString(),
      revoked_by_kid: "admin-carol",
      reason: "should fail",
    };
    const chainedKeyRevEnv = signKeyRevocation(chainedKeyRevPayload, adminPair.privateKey);
    expect(store.applyKeyRevocation(chainedKeyRevEnv, trustedKeyset)).toBe(false);
  });

  it("increments leasesRejectedCount accurately across key revocation, lease revocation, expiry, and superseding conflicts", () => {
    const s = new LeaseStore({ keyset: trustedKeyset });
    expect(s.getMetrics().leasesRejectedCount).toBe(0);

    // 1. Rejected because key is revoked
    const keyRevPayload: KeyRevocationPayload = {
      v: 1,
      kid: "sre-alice",
      revoked_at: new Date().toISOString(),
      revoked_by_kid: "admin-carol",
      reason: "compromised",
    };
    s.applyKeyRevocation(signKeyRevocation(keyRevPayload, adminPair.privateKey), trustedKeyset);
    const aliceLease = signLease(
      createLeasePayload({ kid: "sre-alice", lease_id: "01J9X57YTRPQ8A7F4ENEW00101" }),
      alicePair.privateKey,
    );
    expect(s.addLease(aliceLease, trustedKeyset)).toBe(false);
    expect(s.getMetrics().leasesRejectedCount).toBe(1);

    // 2. Rejected because lease is revoked
    const bobPayload = createLeasePayload({ kid: "sre-bob", lease_id: "01J9X57YTRPQ8A7F4ENEW00102" });
    const revBobPayload: RevocationPayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4ENEW00102",
      revoked_at: new Date().toISOString(),
      kid: "sre-bob",
      reason: "early",
    };
    s.applyRevocation(signRevocation(revBobPayload, bobPair.privateKey), trustedKeyset);
    expect(s.addLease(signLease(bobPayload, bobPair.privateKey), trustedKeyset)).toBe(false);
    expect(s.getMetrics().leasesRejectedCount).toBe(2);

    // 3. Rejected because already expired
    const expiredPayload = createLeasePayload({
      kid: "sre-bob",
      lease_id: "01J9X57YTRPQ8A7F4ENEW00103",
      issued_at: new Date(Date.now() - 600_000).toISOString(),
      ttl_seconds: 60,
    });
    expect(s.addLease(signLease(expiredPayload, bobPair.privateKey), trustedKeyset)).toBe(false);
    expect(s.getMetrics().leasesRejectedCount).toBe(3);

    // 4. Rejected because superseded by newer lease
    const newerPayload = createLeasePayload({
      kid: "sre-bob",
      flag_key: "feature.test",
      lease_id: "01J9X57YTRPQ8A7F4ENEW00105",
      issued_at: new Date(Date.now()).toISOString(),
    });
    expect(s.addLease(signLease(newerPayload, bobPair.privateKey), trustedKeyset)).toBe(true);

    const olderPayload = createLeasePayload({
      kid: "sre-bob",
      flag_key: "feature.test",
      lease_id: "01J9X57YTRPQ8A7F4ENEW00104",
      issued_at: new Date(Date.now() - 50_000).toISOString(),
    });
    expect(s.addLease(signLease(olderPayload, bobPair.privateKey), trustedKeyset)).toBe(false);
    expect(s.getMetrics().leasesRejectedCount).toBe(4);
  });

  it("notifies active overrides on evictExpiredLeases only when leases were actually evicted", () => {
    const notifyFn = vi.fn();
    const s = new LeaseStore({
      keyset: trustedKeyset,
      metrics: { onActiveOverrides: notifyFn },
    });

    // When store is empty, evictExpiredLeases returns 0 and does NOT notify
    expect(s.evictExpiredLeases()).toBe(0);
    expect(notifyFn).not.toHaveBeenCalled();

    // Add an expired lease directly
    const expiredPayload = createLeasePayload({
      kid: "sre-bob",
      lease_id: "01J9X57YTRPQ8A7F4ENEW00106",
      ttl_seconds: 1,
    });
    s.addLease(signLease(expiredPayload, bobPair.privateKey), trustedKeyset);
    notifyFn.mockClear();

    // Advance clock to expire
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 50_000);
    expect(s.evictExpiredLeases()).toBe(1);
    expect(notifyFn).toHaveBeenCalledWith(0);
  });

  it("notifies active overrides on revokeLease only when a lease was actually revoked", () => {
    const notifyFn = vi.fn();
    const s = new LeaseStore({
      keyset: trustedKeyset,
      metrics: { onActiveOverrides: notifyFn },
    });

    // Revoking non-existent lease returns false and does not notify
    expect(s.revokeLease("non-existent-id")).toBe(false);
    expect(notifyFn).not.toHaveBeenCalled();

    const payload = createLeasePayload({ kid: "sre-bob", lease_id: "01J9X57YTRPQ8A7F4ENEW00107" });
    s.addLease(signLease(payload, bobPair.privateKey), trustedKeyset);
    notifyFn.mockClear();

    expect(s.revokeLease("01J9X57YTRPQ8A7F4ENEW00107")).toBe(true);
    expect(notifyFn).toHaveBeenCalledWith(0);
  });
});
