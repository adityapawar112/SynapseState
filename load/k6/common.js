import { Trend, Counter, Rate } from "k6/metrics";

/**
 * Common configuration and helpers for SynapseState k6 load benchmarks.
 *
 * Implements architectural boundaries:
 * - Invariant 1: Fail-safe fallback and zero disruption
 * - Invariant 5: Zero-context privacy and bounded metric cardinality
 */

// Environment Variables and Defaults
export const BASE_URL = __ENV.CONTROL_API_URL || "http://127.0.0.1:3000";
export const TARGET_ENV = __ENV.SYNAPSE_ENV || "production";
export const DEFAULT_WAIT_SECONDS = __ENV.WAIT_SECONDS || "30s";

// Custom k6 Observability Metrics
export const propagationLagTrend = new Trend(
  "synapse_lease_propagation_lag_ms",
);
export const longPoll200Counter = new Counter("synapse_long_poll_200_total");
export const longPoll304Counter = new Counter("synapse_long_poll_304_total");
export const longPollErrorRate = new Rate("synapse_long_poll_error_rate");
export const longPollDurationTrend = new Trend("synapse_long_poll_duration_ms");
export const invalidationWakeupLagTrend = new Trend(
  "synapse_invalidation_wakeup_ms",
);

export const telemetrySuccessCounter = new Counter(
  "synapse_telemetry_success_total",
);
export const telemetryLoadShedCounter = new Counter(
  "synapse_telemetry_load_shed_429_total",
);
export const telemetryErrorRate = new Rate("synapse_telemetry_error_rate");
export const telemetryBatchDurationTrend = new Trend(
  "synapse_telemetry_batch_duration_ms",
);
export const telemetryEvaluationsCounter = new Counter(
  "synapse_telemetry_evaluations_total",
);

// Standard Bounded Flag Catalog for Invariant 5 Conformance
export const BOUNDED_FLAGS = [
  { key: "killswitch-payment-v2", variants: ["true", "false"] },
  { key: "rate-limit-requests-per-min", variants: ["500", "1000", "2000"] },
  {
    key: "checkout-v2-flow",
    variants: ["control", "streamlined", "one-click"],
  },
  {
    key: "recommendation-engine-algo",
    variants: ["collaborative", "vector-embed", "heuristic"],
  },
  {
    key: "fraud-detection-model",
    variants: ["v1-rules", "v2-xgboost", "shadow-eval"],
  },
  {
    key: "search-ranking-reranker",
    variants: ["bm25", "cross-encoder", "hybrid"],
  },
  { key: "dark-mode-theme", variants: ["enabled", "disabled"] },
  {
    key: "ai-summary-assistant",
    variants: ["gpt-4o", "gemini-flash", "claude-haiku"],
  },
];

export const EVALUATION_REASONS = ["DEFAULT", "TARGETING_MATCH", "OVERRIDE"];
export const SAMPLE_SERVICES = [
  "payment-service",
  "checkout-web",
  "catalog-api",
  "order-processor",
  "search-gateway",
];

/**
 * Pure JavaScript RFC 4122 v4 UUID generator (no external npm/network dependency).
 */
export function generateUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Crockford Base32 Crockford ULID generator (for trace correlation).
 */
export function generateUlid() {
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const now = Date.now();
  let timeStr = "";
  let time = now;
  for (let i = 9; i >= 0; i--) {
    timeStr = ENCODING[time % 32] + timeStr;
    time = Math.floor(time / 32);
  }
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    randStr += ENCODING[Math.floor(Math.random() * 32)];
  }
  return timeStr + randStr;
}

/**
 * Generates a realistic TelemetryBatchPayload strictly complying with Invariant 5:
 * Zero-Context: NO user IDs, targeting attributes, or high-cardinality keys.
 */
export function generateTelemetryBatch(serviceName, env, metricCount = 3) {
  const now = new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - 60000).toISOString();
  const resolvedService =
    serviceName ||
    SAMPLE_SERVICES[Math.floor(Math.random() * SAMPLE_SERVICES.length)];
  const resolvedEnv = env || TARGET_ENV;

  const metrics = [];
  const selectedFlags = [...BOUNDED_FLAGS]
    .sort(() => 0.5 - Math.random())
    .slice(0, Math.min(metricCount, BOUNDED_FLAGS.length));

  let totalEvals = 0;
  for (const flag of selectedFlags) {
    const variant =
      flag.variants[Math.floor(Math.random() * flag.variants.length)];
    const reason =
      EVALUATION_REASONS[Math.floor(Math.random() * EVALUATION_REASONS.length)];
    const count = Math.floor(Math.random() * 500) + 10;
    totalEvals += count;

    metrics.push({
      flag_key: flag.key,
      variant,
      reason,
      count,
    });
  }

  return {
    payload: {
      instance_id: `k6-pod-${generateUuid().slice(0, 8)}`,
      batch_id: generateUlid(),
      window_start: windowStart,
      window_end: windowEnd,
      service: resolvedService,
      env: resolvedEnv,
      sdk_version: "0.1.0-k6",
      metrics,
      propagation_lag_ms: Math.floor(Math.random() * 80) + 20,
    },
    totalEvals,
  };
}

/**
 * Standard HTTP headers helper for SynapseState requests.
 */
export function getStandardHeaders(extraHeaders = {}) {
  return Object.assign(
    {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "synapsestate-k6-load-runner/0.1.0",
    },
    extraHeaders,
  );
}
