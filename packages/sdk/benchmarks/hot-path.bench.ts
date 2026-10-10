import { bench, describe } from "vitest";
import { evaluateLeaseExpiry } from "@synapsestate/lease";
import { createBenchmarkFixtures } from "./fixtures.js";

const fx = createBenchmarkFixtures();
const testMap = new Map<string, unknown>([
  [fx.flags.overrideBool, { test: true }],
]);

describe("Provider Boolean Evaluation Hot-Path", () => {
  bench("Bare InMemoryProvider (boolean)", async () => {
    await fx.bareDelegate.resolveBooleanEvaluation(
      fx.flags.fallbackBool,
      false,
      fx.context,
      fx.noopLogger,
    );
  });

  bench("OverrideProvider Fallback / Cache Miss (boolean)", async () => {
    await fx.overrideProvider.resolveBooleanEvaluation(
      fx.flags.fallbackBool,
      false,
      fx.context,
      fx.noopLogger,
    );
  });

  bench("OverrideProvider Active Override / Cache Hit (boolean)", async () => {
    await fx.overrideProvider.resolveBooleanEvaluation(
      fx.flags.overrideBool,
      false,
      fx.context,
      fx.noopLogger,
    );
  });
});

describe("Provider Typed Resolutions Hot-Path (String, Number, Object)", () => {
  bench("Bare InMemoryProvider (string)", async () => {
    await fx.bareDelegate.resolveStringEvaluation(
      fx.flags.fallbackString,
      "default",
      fx.context,
      fx.noopLogger,
    );
  });

  bench("OverrideProvider Fallback (string)", async () => {
    await fx.overrideProvider.resolveStringEvaluation(
      fx.flags.fallbackString,
      "default",
      fx.context,
      fx.noopLogger,
    );
  });

  bench("OverrideProvider Override (string)", async () => {
    await fx.overrideProvider.resolveStringEvaluation(
      fx.flags.overrideString,
      "default",
      fx.context,
      fx.noopLogger,
    );
  });

  bench("Bare InMemoryProvider (number)", async () => {
    await fx.bareDelegate.resolveNumberEvaluation(
      fx.flags.fallbackNumber,
      0,
      fx.context,
      fx.noopLogger,
    );
  });

  bench("OverrideProvider Fallback (number)", async () => {
    await fx.overrideProvider.resolveNumberEvaluation(
      fx.flags.fallbackNumber,
      0,
      fx.context,
      fx.noopLogger,
    );
  });

  bench("OverrideProvider Override (number)", async () => {
    await fx.overrideProvider.resolveNumberEvaluation(
      fx.flags.overrideNumber,
      0,
      fx.context,
      fx.noopLogger,
    );
  });

  bench("Bare InMemoryProvider (object)", async () => {
    await fx.bareDelegate.resolveObjectEvaluation(
      fx.flags.fallbackObject,
      {},
      fx.context,
      fx.noopLogger,
    );
  });

  bench("OverrideProvider Fallback (object)", async () => {
    await fx.overrideProvider.resolveObjectEvaluation(
      fx.flags.fallbackObject,
      {},
      fx.context,
      fx.noopLogger,
    );
  });

  bench("OverrideProvider Override (object)", async () => {
    await fx.overrideProvider.resolveObjectEvaluation(
      fx.flags.overrideObject,
      {},
      fx.context,
      fx.noopLogger,
    );
  });
});

describe("OpenFeature Client End-to-End Resolution", () => {
  bench("Bare Client getBooleanValue", async () => {
    await fx.bareClient.getBooleanValue(
      fx.flags.fallbackBool,
      false,
      fx.context,
    );
  });

  bench("Wrapped Client getBooleanValue (Fallback)", async () => {
    await fx.wrappedClient.getBooleanValue(
      fx.flags.fallbackBool,
      false,
      fx.context,
    );
  });

  bench("Wrapped Client getBooleanValue (Active Override)", async () => {
    await fx.wrappedClient.getBooleanValue(
      fx.flags.overrideBool,
      false,
      fx.context,
    );
  });

  bench("Wrapped Client getBooleanValue with TelemetryHook", async () => {
    await fx.wrappedClientWithTelemetry.getBooleanValue(
      fx.flags.overrideBool,
      false,
      fx.context,
    );
  });
});

describe("LeaseStore & Dual-Clock Expiry Breakdown", () => {
  bench("Raw Map.get() lookup", () => {
    testMap.get(fx.flags.overrideBool);
  });

  bench("LeaseStore.getActiveLease() (Cache Miss)", () => {
    fx.leaseStore.getActiveLease(fx.flags.fallbackBool);
  });

  bench("LeaseStore.getActiveLease() (Cache Hit + Dual-Clock Check)", () => {
    fx.leaseStore.getActiveLease(fx.flags.overrideBool);
  });

  bench("evaluateLeaseExpiry() (Isolated Dual-Clock Math)", () => {
    evaluateLeaseExpiry(fx.sampleExpiryParams);
  });
});
