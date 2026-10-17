import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { OpenFeature, InMemoryProvider } from "@openfeature/server-sdk";
import {
  signLease,
  signRevocation,
  signKeyRevocation,
  formatPublicKeyToBase64Url,
  generateUlid,
  type Keyset,
  type LeasePayload,
  type RevocationPayload,
  type KeyRevocationPayload,
} from "@synapsestate/lease";
import {
  OverrideProvider,
  createInMemoryMetricsCollector,
} from "@synapsestate/sdk";

/**
 * Chaos Drill 3: Network Partition During Lease Revocation
 *
 * Charter Reference: AGENTS.md §2 (Invariants 1, 2, 3), docs/ARCHITECTURE.md §10 Threat Model
 *
 * Threat Scenario:
 * - Control API receives and seals an emergency lease revocation (e.g. operator caught a bug).
 * - Concurrently, a network partition isolates the client workload SDK from the Control API.
 * - Long-polling state sync requests fail or time out.
 *
 * Architectural Invariant Guarantees:
 * 1. Fail-Safe Hot Path (Invariant 1): Workload evaluations never throw or crash despite network loss.
 * 2. Bounded Exposure Window (Invariant 3 & §10): Overrides are held in memory strictly bounded
 *    by `ttl_seconds`. When TTL expires, the SDK evicts the override in-process without needing
 *    the Control API to tell it to expire.
 * 3. Instant Eviction on Partition Healing: Once network connectivity recovers, state sync
 *    applies the revocation envelope and evicts the override immediately (<100ms).
 * 4. Fast-Path Key Revocation: Compromised keys instantly evict all signed leases upon delivery.
 */
