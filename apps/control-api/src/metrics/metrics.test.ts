import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  createMetricsRegistry,
  type SynapseMetrics,
} from "./index.js";
import { metricsRoutes } from "../routes/metrics.js";

describe("Control API Prometheus Metrics (PR 12)", () => {
  let metrics: SynapseMetrics;

  beforeEach(() => {
    metrics = createMetricsRegistry();
  });

  describe("Metric Catalog & Initialization", () => {
    it("registers all required SynapseState Prometheus instruments", async () => {
      const metricNames = await metrics.registry.getMetricsAsJSON();
      const names = metricNames.map((m) => m.name);

      expect(names).toContain("synapse_leases_active");
      expect(names).toContain("synapse_lease_transitions_total");
      expect(names).toContain("synapse_lease_propagation_seconds");
      expect(names).toContain("synapse_state_poll_duration_seconds");
      expect(names).toContain("synapse_audit_pending_queue_size");
      expect(names).toContain("synapse_audit_pending_age_seconds");
      expect(names).toContain("synapse_audit_chain_length");
    });

    it("enforces Cardinality Audit: only bounded label dimensions are permitted", async () => {
      const metricDefinitions = await metrics.registry.getMetricsAsJSON();
      const ALLOWED_LABELS = new Set(["env", "status_code", "reason", "from", "to"]);
      const FORBIDDEN_HIGH_CARDINALITY = [
        "user_id",
        "userId",
        "context",
        "lease_id",
        "leaseId",
        "flag_key",
        "flagKey",
        "actor",
        "kid",
        "service",
        "instance_id",
        "instanceId",
      ];

      for (const m of metricDefinitions) {
        // Collect any declared label names
        const declaredLabels = (m as unknown as { labelNames?: string[] }).labelNames ?? [];
        for (const label of declaredLabels) {
          expect(ALLOWED_LABELS.has(label)).toBe(true);
          expect(FORBIDDEN_HIGH_CARDINALITY.includes(label)).toBe(false);
        }
      }
    });
  });

  describe("Metric Instruments Usage", () => {
    it("records active leases and transitions correctly", async () => {
      metrics.leasesActive.set({ env: "prod" }, 3);
      metrics.leaseTransitionsTotal.inc({ from: "NONE", to: "ACTIVE" });
      metrics.leaseTransitionsTotal.inc({ from: "ACTIVE", to: "REVOKED" });
      metrics.leaseTransitionsTotal.inc({ from: "ACTIVE", to: "SUPERSEDED" });

      const output = await metrics.registry.metrics();

      expect(output).toContain('synapse_leases_active{env="prod"} 3');
      expect(output).toContain('synapse_lease_transitions_total{from="NONE",to="ACTIVE"} 1');
      expect(output).toContain('synapse_lease_transitions_total{from="ACTIVE",to="REVOKED"} 1');
      expect(output).toContain('synapse_lease_transitions_total{from="ACTIVE",to="SUPERSEDED"} 1');
    });

    it("observes propagation latency and state poll duration histograms", async () => {
      metrics.leasePropagationSeconds.observe(0.125);
      metrics.statePollDurationSeconds.observe({ status_code: "200" }, 0.045);
      metrics.statePollDurationSeconds.observe({ status_code: "304" }, 1.02);

      const output = await metrics.registry.metrics();

      expect(output).toContain("synapse_lease_propagation_seconds_bucket");
      expect(output).toContain("synapse_lease_propagation_seconds_count 1");
      expect(output).toContain('synapse_state_poll_duration_seconds_count{status_code="200"} 1');
      expect(output).toContain('synapse_state_poll_duration_seconds_count{status_code="304"} 1');
    });

    it("tracks audit ledger health metrics", async () => {
      metrics.auditPendingQueueSize.set(42);
      metrics.auditPendingAgeSeconds.set(3.5);
      metrics.auditChainLength.set(1005);

      const output = await metrics.registry.metrics();

      expect(output).toContain("synapse_audit_pending_queue_size 42");
      expect(output).toContain("synapse_audit_pending_age_seconds 3.5");
      expect(output).toContain("synapse_audit_chain_length 1005");
    });
  });

  describe("GET /metrics Route", () => {
    it("serves Prometheus text format on GET /metrics with correct Content-Type", async () => {
      const app = Fastify();
      await app.register(metricsRoutes, { metrics });

      const res = await app.inject({
        method: "GET",
        url: "/metrics",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.payload).toContain("# HELP synapse_leases_active");
      expect(res.payload).toContain("# TYPE synapse_leases_active gauge");
      expect(res.payload).toContain("# HELP synapse_lease_transitions_total");
      expect(res.payload).toContain("# TYPE synapse_lease_transitions_total counter");
      expect(res.payload).toContain("# HELP synapse_audit_pending_age_seconds");
    });

    it("uses default registry if none passed to route options", async () => {
      const app = Fastify();
      await app.register(metricsRoutes);

      const res = await app.inject({
        method: "GET",
        url: "/metrics",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBeDefined();
    });
  });

  describe("Server Integration with Route Metrics", () => {
    it("records propagation histogram when telemetry batch contains propagation_lag_ms", async () => {
      const { buildServer } = await import("../app.js");
      const testServer = buildServer({ metrics });

      const res = await testServer.inject({
        method: "POST",
        url: "/v1/telemetry/batches",
        payload: {
          instance_id: "pod-1",
          batch_id: "01METRICBATCH00000000000000",
          window_start: new Date().toISOString(),
          window_end: new Date().toISOString(),
          metrics: [],
          propagation_lag_ms: 350,
        },
      });

      expect(res.statusCode).toBe(202);

      const metricsRes = await testServer.inject({
        method: "GET",
        url: "/metrics",
      });
      expect(metricsRes.payload).toContain("synapse_lease_propagation_seconds_count 1");
    });

    it("records state poll duration histogram when /v1/sdk/state is queried", async () => {
      const { buildServer } = await import("../app.js");
      const testServer = buildServer({ metrics });

      const res = await testServer.inject({
        method: "GET",
        url: "/v1/sdk/state?env=prod&wait=0",
      });

      expect(res.statusCode).toBe(200);

      const metricsRes = await testServer.inject({
        method: "GET",
        url: "/metrics",
      });
      expect(metricsRes.payload).toContain('synapse_state_poll_duration_seconds_count{status_code="200"} 1');
    });
  });
});

