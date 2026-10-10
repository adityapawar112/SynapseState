import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("orchestrates ETag state sync -> override evaluation -> zero-context telemetry batch flush", async () => {
    const flushedBatches: unknown[] = [];
    const stateLease: LeasePayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4ESTATE901",
      env: "prod",
      flag_key: "checkout-killswitch",
      value: true,
      reason: "INC-777: Incident trigger",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "sre-alice",
      nonce: "nonce-state-e2e",
    };
    const signedLease = signLease(stateLease, alicePair.privateKey);

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/v1/sdk/state")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ etag: '"state-etag-v1"' }),
          json: async () => ({
            server_time: new Date().toISOString(),
            registry_version: 1,
            active_leases: [signedLease],
            revocations: [],
            key_revocations: [],
          }),
        };
      }
      if (url.includes("/v1/telemetry/batches")) {
        flushedBatches.push(JSON.parse(init?.body as string));
        return {
          ok: true,
          status: 202,
          json: async () => ({ status: "accepted" }),
        };
      }
      return { ok: false, status: 404 };
    });

    const delegate = new InMemoryProvider({
      "checkout-killswitch": {
        disabled: false,
        variants: { active: true, disabled: false },
        defaultVariant: "disabled",
      },
    });

    const e2eProvider = new OverrideProvider(delegate, {
      keysetPath,
      controlApiUrl: "https://control-api.synapse.internal",
      serviceToken: "service-token-e2e",
      enableKeysetWatcher: true,
      enableEmergencyScanner: false,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await OpenFeature.setProviderAndWait("e2e-state-domain", e2eProvider);
    const client = OpenFeature.getClient("e2e-state-domain");

    // 1. Initial poll via StateClient
    const stateClient = e2eProvider.getStateClient();
    expect(stateClient).toBeDefined();
    await stateClient!.pollOnce();

    // 2. Evaluation with sensitive context data (targetingKey, email)
    const result = await client.getBooleanDetails(
      "checkout-killswitch",
      false,
      {
        targetingKey: "user-super-private",
        email: "classified@internal.org",
      },
    );

    expect(result.value).toBe(true);
    expect(result.reason).toBe("OVERRIDE");

    // 3. Telemetry hook flushes batch
    const telemetryHook = e2eProvider.getTelemetryHook();
    expect(telemetryHook).toBeDefined();
    const batch = await telemetryHook!.flush();

    expect(batch).toBeDefined();
    expect(batch?.metrics).toEqual([
      {
        flag_key: "checkout-killswitch",
        variant: "true",
        reason: "OVERRIDE",
        count: 1,
      },
    ]);

    // Zero-context privacy check:
    const serialized = JSON.stringify(flushedBatches);
    expect(serialized).not.toContain("user-super-private");
    expect(serialized).not.toContain("classified@internal.org");

    await e2eProvider.onClose();
  });
});
