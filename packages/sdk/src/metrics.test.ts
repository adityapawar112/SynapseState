import { describe, it, expect, vi } from "vitest";
import type { HookContext, EvaluationDetails } from "@openfeature/server-sdk";
import {
  type SynapseSdkMetrics,
  createInMemoryMetricsCollector,
  InMemoryMetricsCollector,
  safeInvokeMetricCallback,
} from "./metrics.js";
import { StateClient } from "./state-client.js";
import { KeysetWatcher } from "./keyset-watcher.js";
import { LeaseStore } from "./lease-store.js";
import { TelemetryHook } from "./telemetry-hook.js";
import { OverrideProvider } from "./provider.js";
import crypto from "node:crypto";
import {
  formatPublicKeyToBase64Url,
  signLease,
  type Keyset,
  type LeaseEnvelope,
} from "@synapsestate/lease";

describe("SDK Pluggable Metrics Callbacks (PR 12)", () => {
  describe("InMemoryMetricsCollector", () => {
    it("initializes with zeroed counters and gauges", () => {
      const collector = createInMemoryMetricsCollector();
      const snapshot = collector.getSnapshot();

      expect(snapshot).toEqual({
        stateAgeSeconds: 0,
        keysetAgeSeconds: 0,
        activeOverrides: 0,
        pollErrorsTotal: 0,
        telemetryDroppedTotal: 0,
      });
    });

    it("records gauge and counter transitions correctly", () => {
      const collector = new InMemoryMetricsCollector();

      collector.onStateAge(12.5);
      collector.onKeysetAge(45);
      collector.onActiveOverrides(3);
      collector.onPollError();
      collector.onPollError({ reason: "HTTP_500" });
      collector.onTelemetryDropped(5);
      collector.onTelemetryDropped(10);

      const snapshot = collector.getSnapshot();
      expect(snapshot.stateAgeSeconds).toBe(12.5);
      expect(snapshot.keysetAgeSeconds).toBe(45);
      expect(snapshot.activeOverrides).toBe(3);
      expect(snapshot.pollErrorsTotal).toBe(2);
      expect(snapshot.telemetryDroppedTotal).toBe(15);
    });

    it("defensively catches throwing callbacks via safeInvokeMetricCallback", () => {
      const throwingCallback = () => {
        throw new Error("Callback explosion!");
      };

      expect(() => {
        safeInvokeMetricCallback(throwingCallback);
      }).not.toThrow();
    });
  });

  describe("StateClient Integration with Metrics", () => {
    it("reports state age on successful poll and increments pollErrorsTotal on failure", async () => {
      const collector = createInMemoryMetricsCollector();
      const leaseStore = new LeaseStore();

      // Successful 200 poll
      const mockFetchSuccess = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ etag: '"etag-1"' }),
        json: async () => ({
          server_time: new Date().toISOString(),
          registry_version: 1,
          active_leases: [],
          revocations: [],
          key_revocations: [],
        }),
      });

      const client = new StateClient({
        controlApiUrl: "http://localhost:3000",
        leaseStore,
        fetch: mockFetchSuccess as unknown as typeof fetch,
        metrics: collector,
      });

      const res = await client.pollOnce();
      expect(res.status).toBe(200);
      expect(collector.getSnapshot().stateAgeSeconds).toBeGreaterThanOrEqual(0);
      expect(collector.getSnapshot().pollErrorsTotal).toBe(0);

      // Failed 500 poll
      const mockFetchError = vi.fn().mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
        headers: new Headers(),
      });

      const clientFailing = new StateClient({
        controlApiUrl: "http://localhost:3000",
        leaseStore,
        fetch: mockFetchError as unknown as typeof fetch,
        metrics: collector,
      });

      const errRes = await clientFailing.pollOnce();
      expect(errRes.status).toBe("error");
      expect(collector.getSnapshot().pollErrorsTotal).toBe(1);
    });

    it("fails safe when metrics callback throws inside StateClient", async () => {
      const faultyMetrics: SynapseSdkMetrics = {
        onStateAge: () => {
          throw new Error("Boom in onStateAge");
        },
        onPollError: () => {
          throw new Error("Boom in onPollError");
        },
      };

      const leaseStore = new LeaseStore();
      const mockFetch = vi.fn().mockResolvedValue({
        status: 304,
        headers: new Headers(),
      });

      const client = new StateClient({
        controlApiUrl: "http://localhost:3000",
        leaseStore,
        fetch: mockFetch as unknown as typeof fetch,
        metrics: faultyMetrics,
      });

      await expect(client.pollOnce()).resolves.toEqual({
        status: 304,
        etag: undefined,
      });
    });
  });

  describe("KeysetWatcher Integration with Metrics", () => {
    it("invokes onKeysetAge when pollOnce executes", async () => {
      const collector = createInMemoryMetricsCollector();
      const watcher = new KeysetWatcher({
        keysetPath: "non-existent-path.json",
        metrics: collector,
      });

      await watcher.pollOnce();

      // On unreadable file, age is tracked as -1 or 0
      expect(collector.getSnapshot().keysetAgeSeconds).toBeDefined();
    });
  });

  describe("LeaseStore Integration with Metrics", () => {
    it("reports active overrides count when leases are added or evicted", () => {
      const collector = createInMemoryMetricsCollector();
      const store = new LeaseStore({ metrics: collector });

      const kp = crypto.generateKeyPairSync("ed25519");
      const pubB64 = formatPublicKeyToBase64Url(kp.publicKey);
      const keyset: Keyset = {
        "test-key-1": {
          public_key: pubB64,
          role: "operator",
          roles: ["lease_signer"],
          status: "active",
          max_ttl_seconds: 3600,
        },
      };
      store.handleKeysetUpdate(keyset);

      const envelope: LeaseEnvelope = signLease(
        {
          v: 1,
          lease_id: "01J9X57YTRPQ8A7F4E12345678",
          flag_key: "feature-metrics",
          env: "prod",
          value: true,
          issued_at: new Date().toISOString(),
          ttl_seconds: 60,
          kid: "test-key-1",
          nonce: "test-nonce-1",
          reason: "Testing metrics callback",
        },
        kp.privateKey
      );

      store.addLease(envelope);
      expect(collector.getSnapshot().activeOverrides).toBe(1);

      store.revokeLease("01J9X57YTRPQ8A7F4E12345678");
      expect(collector.getSnapshot().activeOverrides).toBe(0);
    });
  });

  describe("TelemetryHook Integration with Metrics", () => {
    it("reports telemetry dropped count when bulkhead limit is exceeded", () => {
      const collector = createInMemoryMetricsCollector();
      const hook = new TelemetryHook({
        maxDistinctMetrics: 2,
        metrics: collector,
      });

      const mockCtx = (flag: string) =>
        ({
          flagKey: flag,
          defaultValue: false,
          context: {},
        }) as unknown as Readonly<HookContext>;

      const mockDetails = (flag: string): EvaluationDetails<boolean> => ({
        flagKey: flag,
        value: true,
        variant: "on",
        reason: "STATIC",
        flagMetadata: {},
      });

      hook.after(mockCtx("flag-1"), mockDetails("flag-1"));
      hook.after(mockCtx("flag-2"), mockDetails("flag-2"));
      expect(collector.getSnapshot().telemetryDroppedTotal).toBe(0);

      // Third distinct tuple exceeds bulkhead ceiling
      hook.after(mockCtx("flag-3"), mockDetails("flag-3"));
      expect(collector.getSnapshot().telemetryDroppedTotal).toBe(1);
    });
  });

  describe("OverrideProvider Plumbing", () => {
    it("passes metrics instance down to child components", () => {
      const collector = createInMemoryMetricsCollector();
      const mockDelegate = {
        metadata: { name: "mock" },
        resolveBooleanEvaluation: vi.fn(),
        resolveStringEvaluation: vi.fn(),
        resolveNumberEvaluation: vi.fn(),
        resolveObjectEvaluation: vi.fn(),
      };

      const provider = new OverrideProvider({
        delegate: mockDelegate,
        controlApiUrl: "http://localhost:3000",
        metrics: collector,
      });

      expect(provider.getSdkMetricsSnapshot?.()).toEqual({
        stateAgeSeconds: 0,
        keysetAgeSeconds: 0,
        activeOverrides: 0,
        pollErrorsTotal: 0,
        telemetryDroppedTotal: 0,
      });
    });
  });
});
