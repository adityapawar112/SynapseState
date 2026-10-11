import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryProvider } from "@openfeature/server-sdk";
import {
  signLease,
  signRevocation,
  formatPublicKeyToBase64Url,
  parseKeysetJson,
  type Keyset,
  type LeasePayload,
  type RevocationPayload,
} from "@synapsestate/lease";
import {
  StateClient,
  LeaseStore,
  OverrideProvider,
  generateUlid,
} from "@synapsestate/sdk";
import { buildServer } from "../app.js";
import { leasePool, closePools } from "../db/pool.js";

describe("End-to-End Control API & SDK StateClient Integration", () => {
  let app: FastifyInstance;
  let serverUrl: string;
  let operatorKey: ReturnType<typeof crypto.generateKeyPairSync>;
  let testKeyset: Keyset;
  let leaseStore: LeaseStore;

  beforeAll(async () => {
    operatorKey = crypto.generateKeyPairSync("ed25519");
    const pubB64 = formatPublicKeyToBase64Url(operatorKey.publicKey);

    testKeyset = parseKeysetJson(
      JSON.stringify({
        "sre-alice": {
          public_key: pubB64,
          role: "operator",
          max_ttl_seconds: 3600,
        },
      })
    );

    app = buildServer({
      leasePool,
      keyset: testKeyset,
      fastifyOptions: { logger: false },
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    serverUrl = address;

    leaseStore = new LeaseStore({
      keyset: testKeyset,
    });
  });

  afterAll(async () => {
    await app.close();
    await closePools();
  });

  it("orchestrates full lifecycle: long-polling state sync -> active override in OverrideProvider -> revocation fallback", async () => {
    const env = "e2e-env";
    const flagKey = "e2e-payment-v2";

    // Clean DB
    await leasePool.query("DELETE FROM revocations");
    await leasePool.query("DELETE FROM leases");

    // 1. Initialize SDK StateClient
    const stateClient = new StateClient({
      controlApiUrl: serverUrl,
      leaseStore,
      env,
      waitSeconds: 2,
    });

    // Initial sync
    const initialSync = await stateClient.pollOnce();
    expect(initialSync.status).toBe(200);
    expect(stateClient.getCurrentEtag()).toBeDefined();
    expect(leaseStore.getActiveLease(flagKey)).toBeUndefined();

    // 2. OpenFeature provider delegate evaluation (baseline: false)
    const delegate = new InMemoryProvider({
      [flagKey]: {
        disabled: false,
        variants: { active: true, disabled: false },
        defaultVariant: "disabled",
      },
    });
    const provider = new OverrideProvider(delegate, {
      leaseStore,
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });
    const noopLogger = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };

    const baseline = await provider.resolveBooleanEvaluation(flagKey, false, {}, noopLogger);
    expect(baseline.value).toBe(false);
    expect(baseline.reason).not.toBe("OVERRIDE");

    // 3. Second poll with unchanged state returns 304 Not Modified
    const secondSync = await stateClient.pollOnce();
    expect(secondSync.status).toBe(304);

    // 4. Incident occurs: SRE creates emergency break-glass lease
    const leaseId = generateUlid();
    const leasePayload: LeasePayload = {
      v: 1,
      lease_id: leaseId,
      env,
      flag_key: flagKey,
      value: true,
      reason: "INC-E2E: Emergency fail-open during payment gateway outage",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "sre-alice",
      nonce: crypto.randomBytes(16).toString("base64url"),
    };
    const leaseEnvelope = signLease(leasePayload, operatorKey.privateKey);

    const postRes = await fetch(`${serverUrl}/v1/leases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(leaseEnvelope),
    });
    expect(postRes.status).toBe(201);

    // 5. StateClient polls again and receives HTTP 200 with new active lease
    const updateSync = await stateClient.pollOnce();
    expect(updateSync.status).toBe(200);
    expect(leaseStore.getActiveLease(flagKey)).toBeDefined();

    // 6. OpenFeature evaluation now resolves from active emergency lease override
    const overrideEval = await provider.resolveBooleanEvaluation(flagKey, false, {}, noopLogger);
    expect(overrideEval.value).toBe(true);
    expect(overrideEval.reason).toBe("OVERRIDE");
    expect(overrideEval.flagMetadata?.["synapse.lease_id"]).toBe(leaseId);
    expect(overrideEval.flagMetadata?.["synapse.issued_by"]).toBe("sre-alice");

    // 7. Incident resolved: SRE revokes emergency lease
    const revPayload: RevocationPayload = {
      v: 1,
      lease_id: leaseId,
      revoked_at: new Date().toISOString(),
      kid: "sre-alice",
      reason: "INC-E2E: Payment gateway recovered",
    };
    const revEnvelope = signRevocation(revPayload, operatorKey.privateKey);

    const revRes = await fetch(`${serverUrl}/v1/leases/${leaseId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(revEnvelope),
    });
    expect(revRes.status).toBe(200);

    // 8. StateClient syncs revocation into LeaseStore
    const revSync = await stateClient.pollOnce();
    expect(revSync.status).toBe(200);
    expect(leaseStore.getActiveLease(flagKey)).toBeUndefined();

    // 9. OpenFeature evaluation cleanly falls back to delegate provider
    const recoveredEval = await provider.resolveBooleanEvaluation(flagKey, false, {}, noopLogger);
    expect(recoveredEval.value).toBe(false);
    expect(recoveredEval.reason).not.toBe("OVERRIDE");
  });
});
