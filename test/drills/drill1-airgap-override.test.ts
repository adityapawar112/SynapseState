import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { OpenFeature, InMemoryProvider } from "@openfeature/server-sdk";
import {
  signLease,
  formatPublicKeyToBase64Url,
  generateUlid,
  type Keyset,
  type LeasePayload,
} from "@synapsestate/lease";
import { OverrideProvider } from "@synapsestate/sdk";

/**
 * Chaos Drill 1: Air-Gapped Emergency Lease Application
 *
 * Charter Reference: AGENTS.md §2 (Invariants 1, 2, 3), docs/ARCHITECTURE.md §10
 *
 * Scenario:
 * - Control API is completely offline (crashed, partitioned, or connection refused).
 * - SRE on-call applies signed emergency leases directly via local air-gapped directory
 *   (simulating `kubectl apply` ConfigMap mounted to `/etc/synapse/emergency-leases/`).
 *
 * Verification:
 * 1. SDK detects emergency lease in local directory without any network access to Control API.
 * 2. Cryptographic signature is verified against locally pinned `keyset.json` (Invariant 2).
 * 3. Flag evaluation hot path resolves to OVERRIDE in-process (Invariant 1).
 * 4. Forged, tampered, or revoked-key leases are strictly rejected.
 * 5. When TTL expires, the lease automatically evicts and evaluation falls back
 *    cleanly to the delegate provider without application downtime (Invariant 3).
 */
