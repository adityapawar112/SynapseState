import crypto from "node:crypto";
import {
  OpenFeature,
  InMemoryProvider,
  type EvaluationContext,
  type Logger,
  type Client,
} from "@openfeature/server-sdk";
import {
  signLease,
  formatPublicKeyToBase64Url,
  type Keyset,
  type LeasePayload,
  type LeaseExpiryParams,
} from "@synapsestate/lease";
import { LeaseStore } from "../src/lease-store.js";
import { OverrideProvider } from "../src/provider.js";

export interface BenchmarkFixtures {
  // Direct Providers
  bareDelegate: InMemoryProvider;
  overrideProvider: OverrideProvider;
  leaseStore: LeaseStore;

  // OpenFeature Clients
  bareClient: Client;
  wrappedClient: Client;
  wrappedClientWithTelemetry: Client;

  // Evaluation Context & Logger
  context: EvaluationContext;
  noopLogger: Logger;

  // Flag Keys
  flags: {
    fallbackBool: string;
    fallbackString: string;
    fallbackNumber: string;
    fallbackObject: string;
    overrideBool: string;
    overrideString: string;
    overrideNumber: string;
    overrideObject: string;
  };

  // Sample expiry parameters for isolated evaluation testing
  sampleExpiryParams: LeaseExpiryParams;
}

/**
 * Creates and sets up reproducible, deterministic benchmark fixtures
 * measuring hot-path evaluation across bare delegate, fallback cache-miss,
 * and active override match.
 */
