import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HookContext, EvaluationDetails } from "@openfeature/server-sdk";
import { ULID_REGEX } from "@synapsestate/lease";
import { TelemetryHook } from "./telemetry-hook.js";
import type { TelemetryBatchPayload } from "./types.js";

describe("TelemetryHook (Invariant 5 & Zero-Context Privacy)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createMockHookContext(
    flagKey: string,
    sensitiveContext: Record<string, unknown> = {},
  ): HookContext {
    return {
      flagKey,
      defaultValue: false,
      flagValueType: "boolean",
      context: {
        targetingKey: "user-secret-12345",
        email: "alice@example.com",
        ssn: "000-12-3456",
        salary: 150000,
        ...sensitiveContext,
      },
      clientMetadata: {
        name: "test-client",
        providerMetadata: { name: "test-provider" },
      },
      providerMetadata: { name: "test-provider" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      hookData: {
        set: vi.fn(),
        get: vi.fn(),
        has: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      },
    };
  }

  it("Invariant 5: aggregates (flag_key, variant, reason) and strictly strips all evaluation context & PII", async () => {
    const flushedBatches: unknown[] = [];
    const hook = new TelemetryHook({
      instanceId: "pod-checkout-test-1",
      onFlush: (batch: TelemetryBatchPayload) => {
        flushedBatches.push(batch);
      },
    });

    const ctx = createMockHookContext("checkout-v2", {
      targetingKey: "super-secret-user",
      secretCreditCard: "4111-2222-3333-4444",
      internalUserId: "uuid-9999",
    });

    const details: EvaluationDetails<boolean> = {
      flagKey: "checkout-v2",
      value: true,
      variant: "true",
      reason: "OVERRIDE",
      flagMetadata: { "synapse.override": true },
    };

    hook.after(ctx, details);
    hook.after(ctx, details);

    const batch = await hook.flush();
    expect(batch).toBeDefined();
    expect(batch?.instance_id).toBe("pod-checkout-test-1");
    expect(batch?.batch_id).toMatch(ULID_REGEX);
    expect(batch?.metrics).toEqual([
      {
        flag_key: "checkout-v2",
        variant: "true",
        reason: "OVERRIDE",
        count: 2,
      },
    ]);

    // Verify exact key sets: strictly zero context or unexpected properties in batch or metrics
    const allowedBatchKeys = new Set([
      "instance_id",
      "batch_id",
      "window_start",
      "window_end",
      "metrics",
      "propagation_lag_ms",
      "dropped_count",
    ]);
    expect(Object.keys(batch!).every((k) => allowedBatchKeys.has(k))).toBe(true);

    for (const metric of batch!.metrics) {
      const keys = Object.keys(metric).sort();
      expect(keys).toEqual(["count", "flag_key", "reason", "variant"]);
    }

    // Stringify entire flushed batch and ensure zero context/PII values exist anywhere
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain("super-secret-user");
    expect(serialized).not.toContain("4111-2222-3333-4444");
    expect(serialized).not.toContain("uuid-9999");
    expect(serialized).not.toContain("targetingKey");
    expect(serialized).not.toContain("secretCreditCard");
  });

  it("records error evaluations with variant='error' and reason='ERROR'", async () => {
    const hook = new TelemetryHook({
      instanceId: "pod-auth-test-2",
    });

    const ctx = createMockHookContext("auth-service-v3");
    hook.error(ctx, new Error("Delegate connection timed out"));

    const batch = await hook.flush();
    expect(batch?.metrics).toEqual([
      {
        flag_key: "auth-service-v3",
        variant: "error",
        reason: "ERROR",
        count: 1,
      },
    ]);
  });

  it("deterministically sorts metrics by flag_key ASC, variant ASC, reason ASC", async () => {
    const hook = new TelemetryHook();

    // Record out of order
    hook.after(createMockHookContext("zeta-flag"), {
      flagKey: "zeta-flag",
      value: "b",
      variant: "variant-b",
      reason: "TARGETING_MATCH",
      flagMetadata: {},
    });
    hook.after(createMockHookContext("alpha-flag"), {
      flagKey: "alpha-flag",
      value: "1",
      variant: "variant-2",
      reason: "SPLIT",
      flagMetadata: {},
    });
    hook.after(createMockHookContext("alpha-flag"), {
      flagKey: "alpha-flag",
      value: "1",
      variant: "variant-1",
      reason: "DEFAULT",
      flagMetadata: {},
    });
    hook.after(createMockHookContext("alpha-flag"), {
      flagKey: "alpha-flag",
      value: "1",
      variant: "variant-1",
      reason: "CACHED",
      flagMetadata: {},
    });

    const batch = await hook.flush();
    expect(batch?.metrics).toEqual([
      {
        flag_key: "alpha-flag",
        variant: "variant-1",
        reason: "CACHED",
        count: 1,
      },
      {
        flag_key: "alpha-flag",
        variant: "variant-1",
        reason: "DEFAULT",
        count: 1,
      },
      {
        flag_key: "alpha-flag",
        variant: "variant-2",
        reason: "SPLIT",
        count: 1,
      },
      {
        flag_key: "zeta-flag",
        variant: "variant-b",
        reason: "TARGETING_MATCH",
        count: 1,
      },
    ]);
  });

  it("enforces ring buffer bulkhead capacity to prevent unbounded memory growth", async () => {
    const maxCapacity = 100;
    const hook = new TelemetryHook({
      maxDistinctMetrics: maxCapacity,
    });

    // Flood with 500 distinct flag keys
    for (let i = 0; i < 500; i++) {
      hook.after(createMockHookContext(`flag-${i}`), {
        flagKey: `flag-${i}`,
        value: "on",
        variant: "on",
        reason: "DEFAULT",
        flagMetadata: {},
      });
    }

    expect(hook.getDistinctCount()).toBe(maxCapacity);
    expect(hook.getDroppedCount()).toBe(400);

    const batch = await hook.flush();
    expect(batch?.metrics.length).toBe(maxCapacity);
    expect(batch?.dropped_count).toBe(400);

    // After flush, buffer should be reset
    expect(hook.getDistinctCount()).toBe(0);
    expect(hook.getDroppedCount()).toBe(0);
  });

  it("periodically flushes batches via HTTP POST /v1/telemetry/batches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: "accepted" }),
    });

    const hook = new TelemetryHook({
      controlApiUrl: "https://control-api.synapse.internal",
      serviceToken: "sec-token-123",
      instanceId: "pod-telemetry-42",
      flushIntervalMs: 60_000,
      fetch: fetchMock as unknown as typeof fetch,
      getPropagationLagMs: () => 1420,
    });

    hook.start();

    hook.after(createMockHookContext("cart-cache"), {
      flagKey: "cart-cache",
      value: "on",
      variant: "on",
      reason: "TARGETING_MATCH",
      flagMetadata: {},
    });

    // Advance timer past flush interval
    await vi.advanceTimersByTimeAsync(60_001);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [callUrl, callInit] = fetchMock.mock.calls[0];
    expect(callUrl).toBe("https://control-api.synapse.internal/v1/telemetry/batches");
    expect(callInit.method).toBe("POST");
    expect(callInit.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sec-token-123",
    });

    const body = JSON.parse(callInit.body as string);
    expect(body.instance_id).toBe("pod-telemetry-42");
    expect(body.batch_id).toMatch(ULID_REGEX);
    expect(body.propagation_lag_ms).toBe(1420);
    expect(body.metrics).toEqual([
      {
        flag_key: "cart-cache",
        variant: "on",
        reason: "TARGETING_MATCH",
        count: 1,
      },
    ]);

    await hook.stop();
  });

  it("does not crash application when HTTP telemetry export encounters network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const warnMock = vi.fn();

    const hook = new TelemetryHook({
      controlApiUrl: "https://control-api.synapse.internal",
      fetch: fetchMock as unknown as typeof fetch,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnMock,
        error: vi.fn(),
      },
    });

    hook.after(createMockHookContext("test-flag"), {
      flagKey: "test-flag",
      value: true,
      variant: "true",
      reason: "DEFAULT",
      flagMetadata: {},
    });

    // Calling flush should catch error and log warning, never throwing
    await expect(hook.flush()).resolves.toBeDefined();
    expect(warnMock).toHaveBeenCalled();
  });

  it("flushes remaining buffered metrics on stop()", async () => {
    const flushedBatches: unknown[] = [];
    const hook = new TelemetryHook({
      onFlush: (batch: TelemetryBatchPayload) => {
        flushedBatches.push(batch);
      },
    });

    hook.start();
    hook.after(createMockHookContext("pending-shutdown-flag"), {
      flagKey: "pending-shutdown-flag",
      value: false,
      variant: "false",
      reason: "OVERRIDE",
      flagMetadata: {},
    });

    await hook.stop();
    expect(flushedBatches.length).toBe(1);
    expect((flushedBatches[0] as { metrics: unknown[] }).metrics).toEqual([
      {
        flag_key: "pending-shutdown-flag",
        variant: "false",
        reason: "OVERRIDE",
        count: 1,
      },
    ]);
  });
});