describe("Chaos Drill 1: Air-Gapped Emergency Override Channel", () => {
  let tmpDir: string;
  let keysetPath: string;
  let emergencyDir: string;
  let provider: OverrideProvider;

  // Keypairs: Authorized SRE Alice and Revoked Key Charlie
  const alicePair = crypto.generateKeyPairSync("ed25519");
  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);

  const charliePair = crypto.generateKeyPairSync("ed25519");
  const charliePubB64 = formatPublicKeyToBase64Url(charliePair.publicKey);

  const hackerPair = crypto.generateKeyPairSync("ed25519");

  const pinnedKeyset: Keyset = {
    "alice-sre-lead": {
      public_key: alicePubB64,
      role: "operator",
      roles: ["lease_signer"],
      status: "active",
      max_ttl_seconds: 3600,
    },
    "charlie-revoked": {
      public_key: charliePubB64,
      role: "operator",
      roles: ["lease_signer"],
      status: "revoked",
      max_ttl_seconds: 3600,
    },
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-drill1-airgap-"));
    keysetPath = path.join(tmpDir, "keyset.json");
    emergencyDir = path.join(tmpDir, "emergency-leases");

    fs.writeFileSync(keysetPath, JSON.stringify(pinnedKeyset, null, 2), "utf8");
    fs.mkdirSync(emergencyDir, { recursive: true });

    // Delegate OpenFeature provider with production baseline configuration
    const delegate = new InMemoryProvider({
      "checkout-v2": {
        disabled: false,
        variants: { on: true, off: false },
        defaultVariant: "off",
      },
      "payment-gateway": {
        disabled: false,
        variants: { primary: "legacy-processor", backup: "stripe-emergency" },
        defaultVariant: "primary",
      },
      "max-retry-attempts": {
        disabled: false,
        variants: { default: 5, emergency: 1 },
        defaultVariant: "default",
      },
    });

    // Control API is completely offline (mock fetch throws ECONNREFUSED)
    const deadControlApiFetch = () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:3000");
      (err as unknown as { code: string }).code = "ECONNREFUSED";
      return Promise.reject(err);
    };

    provider = new OverrideProvider(delegate, {
      keysetPath,
      keysetPollIntervalMs: 50,
      emergencyDir,
      emergencyPollIntervalMs: 50,
      enableKeysetWatcher: true,
      enableEmergencyScanner: true,
      controlApiUrl: "http://127.0.0.1:3000",
      fetch: deadControlApiFetch as unknown as typeof fetch,
    });

    await OpenFeature.setProviderAndWait("drill1-domain", provider);
  });

  afterEach(async () => {
    await provider.onClose();
    OpenFeature.clearProviders();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies signed emergency overrides via air-gapped directory during total API outage and reverts upon TTL expiry", async () => {
    const client = OpenFeature.getClient("drill1-domain");

    // Phase 1: Baseline Verification while Control API is offline
    const baselineBool = await client.getBooleanDetails("checkout-v2", false);
    expect(baselineBool.value).toBe(false);
    expect(baselineBool.reason).toBe("STATIC");

    const baselineString = await client.getStringDetails(
      "payment-gateway",
      "primary",
    );
    expect(baselineString.value).toBe("legacy-processor");

    const baselineNum = await client.getNumberDetails("max-retry-attempts", 5);
    expect(baselineNum.value).toBe(5);

    // Phase 2: SRE Alice creates and signs emergency leases out-of-band
    const leaseId = generateUlid();
    const emergencyBoolLease: LeasePayload = {
      v: 1,
      lease_id: leaseId,
      env: "prod",
      flag_key: "checkout-v2",
      value: true,
      reason: "DRILL-1: Killswitch active during payment processor outage",
      issued_at: new Date().toISOString(),
      ttl_seconds: 1, // Short 1-second TTL for deterministic automated expiry drill
      kid: "alice-sre-lead",
      nonce: "nonce-drill1-bool",
    };
    const signedBoolEnvelope = signLease(
      emergencyBoolLease,
      alicePair.privateKey,
    );

    const emergencyStringLease: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "payment-gateway",
      value: "stripe-emergency",
      reason: "DRILL-1: Reroute traffic to emergency backup gateway",
      issued_at: new Date().toISOString(),
      ttl_seconds: 1,
      kid: "alice-sre-lead",
      nonce: "nonce-drill1-str",
    };
    const signedStringEnvelope = signLease(
      emergencyStringLease,
      alicePair.privateKey,
    );

    const emergencyNumLease: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "max-retry-attempts",
      value: 1,
      reason: "DRILL-1: Drop retries to prevent thundering herd",
      issued_at: new Date().toISOString(),
      ttl_seconds: 1,
      kid: "alice-sre-lead",
      nonce: "nonce-drill1-num",
    };
    const signedNumEnvelope = signLease(
      emergencyNumLease,
      alicePair.privateKey,
    );

    // Operator applies leases via air-gapped emergency directory mount
    fs.writeFileSync(
      path.join(emergencyDir, "lease-checkout-v2.json"),
      JSON.stringify(signedBoolEnvelope, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(emergencyDir, "lease-gateway.json"),
      JSON.stringify(signedStringEnvelope, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(emergencyDir, "lease-retry.json"),
      JSON.stringify(signedNumEnvelope, null, 2),
      "utf8",
    );

    // Trigger air-gap scanner scan
    const scanner = provider.getEmergencyScanner();
    expect(scanner).toBeDefined();
    const ingestedCount = await scanner!.scanOnce();
    expect(ingestedCount).toBe(3);

    // Phase 3: Verify Invariant 1 (Fail-Safe In-Process Override Resolution)
    const overriddenBool = await client.getBooleanDetails("checkout-v2", false);
    expect(overriddenBool.value).toBe(true);
    expect(overriddenBool.reason).toBe("OVERRIDE");
    expect(overriddenBool.flagMetadata["synapse.override"]).toBe(true);
    expect(overriddenBool.flagMetadata["synapse.lease_id"]).toBe(leaseId);
    expect(overriddenBool.flagMetadata["synapse.issued_by"]).toBe(
      "alice-sre-lead",
    );

    const overriddenString = await client.getStringDetails(
      "payment-gateway",
      "primary",
    );
    expect(overriddenString.value).toBe("stripe-emergency");
    expect(overriddenString.reason).toBe("OVERRIDE");

    const overriddenNum = await client.getNumberDetails(
      "max-retry-attempts",
      5,
    );
    expect(overriddenNum.value).toBe(1);
    expect(overriddenNum.reason).toBe("OVERRIDE");

    // Phase 4: Verify Invariant 3 (Dual-Clock Expiry & Automatic Clean Fallback)
    // Wait for 1-second TTL + SKEW tolerance to elapse
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Hot-path evaluation now falls back to delegate provider without error
    const revertedBool = await client.getBooleanDetails("checkout-v2", false);
    expect(revertedBool.value).toBe(false);
    expect(revertedBool.reason).toBe("STATIC");

    const revertedString = await client.getStringDetails(
      "payment-gateway",
      "primary",
    );
    expect(revertedString.value).toBe("legacy-processor");
    expect(revertedString.reason).toBe("STATIC");

    const revertedNum = await client.getNumberDetails("max-retry-attempts", 5);
    expect(revertedNum.value).toBe(5);
    expect(revertedNum.reason).toBe("STATIC");

    // Operational metrics confirm eviction
    const metrics = provider.getMetrics();
    expect(metrics.leasesAddedCount).toBe(3);
    expect(metrics.leasesEvictedExpiredCount).toBe(3);
    expect(metrics.activeLeasesCount).toBe(0);
  });

  it("strictly rejects forged, tampered, and revoked-key leases in air-gap channel (Invariant 2)", async () => {
    const client = OpenFeature.getClient("drill1-domain");
    const scanner = provider.getEmergencyScanner()!;

    // Scenario A: Unknown / Hacker signing key not in pinned keyset
    const forgedPayload: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "checkout-v2",
      value: true,
      reason: "ATTACK: Attempt unauthorized override injection",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "unknown-hacker-key",
      nonce: "hacker-nonce-1",
    };
    const forgedEnvelope = signLease(forgedPayload, hackerPair.privateKey);
    fs.writeFileSync(
      path.join(emergencyDir, "forged-lease.json"),
      JSON.stringify(forgedEnvelope, null, 2),
      "utf8",
    );

    const ingestedForged = await scanner.scanOnce();
    expect(ingestedForged).toBe(0);

    const flagAfterForged = await client.getBooleanDetails(
      "checkout-v2",
      false,
    );
    expect(flagAfterForged.value).toBe(false);
    expect(flagAfterForged.reason).toBe("STATIC");

    // Scenario B: Revoked signing key in pinned keyset (Charlie)
    const revokedKeyPayload: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "checkout-v2",
      value: true,
      reason: "ATTACK: Signed by revoked compromise key",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "charlie-revoked",
      nonce: "charlie-nonce-2",
    };
    const revokedKeyEnvelope = signLease(
      revokedKeyPayload,
      charliePair.privateKey,
    );
    fs.writeFileSync(
      path.join(emergencyDir, "revoked-key-lease.json"),
      JSON.stringify(revokedKeyEnvelope, null, 2),
      "utf8",
    );

    const ingestedRevoked = await scanner.scanOnce();
    expect(ingestedRevoked).toBe(0);

    const flagAfterRevoked = await client.getBooleanDetails(
      "checkout-v2",
      false,
    );
    expect(flagAfterRevoked.value).toBe(false);

    // Scenario C: Tampered payload (signature valid for value=false, but attacker altered JSON to value=true)
    const validUntamperedPayload: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "checkout-v2",
      value: false,
      reason: "Validly signed for false",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "alice-sre-lead",
      nonce: "alice-nonce-tamper",
    };
    const validEnvelope = signLease(
      validUntamperedPayload,
      alicePair.privateKey,
    );
    // Tamper with payload value in JSON
    const tamperedEnvelope = {
      ...validEnvelope,
      payload: {
        ...validEnvelope.payload,
        value: true,
      },
    };
    fs.writeFileSync(
      path.join(emergencyDir, "tampered-payload-lease.json"),
      JSON.stringify(tamperedEnvelope, null, 2),
      "utf8",
    );

    const ingestedTampered = await scanner.scanOnce();
    expect(ingestedTampered).toBe(0);

    const flagAfterTampered = await client.getBooleanDetails(
      "checkout-v2",
      false,
    );
    expect(flagAfterTampered.value).toBe(false);
  });

  it("resolves conflicting emergency leases deterministically by issued_at DESC (ARCHITECTURE §5)", async () => {
    const client = OpenFeature.getClient("drill1-domain");
    const scanner = provider.getEmergencyScanner()!;

    const baseTime = Date.now();
    // Older lease: issued at baseTime - 10_000ms, setting checkout-v2 to false
    const olderLeasePayload: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "checkout-v2",
      value: false,
      reason: "Older emergency lease",
      issued_at: new Date(baseTime - 10_000).toISOString(),
      ttl_seconds: 600,
      kid: "alice-sre-lead",
      nonce: "nonce-older-1",
    };
    const olderEnvelope = signLease(olderLeasePayload, alicePair.privateKey);

    // Newer lease: issued at baseTime, setting checkout-v2 to true
    const newerLeasePayload: LeasePayload = {
      v: 1,
      lease_id: generateUlid(),
      env: "prod",
      flag_key: "checkout-v2",
      value: true,
      reason: "Newer emergency lease superseding older",
      issued_at: new Date(baseTime).toISOString(),
      ttl_seconds: 600,
      kid: "alice-sre-lead",
      nonce: "nonce-newer-2",
    };
    const newerEnvelope = signLease(newerLeasePayload, alicePair.privateKey);

    fs.writeFileSync(
      path.join(emergencyDir, "lease-older.json"),
      JSON.stringify(olderEnvelope, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(emergencyDir, "lease-newer.json"),
      JSON.stringify(newerEnvelope, null, 2),
      "utf8",
    );

    await scanner.scanOnce();

    // Hot-path evaluation must resolve to the newer lease value (true)
    const active = await client.getBooleanDetails("checkout-v2", false);
    expect(active.value).toBe(true);
    expect(active.reason).toBe("OVERRIDE");
    expect(active.flagMetadata["synapse.lease_id"]).toBe(
      newerLeasePayload.lease_id,
    );
  });
});
