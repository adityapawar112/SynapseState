import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  OpenFeature,
  InMemoryProvider,
  type Provider,
  type Hook,
  type HookContext,
  type EvaluationDetails,
  type EvaluationContext,
  type Logger,
  type ResolutionDetails,
  type JsonValue,
  type FlagValue,
} from "@openfeature/server-sdk";
import {
  LEASE_DOMAIN_PREFIX,
  KEYREVOCATION_DOMAIN_PREFIX,
  canonicalizeJson,
} from "@synapsestate/lease";

describe("Subsystem 3 Conformance: RFC 8785 Canonicalization & Ed25519 Cryptography", () => {
  it("enforces deterministic key ordering and whitespace omission per RFC 8785", () => {
    const uncanonical = {
      variant: "dark-mode",
      lease_id: "lease-101",
      ttl_seconds: 1800,
      flag_key: "ui.theme",
      attributes: {
        z: 99,
        a: 1,
      },
    };

    const canonicalJson = canonicalizeJson(uncanonical);
    expect(canonicalJson).toBe(
      '{"attributes":{"a":1,"z":99},"flag_key":"ui.theme","lease_id":"lease-101","ttl_seconds":1800,"variant":"dark-mode"}',
    );
  });

  it("signs and verifies Ed25519 payloads with domain separation using node:crypto", () => {
    // Generate Ed25519 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

    const payload = {
      lease_id: "lease-xyz",
      flag_key: "checkout.fast-pay",
      variant: true,
      ttl_seconds: 300,
    };
    const canonicalJson = canonicalizeJson(payload);

    // Domain separation prefix for leases
    const domainPrefix = Buffer.from(LEASE_DOMAIN_PREFIX, "utf8");
    const messageBuffer = Buffer.concat([
      domainPrefix,
      Buffer.from(canonicalJson, "utf8"),
    ]);

    // Sign with null algorithm (required for Ed25519 in Node.js)
    const signature = crypto.sign(null, messageBuffer, privateKey);
    expect(signature.length).toBe(64); // Ed25519 signatures are 64 bytes

    // Verify signature with correct domain prefix
    const isValid = crypto.verify(null, messageBuffer, publicKey, signature);
    expect(isValid).toBe(true);

    // Reject verification if domain prefix differs (cross-protocol prevention)
    const revocationPrefix = Buffer.from(KEYREVOCATION_DOMAIN_PREFIX, "utf8");
    const tamperedDomainBuffer = Buffer.concat([
      revocationPrefix,
      Buffer.from(canonicalJson, "utf8"),
    ]);
    const isDomainTamperedValid = crypto.verify(
      null,
      tamperedDomainBuffer,
      publicKey,
      signature,
    );
    expect(isDomainTamperedValid).toBe(false);

    // Reject verification if payload is altered
    const alteredPayload = Buffer.concat([
      domainPrefix,
      Buffer.from(canonicalJson + "tamper", "utf8"),
    ]);
    const isPayloadTamperedValid = crypto.verify(
      null,
      alteredPayload,
      publicKey,
      signature,
    );
    expect(isPayloadTamperedValid).toBe(false);
  });
});