export function createBenchmarkFixtures(): BenchmarkFixtures {
  // 1. Generate Ed25519 keypair and build trusted keyset
  const alicePair = crypto.generateKeyPairSync("ed25519");
  const alicePubB64 = formatPublicKeyToBase64Url(alicePair.publicKey);

  const trustedKeyset: Keyset = {
    "sre-alice": {
      public_key: alicePubB64,
      role: "operator",
      roles: ["lease_signer"],
      status: "active",
      max_ttl_seconds: 86400,
    },
  };

  // 2. Configure baseline delegate with test flags
  const bareDelegate = new InMemoryProvider({
    "feature.fallback.bool": {
      disabled: false,
      variants: { on: true, off: false },
      defaultVariant: "off",
    },
    "feature.fallback.string": {
      disabled: false,
      variants: { v1: "blue", v2: "green" },
      defaultVariant: "v1",
    },
    "feature.fallback.number": {
      disabled: false,
      variants: { low: 10, high: 100 },
      defaultVariant: "low",
    },
    "feature.fallback.object": {
      disabled: false,
      variants: {
        standard: { rateLimit: 60, tier: "standard" },
        boosted: { rateLimit: 600, tier: "premium" },
      },
      defaultVariant: "standard",
    },
    "feature.override.bool": {
      disabled: false,
      variants: { on: true, off: false },
      defaultVariant: "off",
    },
    "feature.override.string": {
      disabled: false,
      variants: { v1: "blue", v2: "green" },
      defaultVariant: "v1",
    },
    "feature.override.number": {
      disabled: false,
      variants: { low: 10, high: 100 },
      defaultVariant: "low",
    },
    "feature.override.object": {
      disabled: false,
      variants: {
        standard: { rateLimit: 60, tier: "standard" },
        boosted: { rateLimit: 600, tier: "premium" },
      },
      defaultVariant: "standard",
    },
  });

  // 3. Construct LeaseStore and ingest active emergency overrides
  const leaseStore = new LeaseStore({
    keyset: trustedKeyset,
    skewToleranceMs: 30_000,
    maxTtlSeconds: 86400,
  });

  const nowIso = new Date().toISOString();

  // Active Boolean Override: overrides false -> true
  const boolPayload: LeasePayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E12345678",
    env: "prod",
    flag_key: "feature.override.bool",
    value: true,
    reason: "INC-101: Emergency mitigation",
    issued_at: nowIso,
    ttl_seconds: 7200,
    kid: "sre-alice",
    nonce: "nonce-bool-1234",
  };
  const boolEnvelope = signLease(boolPayload, alicePair.privateKey);
  leaseStore.addLease(boolEnvelope);

  // Active String Override: overrides "blue" -> "emergency-green"
  const stringPayload: LeasePayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E12345679",
    env: "prod",
    flag_key: "feature.override.string",
    value: "emergency-green",
    reason: "INC-102: Emergency skin change",
    issued_at: nowIso,
    ttl_seconds: 7200,
    kid: "sre-alice",
    nonce: "nonce-str-1234",
  };
  const stringEnvelope = signLease(stringPayload, alicePair.privateKey);
  leaseStore.addLease(stringEnvelope);

  // Active Number Override: overrides 10 -> 9999
  const numberPayload: LeasePayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E12345680",
    env: "prod",
    flag_key: "feature.override.number",
    value: 9999,
    reason: "INC-103: Rate limit bypass",
    issued_at: nowIso,
    ttl_seconds: 7200,
    kid: "sre-alice",
    nonce: "nonce-num-1234",
  };
  const numberEnvelope = signLease(numberPayload, alicePair.privateKey);
  leaseStore.addLease(numberEnvelope);

  // Active Object Override: overrides standard -> emergency config
  const objectPayload: LeasePayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E12345681",
    env: "prod",
    flag_key: "feature.override.object",
    value: { rateLimit: 9999, tier: "emergency-override", active: true },
    reason: "INC-104: Emergency tier override",
    issued_at: nowIso,
    ttl_seconds: 7200,
    kid: "sre-alice",
    nonce: "nonce-obj-1234",
  };
  const objectEnvelope = signLease(objectPayload, alicePair.privateKey);
  leaseStore.addLease(objectEnvelope);

  // 4. Construct wrapped OverrideProvider
  const overrideProvider = new OverrideProvider({
    delegate: bareDelegate,
    leaseStore,
    enableKeysetWatcher: false,
    enableEmergencyScanner: false,
    enableLongPolling: false,
    enableTelemetry: false,
  });

  // 5. Construct OpenFeature clients
  // Client 1: Bound to bare delegate
  OpenFeature.setProvider("benchmarks-bare", bareDelegate);
  const bareClient = OpenFeature.getClient("benchmarks-bare");

  // Client 2: Bound to wrapped OverrideProvider
  OpenFeature.setProvider("benchmarks-wrapped", overrideProvider);
  const wrappedClient = OpenFeature.getClient("benchmarks-wrapped");

  // Client 3: Bound to wrapped OverrideProvider with TelemetryHook
  const telemetryProvider = new OverrideProvider({
    delegate: bareDelegate,
    leaseStore,
    enableKeysetWatcher: false,
    enableEmergencyScanner: false,
    enableLongPolling: false,
    enableTelemetry: true,
  });
  OpenFeature.setProvider("benchmarks-telemetry", telemetryProvider);
  const wrappedClientWithTelemetry = OpenFeature.getClient(
    "benchmarks-telemetry",
  );

  // 6. Context and Logger
  const context: EvaluationContext = {
    targetingKey: "user-bench-42",
    attributes: {
      tenant: "acme-corp",
      region: "us-east-1",
      tier: "enterprise",
    },
  };

  const noopLogger: Logger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  };

  const nowMono = performance.now();
  const sampleExpiryParams: LeaseExpiryParams = {
    issuedAt: nowIso,
    ttlSeconds: 7200,
    firstSeenMonoMs: nowMono,
    nowWallMs: Date.now(),
    nowMonoMs: nowMono,
    skewToleranceMs: 30_000,
    maxTtlSeconds: 86400,
  };

  return {
    bareDelegate,
    overrideProvider,
    leaseStore,
    bareClient,
    wrappedClient,
    wrappedClientWithTelemetry,
    context,
    noopLogger,
    flags: {
      fallbackBool: "feature.fallback.bool",
      fallbackString: "feature.fallback.string",
      fallbackNumber: "feature.fallback.number",
      fallbackObject: "feature.fallback.object",
      overrideBool: "feature.override.bool",
      overrideString: "feature.override.string",
      overrideNumber: "feature.override.number",
      overrideObject: "feature.override.object",
    },
    sampleExpiryParams,
  };
}
