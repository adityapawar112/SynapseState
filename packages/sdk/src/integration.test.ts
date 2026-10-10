import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { OpenFeature, InMemoryProvider } from "@openfeature/server-sdk";
import {
  signLease,
  formatPublicKeyToBase64Url,
  type Keyset,
  type LeasePayload,
} from "@synapsestate/lease";
import { OverrideProvider } from "./provider.js";

describe("SDK End-to-End Integration: Break-Glass & Hot-Reload Lifecycle", () => {
  let tmpDir: string;
  let keysetPath: string;
  let emergencyDir: string;
  let provider: OverrideProvider;

  const alicePair = crypto.generateKeyPairSync("ed25519");
  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);

  const initialKeyset: Keyset = {
    "sre-alice": {
      public_key: alicePubB64,
      role: "operator",
      roles: ["lease_signer"],
      status: "active",
      max_ttl_seconds: 3600,
    },
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-"));
    keysetPath = path.join(tmpDir, "keyset.json");
    emergencyDir = path.join(tmpDir, "emergency-leases");

    fs.writeFileSync(
      keysetPath,
      JSON.stringify(initialKeyset, null, 2),
      "utf8",
    );
    fs.mkdirSync(emergencyDir, { recursive: true });

    const delegate = new InMemoryProvider({
      "checkout-killswitch": {
        disabled: false,
        variants: { active: true, disabled: false },
        defaultVariant: "disabled",
      },
    });

    provider = new OverrideProvider(delegate, {
      keysetPath,
      keysetPollIntervalMs: 50,
      emergencyDir,
      emergencyPollIntervalMs: 50,
      enableKeysetWatcher: true,
      enableEmergencyScanner: true,
    });

    await OpenFeature.setProviderAndWait("e2e-domain", provider);
  });

  afterEach(async () => {
    await provider.onClose();
    OpenFeature.clearProviders();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("orchestrates air-gapped emergency override and keyset revocation purge", async () => {
    const client = OpenFeature.getClient("e2e-domain");

    // 1. Baseline: evaluates to delegate default (disabled = false)
    const baseline = await client.getBooleanDetails(
      "checkout-killswitch",
      false,
    );
    expect(baseline.value).toBe(false);
    expect(baseline.reason).toBe("STATIC");

    // 2. Incident occurs: SRE Alice drops signed lease into emergency directory
    const leasePayload: LeasePayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      env: "prod",
      flag_key: "checkout-killswitch",
      value: true,
      reason: "INC-555: Circuit breaker activated",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "sre-alice",
      nonce: "e2e-nonce",
    };
    const signedEnvelope = signLease(leasePayload, alicePair.privateKey);
    fs.writeFileSync(
      path.join(emergencyDir, "killswitch.json"),
      JSON.stringify(signedEnvelope, null, 2),
      "utf8",
    );

    // Trigger emergency scanner
    const scanner = provider.getEmergencyScanner();
    expect(scanner).toBeDefined();
    const ingested = await scanner!.scanOnce();
    expect(ingested).toBe(1);

    // 3. Hot-path evaluation now returns OVERRIDE
    const overridden = await client.getBooleanDetails(
      "checkout-killswitch",
      false,
    );
    expect(overridden.value).toBe(true);
    expect(overridden.reason).toBe("OVERRIDE");
    expect(overridden.flagMetadata["synapse.override"]).toBe(true);
    expect(overridden.flagMetadata["synapse.lease_id"]).toBe(
      "01J9X57YTRPQ8A7F4E12345678",
    );
    expect(overridden.flagMetadata["synapse.issued_by"]).toBe("sre-alice");

    // 4. Incident mitigated: Operator commits empty keyset {} to revoke all keys
    fs.writeFileSync(keysetPath, "{}", "utf8");

    // Trigger keyset watcher poll
    const watcher = provider.getKeysetWatcher();
    expect(watcher).toBeDefined();
    await watcher!.pollOnce();

    // 5. Override must be immediately purged, falling back to delegate provider baseline
    const reverted = await client.getBooleanDetails(
      "checkout-killswitch",
      false,
    );
    expect(reverted.value).toBe(false);
    expect(reverted.reason).toBe("STATIC");
  });
});