describe("Subsystem 1 & 2 Conformance: OpenFeature Provider Contract & Fail-Open Override Seam", () => {
  interface ActiveLease {
    lease_id: string;
    flag_key: string;
    variant: boolean | string | number | JsonValue;
    kid: string;
    effective_expiry: string;
  }

  // Minimal OverrideProvider conforming to @openfeature/server-sdk Provider interface
  class ConformanceOverrideProvider implements Provider {
    readonly metadata = { name: "synapse-conformance-override-provider" };
    readonly runsOn = "server" as const;
    private leases = new Map<string, ActiveLease>();
    public simulateInternalCrash = false;

    constructor(private readonly delegate: Provider) {}

    setLease(lease: ActiveLease): void {
      this.leases.set(lease.flag_key, lease);
    }

    removeLease(flagKey: string): void {
      this.leases.delete(flagKey);
    }

    async resolveBooleanEvaluation(
      flagKey: string,
      defaultValue: boolean,
      context: EvaluationContext,
      logger: Logger,
    ): Promise<ResolutionDetails<boolean>> {
      try {
        if (this.simulateInternalCrash) {
          throw new Error("Simulated memory corruption / internal crash");
        }
        const lease = this.leases.get(flagKey);
        if (lease && typeof lease.variant === "boolean") {
          return {
            value: lease.variant,
            variant: String(lease.variant),
            reason: "OVERRIDE",
            flagMetadata: {
              "synapse.override": true,
              "synapse.lease_id": lease.lease_id,
              "synapse.issued_by": lease.kid,
              "synapse.effective_expiry": lease.effective_expiry,
            },
          };
        }
      } catch (err) {
        // Invariant 1: Fail-safe fallback to delegate provider on any internal exception
        logger?.warn?.(
          `SynapseState internal error, falling back to delegate: ${err}`,
        );
      }
      return this.delegate.resolveBooleanEvaluation(
        flagKey,
        defaultValue,
        context,
        logger,
      );
    }

    async resolveStringEvaluation(
      flagKey: string,
      defaultValue: string,
      context: EvaluationContext,
      logger: Logger,
    ): Promise<ResolutionDetails<string>> {
      try {
        if (this.simulateInternalCrash) {
          throw new Error("Simulated crash");
        }
        const lease = this.leases.get(flagKey);
        if (lease && typeof lease.variant === "string") {
          return {
            value: lease.variant,
            variant: lease.variant,
            reason: "OVERRIDE",
            flagMetadata: {
              "synapse.override": true,
              "synapse.lease_id": lease.lease_id,
            },
          };
        }
      } catch (err) {
        logger?.warn?.(`Fallback on error: ${err}`);
      }
      return this.delegate.resolveStringEvaluation(
        flagKey,
        defaultValue,
        context,
        logger,
      );
    }

    async resolveNumberEvaluation(
      flagKey: string,
      defaultValue: number,
      context: EvaluationContext,
      logger: Logger,
    ): Promise<ResolutionDetails<number>> {
      return this.delegate.resolveNumberEvaluation(
        flagKey,
        defaultValue,
        context,
        logger,
      );
    }

    async resolveObjectEvaluation<T extends JsonValue>(
      flagKey: string,
      defaultValue: T,
      context: EvaluationContext,
      logger: Logger,
    ): Promise<ResolutionDetails<T>> {
      return this.delegate.resolveObjectEvaluation(
        flagKey,
        defaultValue,
        context,
        logger,
      );
    }
  }

  it("intercepts flag evaluations when active emergency lease exists", async () => {
    // 1. Delegate provider baseline
    const delegate = new InMemoryProvider({
      "auth.v2": {
        disabled: false,
        variants: { on: true, off: false },
        defaultVariant: "off",
      },
      "ui.banner": {
        disabled: false,
        variants: { blue: "blue", red: "red" },
        defaultVariant: "blue",
      },
    });

    const wrapper = new ConformanceOverrideProvider(delegate);
    await OpenFeature.setProviderAndWait("conformance-domain", wrapper);
    const client = OpenFeature.getClient("conformance-domain");

    // Baseline: before override, evaluates to delegate default (false)
    const baseline = await client.getBooleanDetails("auth.v2", false);
    expect(baseline.value).toBe(false);
    expect(baseline.reason).toBe("STATIC");

    // 2. Issue emergency break-glass lease forcing auth.v2 to true
    wrapper.setLease({
      lease_id: "lease-999",
      flag_key: "auth.v2",
      variant: true,
      kid: "ops-lead",
      effective_expiry: new Date(Date.now() + 60000).toISOString(),
    });

    const overridden = await client.getBooleanDetails("auth.v2", false);
    expect(overridden.value).toBe(true);
    expect(overridden.reason).toBe("OVERRIDE");
    expect(overridden.flagMetadata["synapse.override"]).toBe(true);
    expect(overridden.flagMetadata["synapse.lease_id"]).toBe("lease-999");

    // 3. Un-overridden flag ui.banner passes straight to delegate
    const untouched = await client.getStringDetails("ui.banner", "blue");
    expect(untouched.value).toBe("blue");
    expect(untouched.reason).toBe("STATIC");

    // 4. Invariant 1: Fail-safe delegation when internal exception occurs
    wrapper.simulateInternalCrash = true;
    const failSafe = await client.getBooleanDetails("auth.v2", false);
    // Even though crash occurred in override logic, application traffic is never disrupted
    expect(failSafe.value).toBe(false); // falls back safely to delegate provider
    expect(failSafe.reason).toBe("STATIC");
  });

  it("verifies TelemetryHook collects only zero-context evaluation metrics", async () => {
    interface EvaluationRecord {
      flagKey: string;
      variant: string;
      reason: string;
    }

    const recordedMetrics: EvaluationRecord[] = [];

    // Zero-Context TelemetryHook conforming to Invariant 5
    const telemetryHook: Hook = {
      after(
        hookContext: Readonly<HookContext>,
        details: EvaluationDetails<FlagValue>,
      ): void {
        // Non-negotiable invariant: hookContext.context MUST NOT be accessed
        recordedMetrics.push({
          flagKey: hookContext.flagKey,
          variant: String(details.variant ?? "unknown"),
          reason: details.reason ?? "UNKNOWN",
        });
      },
    };

    const delegate = new InMemoryProvider({
      "feature.checkout": {
        disabled: false,
        variants: { v1: "v1", v2: "v2" },
        defaultVariant: "v1",
      },
    });

    await OpenFeature.setProviderAndWait("telemetry-domain", delegate);
    const client = OpenFeature.getClient("telemetry-domain");
    client.addHooks(telemetryHook);

    // Evaluate with sensitive context (user targeting, PII, email)
    const sensitiveContext: EvaluationContext = {
      targetingKey: "user-12345",
      email: "sensitive-user@enterprise.internal",
      tier: "enterprise-platinum",
    };

    await client.getStringValue("feature.checkout", "v1", sensitiveContext);

    expect(recordedMetrics.length).toBe(1);
    expect(recordedMetrics[0]).toEqual({
      flagKey: "feature.checkout",
      variant: "v1",
      reason: "STATIC",
    });
    // Ensure recorded metrics contains no trace of sensitiveContext keys
    expect(JSON.stringify(recordedMetrics[0])).not.toContain("user-12345");
    expect(JSON.stringify(recordedMetrics[0])).not.toContain(
      "sensitive-user@enterprise.internal",
    );
  });
});
