import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  OpenFeature,
  InMemoryProvider,
  type Provider,
  type EvaluationContext,
  type Logger,
  type Hook,
} from "@openfeature/server-sdk";
import {
  signLease,
  formatPublicKeyToBase64Url,
  type Keyset,
  type LeasePayload,
} from "@synapsestate/lease";
import { LeaseStore } from "./lease-store.js";
import { OverrideProvider } from "./provider.js";
import { InMemoryMetricsCollector } from "./metrics.js";

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

  it("safely handles throwing getters on delegate provider without crashing", () => {
    const throwingDelegate = new InMemoryProvider({}) as unknown as Provider;
    Object.defineProperty(throwingDelegate, "hooks", {
      get() {
        throw new Error("Corrupt delegate hooks getter");
      },
    });
    Object.defineProperty(throwingDelegate, "events", {
      get() {
        throw new Error("Corrupt delegate events getter");
      },
    });
    Object.defineProperty(throwingDelegate, "status", {
      get() {
        throw new Error("Corrupt delegate status getter");
      },
    });

    const p = new OverrideProvider(throwingDelegate, {
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });

    expect(p.hooks).toBeUndefined();
    expect(p.events).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it("wires and exposes StateClient and TelemetryHook when controlApiUrl is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 304,
      headers: new Headers(),
    });

    const p = new OverrideProvider(delegate, {
      leaseStore,
      controlApiUrl: "https://control-api.synapse.internal",
      serviceToken: "test-token",
      env: "staging",
      longPollWaitSeconds: 15,
      telemetryFlushIntervalMs: 10_000,
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const stateClient = p.getStateClient();
    const telemetryHook = p.getTelemetryHook();

    expect(stateClient).toBeDefined();
    expect(telemetryHook).toBeDefined();

    // Verify hooks includes telemetryHook
    expect(p.hooks).toContain(telemetryHook);

    await p.initialize();
    expect(stateClient?.isRunning()).toBe(true);

    await p.onClose();
    expect(stateClient?.isRunning()).toBe(false);
  });

  it("exposes expected provider metadata and handles SDK metrics snapshots", () => {
    expect(provider.metadata.name).toBe("SynapseStateOverrideProvider");
    expect(provider.runsOn).toBe("server");

    // Without attached InMemoryMetricsCollector
    expect(provider.getSdkMetricsSnapshot()).toBeUndefined();

    // With attached InMemoryMetricsCollector
    const metrics = new InMemoryMetricsCollector();
    metrics.onStateAge?.(250);
    const pWithMetrics = new OverrideProvider(delegate, {
      leaseStore,
      metrics,
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });
    const snapshot = pWithMetrics.getSdkMetricsSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot?.stateAgeSeconds).toBe(250);
  });

  it("falls back to delegate on type mismatches and internal exceptions across all evaluation types", async () => {
    const dummyLogger: Logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const ctx: EvaluationContext = {};

    // 1. String evaluation: override with boolean value -> falls back to delegate ("blue")
    const boolLease = signTestLease({
      flag_key: "feature.string",
      value: true,
    });
    leaseStore.addLease(boolLease, trustedKeyset);
    const strRes1 = await provider.resolveStringEvaluation(
      "feature.string",
      "fallback",
      ctx,
      dummyLogger,
    );
    expect(strRes1.value).toBe("blue");

    // Now override with string value -> returns OVERRIDE details
    const strLease = signTestLease({
      flag_key: "feature.string",
      value: "emergency-red",
    });
    leaseStore.addLease(strLease, trustedKeyset);
    const strRes2 = await provider.resolveStringEvaluation(
      "feature.string",
      "fallback",
      ctx,
      dummyLogger,
    );
    expect(strRes2.value).toBe("emergency-red");
    expect(strRes2.reason).toBe("OVERRIDE");

    // 2. Number evaluation: non-finite number or string -> falls back to delegate
    const strLeaseForNum = signTestLease({
      flag_key: "feature.num",
      value: "not-a-number",
    });
    leaseStore.addLease(strLeaseForNum, trustedKeyset);
    const numRes1 = await provider.resolveNumberEvaluation(
      "feature.num",
      999,
      ctx,
      dummyLogger,
    );
    expect(numRes1.value).toBe(10); // delegate default

    const validNumLease = signTestLease({ flag_key: "feature.num", value: 42 });
    leaseStore.addLease(validNumLease, trustedKeyset);
    const numRes2 = await provider.resolveNumberEvaluation(
      "feature.num",
      999,
      ctx,
      dummyLogger,
    );
    expect(numRes2.value).toBe(42);
    expect(numRes2.reason).toBe("OVERRIDE");

    // 3. Object evaluation: null or primitive -> falls back to delegate
    const nullLeaseForObj = signTestLease({
      flag_key: "feature.obj",
      value: null as any,
    });
    leaseStore.addLease(nullLeaseForObj, trustedKeyset);
    const objRes1 = await provider.resolveObjectEvaluation(
      "feature.obj",
      { rateLimit: 1, tier: "t" },
      ctx,
      dummyLogger,
    );
    expect(objRes1.value).toEqual({ rateLimit: 60, tier: "standard" });

    const validObjLease = signTestLease({
      flag_key: "feature.obj",
      value: { rateLimit: 1200, tier: "enterprise" },
    });
    leaseStore.addLease(validObjLease, trustedKeyset);
    const objRes2 = await provider.resolveObjectEvaluation(
      "feature.obj",
      { rateLimit: 1, tier: "t" },
      ctx,
      dummyLogger,
    );
    expect(objRes2.value).toEqual({ rateLimit: 1200, tier: "enterprise" });
    expect(objRes2.reason).toBe("OVERRIDE");
    expect(objRes2.variant).toBe(
      JSON.stringify({ rateLimit: 1200, tier: "enterprise" }),
    );
  });

  it("handles exception thrown during store lookup in resolveString, resolveNumber, and resolveObject", async () => {
    const dummyLogger: Logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const ctx: EvaluationContext = {};

    vi.spyOn(leaseStore, "getActiveLease").mockImplementation(() => {
      throw new Error("Simulated transient memory fault");
    });

    const strRes = await provider.resolveStringEvaluation(
      "feature.string",
      "fallback",
      ctx,
      dummyLogger,
    );
    expect(strRes.value).toBe("blue");

    const numRes = await provider.resolveNumberEvaluation(
      "feature.num",
      0,
      ctx,
      dummyLogger,
    );
    expect(numRes.value).toBe(10);

    const objRes = await provider.resolveObjectEvaluation(
      "feature.obj",
      {} as any,
      ctx,
      dummyLogger,
    );
    expect(objRes.value).toEqual({ rateLimit: 60, tier: "standard" });

    expect(provider.getMetrics().internalErrorsCount).toBeGreaterThanOrEqual(3);
  });

  it("catches and logs errors during initialize and onClose", async () => {
    const warnFn = vi.fn();
    const failingDelegate: Provider = {
      metadata: { name: "failing-delegate" },
      initialize: vi.fn().mockRejectedValue(new Error("Init boom")),
      onClose: vi.fn().mockRejectedValue(new Error("Close boom")),
      resolveBooleanEvaluation: vi.fn(),
      resolveStringEvaluation: vi.fn(),
      resolveNumberEvaluation: vi.fn(),
      resolveObjectEvaluation: vi.fn(),
    };

    const p = new OverrideProvider(failingDelegate, {
      leaseStore,
      logger: { debug: vi.fn(), info: vi.fn(), warn: warnFn, error: vi.fn() },
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });

    await expect(p.initialize()).rejects.toThrow("Init boom");
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("OverrideProvider failed during initialize"),
    );

    await expect(p.onClose()).resolves.toBeUndefined();
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("OverrideProvider failed during onClose"),
    );
    expect(p.getMetrics().internalErrorsCount).toBeGreaterThanOrEqual(2);
  });

  it("safely resolves hooks across all combinations of delegate and telemetry hook presence and errors", () => {
    const dummyHook: Hook = {};

    // 1. Delegate has no hooks, telemetry disabled -> undefined
    const pNoHooks = new OverrideProvider(delegate, {
      leaseStore,
      enableTelemetry: false,
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });
    expect(pNoHooks.hooks).toBeUndefined();

    // 2. Delegate has hooks, telemetry disabled -> delegateHooks
    const delegateWithHooks: Provider = {
      metadata: { name: "test-delegate" },
      resolveBooleanEvaluation: vi.fn(),
      resolveStringEvaluation: vi.fn(),
      resolveNumberEvaluation: vi.fn(),
      resolveObjectEvaluation: vi.fn(),
      hooks: [dummyHook],
    };
    const pWithDelegateHooks = new OverrideProvider(delegateWithHooks, {
      leaseStore,
      enableTelemetry: false,
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });
    expect(pWithDelegateHooks.hooks).toEqual([dummyHook]);

    // 3. Delegate has hooks, telemetry enabled -> [telemetryHook, dummyHook]
    const pWithBoth = new OverrideProvider(delegateWithHooks, {
      leaseStore,
      enableTelemetry: true,
      controlApiUrl: "http://localhost:3000",
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });
    expect(pWithBoth.hooks?.length).toBe(2);

    // 4. Delegate throws on hooks getter, telemetry enabled -> [telemetryHook]
    const throwingHooksDelegate: Provider = {
      metadata: { name: "throwing-hooks-delegate" },
      resolveBooleanEvaluation: vi.fn(),
      resolveStringEvaluation: vi.fn(),
      resolveNumberEvaluation: vi.fn(),
      resolveObjectEvaluation: vi.fn(),
      get hooks(): Hook[] {
        throw new Error("Corrupted hooks getter");
      },
    };
    const pThrowingWithTelemetry = new OverrideProvider(throwingHooksDelegate, {
      leaseStore,
      enableTelemetry: true,
      controlApiUrl: "http://localhost:3000",
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });
    expect(pThrowingWithTelemetry.hooks?.length).toBe(1);

    // 5. Delegate throws on hooks getter, telemetry disabled -> undefined
    const pThrowingWithoutTelemetry = new OverrideProvider(
      throwingHooksDelegate,
      {
        leaseStore,
        enableTelemetry: false,
        enableKeysetWatcher: false,
        enableEmergencyScanner: false,
      },
    );
    expect(pThrowingWithoutTelemetry.hooks).toBeUndefined();
  });

  it("safely delegates events and status getters including when delegate throws", () => {
    // Normal getters
    expect(provider.events).toBe(delegate.events);
    expect(provider.status).toBe((delegate as any).status);

    // Throwing getters
    const throwingDelegate: Provider = {
      metadata: { name: "throwing-delegate" },
      resolveBooleanEvaluation: vi.fn(),
      resolveStringEvaluation: vi.fn(),
      resolveNumberEvaluation: vi.fn(),
      resolveObjectEvaluation: vi.fn(),
      get events(): never {
        throw new Error("events fault");
      },
      get status(): never {
        throw new Error("status fault");
      },
    };
    const p = new OverrideProvider(throwingDelegate, {
      leaseStore,
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });
    expect(p.events).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it("links getPropagationLagMs from stateClient to telemetryHook and manages lifecycle start/stop", async () => {
    const p = new OverrideProvider(delegate, {
      leaseStore,
      controlApiUrl: "http://localhost:3000",
      enableKeysetWatcher: false,
      enableEmergencyScanner: false,
    });

    const stateClient = (p as any).stateClient;
    const telemetryHook = (p as any).telemetryHook;
    expect(stateClient).toBeDefined();
    expect(telemetryHook).toBeDefined();

    // Verify propagation lag linkage
    vi.spyOn(stateClient, "getLastPropagationLagMs").mockReturnValue(42);
    const getLag = (telemetryHook as any).getPropagationLagMs;
    expect(getLag()).toBe(42);

    // Test lifecycle calls
    const startScannerSpy = vi.fn().mockResolvedValue(undefined);
    const stopScannerSpy = vi.fn().mockResolvedValue(undefined);
    (p as any).emergencyScanner = {
      start: startScannerSpy,
      stop: stopScannerSpy,
    };

    const startClientSpy = vi.fn().mockResolvedValue(undefined);
    const stopClientSpy = vi.fn().mockResolvedValue(undefined);
    (p as any).stateClient = {
      start: startClientSpy,
      stop: stopClientSpy,
      getLastPropagationLagMs: () => 42,
    };

    const startHookSpy = vi.fn();
    const stopHookSpy = vi.fn().mockResolvedValue(undefined);
    (p as any).telemetryHook = { start: startHookSpy, stop: stopHookSpy };

    await p.initialize();
    expect(startScannerSpy).toHaveBeenCalled();
    expect(startClientSpy).toHaveBeenCalled();
    expect(startHookSpy).toHaveBeenCalled();

    await p.onClose();
    expect(stopScannerSpy).toHaveBeenCalled();
    expect(stopClientSpy).toHaveBeenCalled();
    expect(stopHookSpy).toHaveBeenCalled();
  });
});
