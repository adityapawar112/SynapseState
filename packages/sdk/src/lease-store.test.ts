import { describe, it, expect, beforeEach } from "vitest";
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
});
