import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  OpenFeature,
  InMemoryProvider,
  type Provider,
  type EvaluationContext,
  type Logger,
} from "@openfeature/server-sdk";
import {
  signLease,
  formatPublicKeyToBase64Url,
  type Keyset,
  type LeasePayload,
} from "@synapsestate/lease";
import { LeaseStore } from "./lease-store.js";
import { OverrideProvider } from "./provider.js";

describe("OverrideProvider", () => {
  const alicePair = crypto.generateKeyPairSync("ed25519");
  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);

  let trustedKeyset: Keyset;
  let leaseStore: LeaseStore;
  let delegate: InMemoryProvider;
  let provider: OverrideProvider;

  beforeEach(() => {
    trustedKeyset = {
      "sre-alice": {
        public_key: alicePubB64,
        role: "operator",
        roles: ["lease_signer"],
        status: "active",
        max_ttl_seconds: 3600,
      },
    };

    leaseStore = new LeaseStore({ keyset: trustedKeyset });

    delegate = new InMemoryProvider({
      "feature.bool": {
        disabled: false,
        variants: { on: true, off: false },
        defaultVariant: "off",
      },
      "feature.string": {
        disabled: false,
        variants: { v1: "blue", v2: "green" },
        defaultVariant: "v1",
      },
      "feature.num": {
        disabled: false,
        variants: { low: 10, high: 100 },
        defaultVariant: "low",
      },
      "feature.obj": {
        disabled: false,
        variants: {
          default: { rateLimit: 60, tier: "standard" },
          boosted: { rateLimit: 600, tier: "premium" },
        },
        defaultVariant: "default",
      },
    });

    provider = new OverrideProvider({
      delegate,
      leaseStore,
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });
  });

  const signTestLease = (overrides: Partial<LeasePayload>) => {
    const payload: LeasePayload = {
      v: 1,
      lease_id: "01J9X57YTRPQ8A7F4E12345678",
      env: "prod",
      flag_key: "feature.bool",
      value: true,
      reason: "Emergency break-glass",
      issued_at: new Date().toISOString(),
      ttl_seconds: 300,
      kid: "sre-alice",
      nonce: "nonce123",
      ...overrides,
    };
    return signLease(payload, alicePair.privateKey);
  };

  it("intercepts boolean flag evaluations when active emergency lease exists", async () => {
    const dummyLogger: Logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    // 1. Baseline without override -> returns delegate value (false)
    const baseline = await provider.resolveBooleanEvaluation(
      "feature.bool",
      false,
      {},
      dummyLogger,
    );
    expect(baseline.value).toBe(false);
    expect(baseline.reason).toBe("STATIC");

    // 2. Add break-glass lease forcing feature.bool to true
    const env = signTestLease({ flag_key: "feature.bool", value: true });
    leaseStore.addLease(env, trustedKeyset);

    // 3. Override resolution
    const override = await provider.resolveBooleanEvaluation(
      "feature.bool",
      false,
      {},
      dummyLogger,
    );
    expect(override.value).toBe(true);
    expect(override.reason).toBe("OVERRIDE");
    expect(override.variant).toBe("true");
    expect(override.flagMetadata?.["synapse.override"]).toBe(true);
    expect(override.flagMetadata?.["synapse.lease_id"]).toBe(
      "01J9X57YTRPQ8A7F4E12345678",
    );
    expect(override.flagMetadata?.["synapse.issued_by"]).toBe("sre-alice");
    expect(typeof override.flagMetadata?.["synapse.effective_expiry"]).toBe(
      "string",
    );
  });

  it("intercepts string flag evaluations with override metadata", async () => {
    const dummyLogger: Logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const env = signTestLease({
      flag_key: "feature.string",
      value: "emergency-red",
      lease_id: "01J9X57YTRPQ8A7F4E12345679",
    });
    leaseStore.addLease(env, trustedKeyset);

    const result = await provider.resolveStringEvaluation(
      "feature.string",
      "blue",
      {},
      dummyLogger,
    );
    expect(result.value).toBe("emergency-red");
    expect(result.variant).toBe("emergency-red");
    expect(result.reason).toBe("OVERRIDE");
    expect(result.flagMetadata?.["synapse.override"]).toBe(true);
    expect(result.flagMetadata?.["synapse.lease_id"]).toBe(
      "01J9X57YTRPQ8A7F4E12345679",
    );
  });

  it("intercepts number flag evaluations with override metadata", async () => {
    const dummyLogger: Logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const env = signTestLease({
      flag_key: "feature.num",
      value: 500,
      lease_id: "01J9X57YTRPQ8A7F4E12345680",
    });
    leaseStore.addLease(env, trustedKeyset);

    const result = await provider.resolveNumberEvaluation(
      "feature.num",
      10,
      {},
      dummyLogger,
    );
    expect(result.value).toBe(500);
    expect(result.variant).toBe("500");
    expect(result.reason).toBe("OVERRIDE");
    expect(result.flagMetadata?.["synapse.override"]).toBe(true);
  });

  it("intercepts object flag evaluations with override metadata", async () => {
    const dummyLogger: Logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const overrideObj = { rateLimit: 9999, tier: "critical-override" };
    const env = signTestLease({
      flag_key: "feature.obj",
      value: overrideObj,
      lease_id: "01J9X57YTRPQ8A7F4E12345681",
    });
    leaseStore.addLease(env, trustedKeyset);

    const result = await provider.resolveObjectEvaluation(
      "feature.obj",
      { rateLimit: 60, tier: "standard" },
      {},
      dummyLogger,
    );
    expect(result.value).toEqual(overrideObj);
    expect(result.reason).toBe("OVERRIDE");
    expect(result.flagMetadata?.["synapse.override"]).toBe(true);
  });

  it("falls back to delegate if lease value type does not match requested resolution type", async () => {
    const dummyLogger: Logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    // Store a string value for feature.bool
    const env = signTestLease({
      flag_key: "feature.bool",
      value: "not-a-boolean",
      lease_id: "01J9X57YTRPQ8A7F4E12345682",
    });
    leaseStore.addLease(env, trustedKeyset);

    // resolveBooleanEvaluation should fall back to delegate
    const result = await provider.resolveBooleanEvaluation(
      "feature.bool",
      false,
      {},
      dummyLogger,
    );
    expect(result.value).toBe(false);
    expect(result.reason).toBe("STATIC");
  });

  it("enforces Invariant 1: Fail-Safe Exception Shielding on internal errors", async () => {
    const warnFn = vi.fn();
    const logger: Logger = {
      error: vi.fn(),
      warn: warnFn,
      info: vi.fn(),
      debug: vi.fn(),
    };

    // Simulate internal crash in getActiveLease
    vi.spyOn(leaseStore, "getActiveLease").mockImplementationOnce(() => {
      throw new Error("Simulated memory corruption / internal crash");
    });

    const result = await provider.resolveBooleanEvaluation(
      "feature.bool",
      false,
      {},
      logger,
    );

    // Evaluation must succeed via delegate without throwing
    expect(result.value).toBe(false);
    expect(result.reason).toBe("STATIC");
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("Simulated memory corruption"),
    );
    expect(provider.getMetrics().internalErrorsCount).toBeGreaterThan(0);
  });

  it("integrates seamlessly with OpenFeature SDK client", async () => {
    const domain = "test-override-domain";
    await OpenFeature.setProviderAndWait(domain, provider);
    const client = OpenFeature.getClient(domain);

    // Baseline
    expect(await client.getBooleanValue("feature.bool", false)).toBe(false);

    // Break-glass override
    const env = signTestLease({ flag_key: "feature.bool", value: true });
    leaseStore.addLease(env, trustedKeyset);

    const details = await client.getBooleanDetails("feature.bool", false);
    expect(details.value).toBe(true);
    expect(details.reason).toBe("OVERRIDE");
    expect(details.flagMetadata["synapse.override"]).toBe(true);
  });

  it("strictly enforces Invariant 5 (Zero-Context Privacy): context is never inspected or logged", async () => {
    const warnSpy = vi.fn();
    const logger: Logger = {
      error: vi.fn(),
      warn: warnSpy,
      info: vi.fn(),
      debug: vi.fn(),
    };

    // Cause an internal error while passing sensitive context
    vi.spyOn(leaseStore, "getActiveLease").mockImplementationOnce(() => {
      throw new Error("Internal store fault");
    });

    const sensitiveContext: EvaluationContext = {
      targetingKey: "sensitive-user-999",
      ssn: "000-11-2222",
      creditCard: "4111-2222-3333-4444",
    };

    await provider.resolveBooleanEvaluation(
      "feature.bool",
      false,
      sensitiveContext,
      logger,
    );

    // Verify warning call does NOT contain any sensitive context data
    expect(warnSpy).toHaveBeenCalled();
    const warningMessage = String(warnSpy.mock.calls[0][0]);
    expect(warningMessage).not.toContain("sensitive-user-999");
    expect(warningMessage).not.toContain("000-11-2222");
    expect(warningMessage).not.toContain("4111-2222-3333-4444");
  });

  it("delegates lifecycle methods initialize and onClose", async () => {
    const initSpy = vi.fn().mockResolvedValue(undefined);
    const closeSpy = vi.fn().mockResolvedValue(undefined);

    const customDelegate = new InMemoryProvider({}) as unknown as Provider;
    customDelegate.initialize = initSpy;
    customDelegate.onClose = closeSpy;

    const p = new OverrideProvider(customDelegate, {
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });

    await p.initialize?.({});
    expect(initSpy).toHaveBeenCalled();

    await p.onClose?.();
    expect(closeSpy).toHaveBeenCalled();
  });
});