describe("Chaos Drill 3: Network Partition During Lease Revocation", () => {
  let tmpDir: string;
  let keysetPath: string;
  let emergencyDir: string;

  const alicePair = crypto.generateKeyPairSync("ed25519");
  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);

  const bobAdminPair = crypto.generateKeyPairSync("ed25519");
  const bobAdminPubB64 = formatPublicKeyToBase64Url(bobAdminPair.publicKey);

  const pinnedKeyset: Keyset = {
    "alice-sre": {
      public_key: alicePubB64,
      role: "operator",
      roles: ["lease_signer"],
      status: "active",
      max_ttl_seconds: 3600,
    },
    "bob-admin": {
      public_key: bobAdminPubB64,
      role: "admin",
      roles: ["lease_signer", "admin"],
      status: "active",
      max_ttl_seconds: 86400,
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "synapse-drill3-partition-"),
    );
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

  it("Scenario 3.1: Network Partition During Revocation — Exposure is strictly bounded by remaining TTL", async () => {
    const delegate = new InMemoryProvider({
      "checkout-v2": {
        disabled: false,
        variants: { active: true, fallback: false },
        defaultVariant: "fallback",
      },
    });

    const metricsCollector = createInMemoryMetricsCollector();

    // 1. Prepare active lease with 1-second TTL
    const leaseId = generateUlid();
    const leasePayload: LeasePayload = {
      v: 1,
      lease_id: leaseId,
      env: "production",
      flag_key: "checkout-v2",
      value: true,
      reason: "DRILL-3: Active incident override",
      issued_at: new Date().toISOString(),
      ttl_seconds: 1, // 1-second TTL for automated drill
      kid: "alice-sre",
      nonce: "nonce-drill3-1",
    };
    const signedLease = signLease(leasePayload, alicePair.privateKey);

    // Network partition controller
    let isPartitionActive = false;

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (isPartitionActive) {
        // Severe network partition: simulate socket timeout / dropped packets
        const err = new TypeError(
          "fetch failed: ETIMEDOUT (network partition)",
        );
        throw err;
      }

      if (url.includes("/v1/sdk/state")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ etag: '"etag-v1"' }),
          json: async () => ({
            server_time: new Date().toISOString(),
            registry_version: 1,
            active_leases: [signedLease],
            revocations: [],
            key_revocations: [],
          }),
        };
      }

      return { ok: false, status: 404 };
    });

    const provider = new OverrideProvider(delegate, {
      keysetPath,
      emergencyDir,
      controlApiUrl: "https://control-api.synapse.internal",
      serviceToken: "test-token",
      enableKeysetWatcher: true,
      enableEmergencyScanner: false,
      enableLongPolling: true,
      longPollWaitSeconds: 1,
      metrics: metricsCollector,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await OpenFeature.setProviderAndWait("drill3-domain", provider);
    const client = OpenFeature.getClient("drill3-domain");

    // Initial state sync via StateClient
    const stateClient = provider.getStateClient()!;
    await stateClient.pollOnce();

    // Verification 1: Override is actively serving in-process
    const initialEval = await client.getBooleanDetails("checkout-v2", false);
    expect(initialEval.value).toBe(true);
    expect(initialEval.reason).toBe("OVERRIDE");

    // Phase 2: Operator revokes lease on Control API, but network partition hits client workload
    isPartitionActive = true;

    // Workload background poll attempts sync, encounters partition error
    const pollResult = await stateClient.pollOnce();
    expect(pollResult.status).toBe("error");

    // Metric check: Poll error incremented, but application is completely unaffected
    const metricsSnapshot = metricsCollector.getSnapshot();
    expect(metricsSnapshot.pollErrorsTotal).toBeGreaterThanOrEqual(1);

    // Verification 2: During the partition, application traffic continues safely without crashing
    const duringPartitionEval = await client.getBooleanDetails(
      "checkout-v2",
      false,
    );
    // While within 1s TTL window, still serves in-memory override safely
    expect(duringPartitionEval.value).toBe(true);

    // Phase 3: Wait for 1-second TTL to expire via process monotonic clock deadline.
    // Deadline-poll until lease expires to eliminate tail-latency flakiness in loaded CI environments.
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const check = await client.getBooleanDetails("checkout-v2", false);
      if (check.value === false && check.reason === "STATIC") {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // Verification 3: Bounded Exposure Guarantee (Invariant 3 & Threat Model §10):
    // Even though the client NEVER received the revocation from Control API,
    // the in-process dual-clock validator automatically evicted the override!
    const postExpiryEval = await client.getBooleanDetails("checkout-v2", false);
    expect(postExpiryEval.value).toBe(false);
    expect(postExpiryEval.reason).toBe("STATIC");

    // In-memory store confirmed 0 active overrides
    expect(provider.getLeaseStore().getActiveLeasesCount()).toBe(0);

    await provider.onClose();
  });

  it("Scenario 3.2: Partition Healing — Instant revocation application when connection recovers", async () => {
    const delegate = new InMemoryProvider({
      "search-v2": {
        disabled: false,
        variants: { active: true, fallback: false },
        defaultVariant: "fallback",
      },
    });

    const leaseId = generateUlid();
    const leasePayload: LeasePayload = {
      v: 1,
      lease_id: leaseId,
      env: "production",
      flag_key: "search-v2",
      value: true,
      reason: "DRILL-3: Search indexing override",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600, // 10 minutes
      kid: "alice-sre",
      nonce: "nonce-drill3-2",
    };
    const signedLease = signLease(leasePayload, alicePair.privateKey);

    // Prepared signed revocation
    const revocationPayload: RevocationPayload = {
      v: 1,
      lease_id: leaseId,
      revoked_at: new Date().toISOString(),
      kid: "alice-sre",
      reason: "DRILL-3: Manual revocation during incident recovery",
    };
    const signedRevocation = signRevocation(
      revocationPayload,
      alicePair.privateKey,
    );

    let serverState = {
      active_leases: [signedLease],
      revocations: [] as unknown[],
    };

    let isPartitioned = false;

    const mockFetch = vi.fn().mockImplementation(async () => {
      if (isPartitioned) {
        throw new Error("Network unreachable (503 Service Unavailable)");
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: `"${Date.now()}"` }),
        json: async () => ({
          server_time: new Date().toISOString(),
          registry_version: 2,
          active_leases: serverState.active_leases,
          revocations: serverState.revocations,
          key_revocations: [],
        }),
      };
    });

    const provider = new OverrideProvider(delegate, {
      keysetPath,
      emergencyDir,
      controlApiUrl: "https://control-api.synapse.internal",
      serviceToken: "test-token",
      enableKeysetWatcher: true,
      enableEmergencyScanner: false,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await OpenFeature.setProviderAndWait("drill3-heal-domain", provider);
    const client = OpenFeature.getClient("drill3-heal-domain");
    const stateClient = provider.getStateClient()!;

    // 1. Initial sync: lease active
    await stateClient.pollOnce();
    const activeEval = await client.getBooleanDetails("search-v2", false);
    expect(activeEval.value).toBe(true);

    // 2. Partition hits and server seals revocation
    isPartitioned = true;
    serverState = {
      active_leases: [],
      revocations: [signedRevocation],
    };

    // Client attempts poll while partitioned: fails
    const failPoll = await stateClient.pollOnce();
    expect(failPoll.status).toBe("error");

    // Flag is still active under remaining TTL
    const stillActive = await client.getBooleanDetails("search-v2", false);
    expect(stillActive.value).toBe(true);

    // 3. Partition heals!
    isPartitioned = false;
    const healPoll = await stateClient.pollOnce();
    expect(healPoll.status).toBe(200);

    // 4. Revocation is immediately applied in memory (<100ms)
    const revokedEval = await client.getBooleanDetails("search-v2", false);
    expect(revokedEval.value).toBe(false);
    expect(revokedEval.reason).toBe("STATIC");

    // Metrics confirm eviction due to revocation
    expect(provider.getMetrics().leasesEvictedRevokedCount).toBe(1);

    await provider.onClose();
  });

  it("Scenario 3.3: Fast-Path Key Revocation Delivery — Immediately purges all leases for compromised key", async () => {
    const delegate = new InMemoryProvider({
      "feature-a": {
        disabled: false,
        variants: { on: true, off: false },
        defaultVariant: "off",
      },
      "feature-b": {
        disabled: false,
        variants: { on: true, off: false },
        defaultVariant: "off",
      },
    });

    // Alice signed two independent leases
    const leaseA: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "production",
      flag_key: "feature-a",
      value: true,
      reason: "DRILL-3: Feature A override",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "alice-sre",
      nonce: "nonce-key-rev-a",
    };
    const leaseB: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "production",
      flag_key: "feature-b",
      value: true,
      reason: "DRILL-3: Feature B override",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "alice-sre",
      nonce: "nonce-key-rev-b",
    };

    const signedA = signLease(leaseA, alicePair.privateKey);
    const signedB = signLease(leaseB, alicePair.privateKey);

    // Admin Bob signs a Key Revocation envelope revoking Alice's compromised key
    const keyRevocationPayload: KeyRevocationPayload = {
      v: 1,
      kid: "alice-sre",
      revoked_at: new Date().toISOString(),
      revoked_by_kid: "bob-admin",
      reason: "CRITICAL: Operator Alice laptop reported compromised",
    };
    const signedKeyRevocation = signKeyRevocation(
      keyRevocationPayload,
      bobAdminPair.privateKey,
    );

    let deliveryState = {
      active_leases: [signedA, signedB],
      key_revocations: [] as unknown[],
    };

    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"etag-keyrev-1"' }),
      json: async () => ({
        server_time: new Date().toISOString(),
        registry_version: 1,
        active_leases: deliveryState.active_leases,
        revocations: [],
        key_revocations: deliveryState.key_revocations,
      }),
    }));

    const provider = new OverrideProvider(delegate, {
      keysetPath,
      emergencyDir,
      controlApiUrl: "https://control-api.synapse.internal",
      serviceToken: "test-token",
      enableKeysetWatcher: true,
      enableEmergencyScanner: false,
      fetch: mockFetch as unknown as typeof fetch,
    });

    await OpenFeature.setProviderAndWait("drill3-keyrev-domain", provider);
    const client = OpenFeature.getClient("drill3-keyrev-domain");
    const stateClient = provider.getStateClient()!;

    // 1. Initial state: Both overrides active
    await stateClient.pollOnce();
    expect((await client.getBooleanDetails("feature-a", false)).value).toBe(
      true,
    );
    expect((await client.getBooleanDetails("feature-b", false)).value).toBe(
      true,
    );

    // 2. Control plane delivers fast-path key revocation
    deliveryState = {
      active_leases: [],
      key_revocations: [signedKeyRevocation],
    };

    await stateClient.pollOnce();

    // 3. Both leases immediately evicted
    expect((await client.getBooleanDetails("feature-a", false)).value).toBe(
      false,
    );
    expect((await client.getBooleanDetails("feature-b", false)).value).toBe(
      false,
    );

    // 4. Any subsequent lease signed by Alice is rejected
    const store = provider.getLeaseStore();
    const newAliceLease: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "production",
      flag_key: "feature-a",
      value: true,
      reason: "Attempt by revoked key",
      issued_at: new Date().toISOString(),
      ttl_seconds: 300,
      kid: "alice-sre",
      nonce: "nonce-subsequent",
    };
    const signedNewAlice = signLease(newAliceLease, alicePair.privateKey);
    const added = store.addLease(signedNewAlice, pinnedKeyset);
    expect(added).toBe(false);

    await provider.onClose();
  });
});
