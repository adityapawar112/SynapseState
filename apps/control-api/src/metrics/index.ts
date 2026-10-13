import {
  Registry,
  register as defaultRegister,
  Gauge,
  Counter,
  Histogram,
} from "prom-client";

export interface SynapseMetrics {
  registry: Registry;
  leasesActive: Gauge<"env">;
  leaseTransitionsTotal: Counter<"from" | "to">;
  leasePropagationSeconds: Histogram<string>;
  statePollDurationSeconds: Histogram<"status_code">;
  auditPendingQueueSize: Gauge<string>;
  auditPendingAgeSeconds: Gauge<string>;
  auditChainLength: Gauge<string>;
}

/**
 * Creates and registers the Prometheus metrics instruments for SynapseState Control API.
 *
 * Implements ARCHITECTURE §11.1 & Phase 3 Observability:
 * - synapse_leases_active{env}: Number of currently active break-glass leases.
 * - synapse_lease_transitions_total{from, to}: State transition counter.
 * - synapse_lease_propagation_seconds: Histogram of propagation latency.
 * - synapse_state_poll_duration_seconds{status_code}: Histogram of /v1/sdk/state request latency.
 * - synapse_audit_pending_queue_size: Depth of unsealed events in audit_pending.
 * - synapse_audit_pending_age_seconds: Age of the oldest unsealed event in audit_pending.
 * - synapse_audit_chain_length: Monotonic count/length of sealed audit events.
 *
 * Enforces Cardinality Audit: only bounded labels (env, status_code, from, to) are registered.
 */
export function createMetricsRegistry(targetRegistry?: Registry): SynapseMetrics {
  const registry = targetRegistry ?? new Registry();

  function getOrRegisterGauge<T extends string>(
    name: string,
    help: string,
    labelNames: T[] = [],
  ): Gauge<T> {
    const existing = registry.getSingleMetric(name);
    if (existing) {
      return existing as Gauge<T>;
    }
    return new Gauge({
      name,
      help,
      labelNames,
      registers: [registry],
    });
  }

  function getOrRegisterCounter<T extends string>(
    name: string,
    help: string,
    labelNames: T[] = [],
  ): Counter<T> {
    const existing = registry.getSingleMetric(name);
    if (existing) {
      return existing as Counter<T>;
    }
    return new Counter({
      name,
      help,
      labelNames,
      registers: [registry],
    });
  }

  function getOrRegisterHistogram<T extends string>(
    name: string,
    help: string,
    labelNames: T[] = [],
    buckets: number[] = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
  ): Histogram<T> {
    const existing = registry.getSingleMetric(name);
    if (existing) {
      return existing as Histogram<T>;
    }
    return new Histogram({
      name,
      help,
      labelNames,
      buckets,
      registers: [registry],
    });
  }

  const leasesActive = getOrRegisterGauge<"env">(
    "synapse_leases_active",
    "Number of currently active break-glass emergency override leases",
    ["env"],
  );

  const leaseTransitionsTotal = getOrRegisterCounter<"from" | "to">(
    "synapse_lease_transitions_total",
    "Total number of break-glass lease state transitions",
    ["from", "to"],
  );

  const leasePropagationSeconds = getOrRegisterHistogram<string>(
    "synapse_lease_propagation_seconds",
    "Lease propagation latency in seconds between Control API and client workloads",
    [],
    [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
  );

  const statePollDurationSeconds = getOrRegisterHistogram<"status_code">(
    "synapse_state_poll_duration_seconds",
    "Request duration in seconds for /v1/sdk/state long-polling endpoint",
    ["status_code"],
    [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
  );

  const auditPendingQueueSize = getOrRegisterGauge(
    "synapse_audit_pending_queue_size",
    "Current depth of unsealed staged events in audit_pending table",
  );

  const auditPendingAgeSeconds = getOrRegisterGauge(
    "synapse_audit_pending_age_seconds",
    "Age in seconds of the oldest unsealed audit event in audit_pending",
  );

  const auditChainLength = getOrRegisterGauge(
    "synapse_audit_chain_length",
    "Total monotonic length of sealed audit events in audit_events ledger",
  );

  return {
    registry,
    leasesActive,
    leaseTransitionsTotal,
    leasePropagationSeconds,
    statePollDurationSeconds,
    auditPendingQueueSize,
    auditPendingAgeSeconds,
    auditChainLength,
  };
}

let defaultMetricsInstance: SynapseMetrics | undefined;

/**
 * Returns the default singleton metrics instance registered to prom-client's global register.
 */
export function getMetricsRegistry(): SynapseMetrics {
  if (!defaultMetricsInstance) {
    defaultMetricsInstance = createMetricsRegistry(defaultRegister);
  }
  return defaultMetricsInstance;
}
