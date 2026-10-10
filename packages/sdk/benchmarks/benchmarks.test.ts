import { describe, it, expect } from "vitest";
import { evaluateLeaseExpiry } from "@synapsestate/lease";
import { createBenchmarkFixtures } from "./fixtures.js";

describe("Benchmark Fixtures & Hot-Path Contract Verification", () => {
  it("verifies bare delegate vs wrapped fallback on un-overridden flags", async () => {
    const fx = createBenchmarkFixtures();

    // Bare boolean evaluation
    const bareBool = await fx.bareDelegate.resolveBooleanEvaluation(
      fx.flags.fallbackBool,
      false,
      fx.context,
      fx.noopLogger,
    );
    expect(bareBool.value).toBe(false);
    expect(bareBool.reason).toBe("STATIC");

    // Wrapped fallback boolean evaluation (cache miss)
    const wrappedBool = await fx.overrideProvider.resolveBooleanEvaluation(
      fx.flags.fallbackBool,
      false,
      fx.context,
      fx.noopLogger,
    );
    expect(wrappedBool.value).toBe(false);
    expect(wrappedBool.reason).toBe("STATIC");

    // Verify String fallback
    const bareStr = await fx.bareDelegate.resolveStringEvaluation(
      fx.flags.fallbackString,
      "default",
      fx.context,
      fx.noopLogger,
    );
    const wrappedStr = await fx.overrideProvider.resolveStringEvaluation(
      fx.flags.fallbackString,
      "default",
      fx.context,
      fx.noopLogger,
    );
    expect(bareStr.value).toBe("blue");
    expect(wrappedStr.value).toBe("blue");

    // Verify Number fallback
    const bareNum = await fx.bareDelegate.resolveNumberEvaluation(
      fx.flags.fallbackNumber,
      0,
      fx.context,
      fx.noopLogger,
    );
    const wrappedNum = await fx.overrideProvider.resolveNumberEvaluation(
      fx.flags.fallbackNumber,
      0,
      fx.context,
      fx.noopLogger,
    );
    expect(bareNum.value).toBe(10);
    expect(wrappedNum.value).toBe(10);

    // Verify Object fallback
    const bareObj = await fx.bareDelegate.resolveObjectEvaluation(
      fx.flags.fallbackObject,
      {},
      fx.context,
      fx.noopLogger,
    );
    const wrappedObj = await fx.overrideProvider.resolveObjectEvaluation(
      fx.flags.fallbackObject,
      {},
      fx.context,
      fx.noopLogger,
    );
    expect(bareObj.value).toEqual({ rateLimit: 60, tier: "standard" });
    expect(wrappedObj.value).toEqual({ rateLimit: 60, tier: "standard" });
  });

  it("verifies wrapped override match on active emergency leases", async () => {
    const fx = createBenchmarkFixtures();

    // Override boolean (true overrides false)
    const overrideBool = await fx.overrideProvider.resolveBooleanEvaluation(
      fx.flags.overrideBool,
      false,
      fx.context,
      fx.noopLogger,
    );
    expect(overrideBool.value).toBe(true);
    expect(overrideBool.reason).toBe("OVERRIDE");
    expect(overrideBool.flagMetadata?.["synapse.lease_id"]).toBe(
      "01J9X57YTRPQ8A7F4E12345678",
    );
    expect(overrideBool.flagMetadata?.["synapse.issued_by"]).toBe("sre-alice");

    // Override string ("emergency-green" overrides "blue")
    const overrideStr = await fx.overrideProvider.resolveStringEvaluation(
      fx.flags.overrideString,
      "default",
      fx.context,
      fx.noopLogger,
    );
    expect(overrideStr.value).toBe("emergency-green");
    expect(overrideStr.reason).toBe("OVERRIDE");

    // Override number (9999 overrides 10)
    const overrideNum = await fx.overrideProvider.resolveNumberEvaluation(
      fx.flags.overrideNumber,
      0,
      fx.context,
      fx.noopLogger,
    );
    expect(overrideNum.value).toBe(9999);
    expect(overrideNum.reason).toBe("OVERRIDE");

    // Override object (emergency tier overrides standard)
    const overrideObj = await fx.overrideProvider.resolveObjectEvaluation(
      fx.flags.overrideObject,
      {},
      fx.context,
      fx.noopLogger,
    );
    expect(overrideObj.value).toEqual({
      rateLimit: 9999,
      tier: "emergency-override",
      active: true,
    });
    expect(overrideObj.reason).toBe("OVERRIDE");
  });

  it("verifies LeaseStore dual-clock retrieval and isolated expiry evaluation", () => {
    const fx = createBenchmarkFixtures();

    // Cache hit: active lease exists and is unexpired
    const activeLease = fx.leaseStore.getActiveLease(fx.flags.overrideBool);
    expect(activeLease).toBeDefined();
    expect(activeLease?.value).toBe(true);
    expect(activeLease?.kid).toBe("sre-alice");

    // Cache miss: no lease exists
    const missingLease = fx.leaseStore.getActiveLease(fx.flags.fallbackBool);
    expect(missingLease).toBeUndefined();

    // Isolated dual-clock expiry evaluation
    const evalResult = evaluateLeaseExpiry(fx.sampleExpiryParams);
    expect(evalResult.isValid).toBe(true);
    if (evalResult.isValid) {
      expect(evalResult.wallExpiryMs).toBeGreaterThan(Date.now());
      expect(evalResult.remainingEffectiveMs).toBeGreaterThan(0);
    }
  });

  it("verifies OpenFeature client evaluations across all configurations", async () => {
    const fx = createBenchmarkFixtures();

    const bareVal = await fx.bareClient.getBooleanValue(
      fx.flags.fallbackBool,
      true,
      fx.context,
    );
    expect(bareVal).toBe(false);

    const wrappedFallbackVal = await fx.wrappedClient.getBooleanValue(
      fx.flags.fallbackBool,
      true,
      fx.context,
    );
    expect(wrappedFallbackVal).toBe(false);

    const wrappedOverrideVal = await fx.wrappedClient.getBooleanValue(
      fx.flags.overrideBool,
      false,
      fx.context,
    );
    expect(wrappedOverrideVal).toBe(true);

    const telemetryVal = await fx.wrappedClientWithTelemetry.getBooleanValue(
      fx.flags.overrideBool,
      false,
      fx.context,
    );
    expect(telemetryVal).toBe(true);
  });
});
