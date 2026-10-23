import { Trend, Counter, Rate } from "k6/metrics";

/**
 * Common configuration and helpers for SynapseState k6 load benchmarks.
 *
 * Implements architectural boundaries:
 * - Invariant 1: Fail-safe fallback and zero disruption
 * - Invariant 5: Zero-context privacy and bounded metric cardinality
 *
 * Environment variables:
 * - CONTROL_API_URL: Base URL for Control API (default: http://127.0.0.1:3000)
 * - SYNAPSE_ENV: Target environment namespace (default: production)
 * - WAIT_SECONDS: Long-poll wait duration (default: 30s)
 * - TELEMETRY_PATH: Telemetry ingestion path (default: /v1/telemetry/batches)
 * - PROFILE: Load profile: smoke, average_load, stress, spike (default: average_load)
 * - VUS: Virtual users override
 * - DURATION: Scenario duration override
 */

// Environment Variables and Defaults
export const BASE_URL = __ENV.CONTROL_API_URL || "http://127.0.0.1:3000";
export const TARGET_ENV = __ENV.SYNAPSE_ENV || "production";
export const DEFAULT_WAIT_SECONDS = __ENV.WAIT_SECONDS || "30s";
export const TELEMETRY_PATH = __ENV.TELEMETRY_PATH || "/v1/telemetry/batches";

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

// Bulkhead isolation proof counters
export const bulkheadIsolationViolations = new Counter(
  "synapse_bulkhead_isolation_violations",
);
export const bulkheadStateDeliveriesUnderShedding = new Counter(
  "synapse_bulkhead_state_deliveries_under_shedding",
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
 * Fisher-Yates unbiased shuffle.
 */
function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr;
}

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
 * Parses duration strings like "10m", "30s", "1m30s" into total seconds.
 * @param {string} str - Duration string.
 * @param {number} [defaultValue=0] - Fallback seconds if undefined or unparseable.
 * @returns {number} Total seconds.
 */
export function parseDurationToSeconds(str, defaultValue = 0) {
  if (!str) return defaultValue;
  let total = 0;
  const matches = str.matchAll(/(\d+)(h|m|s)/g);
  let matched = false;
  for (const m of matches) {
    matched = true;
    const val = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === "h") total += val * 3600;
    else if (unit === "m") total += val * 60;
    else if (unit === "s") total += val;
  }
  return matched ? total : parseInt(str, 10) || defaultValue;
}

/**
 * Generates a realistic TelemetryBatchPayload strictly complying with Invariant 5:
 * Zero-Context: NO user IDs, targeting attributes, or high-cardinality keys.
 * Note: Does NOT include synthetic propagation_lag_ms to prevent histogram contamination.
 */
export function generateTelemetryBatch(serviceName, env, metricCount = 3) {
  const now = new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - 60000).toISOString();
  const resolvedService =
    serviceName ||
    SAMPLE_SERVICES[Math.floor(Math.random() * SAMPLE_SERVICES.length)];
  const resolvedEnv = env || TARGET_ENV;

  // Build candidate combinations of (flag_key, variant, reason)
  const combinations = [];
  for (const flag of BOUNDED_FLAGS) {
    for (const variant of flag.variants) {
      for (const reason of EVALUATION_REASONS) {
        combinations.push({ flag_key: flag.key, variant, reason });
      }
    }
  }

  const shuffledCombinations = shuffle(combinations);
  const selectedCount = Math.min(metricCount, shuffledCombinations.length);
  const metrics = [];
  let totalEvals = 0;

  for (let i = 0; i < selectedCount; i++) {
    const item = shuffledCombinations[i];
    const count = Math.floor(Math.random() * 500) + 10;
    totalEvals += count;
    metrics.push({
      flag_key: item.flag_key,
      variant: item.variant,
      reason: item.reason,
      count,
    });
  }

  // If requested metricCount exceeds unique combinations, pad with valid tuples
  while (metrics.length < metricCount) {
    const randomItem =
      combinations[Math.floor(Math.random() * combinations.length)];
    const count = Math.floor(Math.random() * 500) + 10;
    totalEvals += count;
    metrics.push({
      flag_key: randomItem.flag_key,
      variant: randomItem.variant,
      reason: randomItem.reason,
      count,
    });
  }

  const instanceId =
    typeof __VU !== "undefined" && typeof __ITER !== "undefined"
      ? `k6-pod-vu${__VU}-iter${__ITER}`
      : `k6-pod-${generateUuid().slice(0, 8)}`;

  return {
    payload: {
      instance_id: instanceId,
      batch_id: generateUlid(),
      window_start: windowStart,
      window_end: windowEnd,
      service: resolvedService,
      env: resolvedEnv,
      sdk_version: "0.1.0-k6",
      metrics,
    },
    totalEvals,
  };
}

/**
 * Creates an emergency break-glass lease payload for live invalidation injection.
 */
export function createEmergencyLease(
  env = TARGET_ENV,
  flagKey = "checkout-redesign",
  value = true,
  reason = "INC-991: Test emergency override",
  kid = "ops-primary-01",
) {
  const issuedAt = new Date().toISOString();
  return {
    payload: {
      v: 1,
      lease_id: generateUlid(),
      env,
      flag_key: flagKey,
      value,
      reason,
      issued_at: issuedAt,
      ttl_seconds: 1800,
      kid,
      nonce: generateUuid(),
    },
    sig: "TgoN0DAo2Qjza8myGFXI5jpvvOHLycr-G_NwCxVKZyrud6TpWyD9gzKRyiwAOZ_Ce85ENmyl-rwcv1T4pmv9Cg",
  };
}

/**
 * Creates a signed lease revocation payload for live revocation testing.
 */
export function createEmergencyRevocation(
  leaseId,
  env = TARGET_ENV,
  reason = "INC-991: Test emergency override revocation",
  kid = "ops-primary-01",
) {
  const revokedAt = new Date().toISOString();
  return {
    payload: {
      v: 1,
      lease_id: leaseId,
      env,
      revoked_at: revokedAt,
      kid,
      reason,
    },
    sig: "D3a22DWPSsxdkR9tsqXqKc6dYh6Ox3Y4tTGTJZ8sqIQj88cRLE27d5wNv8OqU9fWBk6Sq0pP0qFWxSqxp656Aw",
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

/**
 * Formats a clean, readable ASCII summary table for terminal output.
 */
export function formatConsoleSummary(data) {
  let output = "\n=======================================================\n";
  output += "          SYNAPSESTATE LOAD BENCHMARK SUMMARY          \n";
  output += "=======================================================\n\n";

  if (data.root_group && data.root_group.checks) {
    output += "CHECKS:\n";
    for (const chk of data.root_group.checks) {
      const total = chk.passes + chk.fails;
      const passRate = total > 0 ? chk.passes / total : 1;
      const mark = chk.fails === 0 ? "✓" : "✗";
      output += `  ${mark} ${chk.name}: ${(passRate * 100).toFixed(1)}% (${chk.passes}/${total})\n`;
    }
    output += "\n";
  }

  output += "METRICS & LATENCIES:\n";
  for (const [name, metric] of Object.entries(data.metrics)) {
    if (metric.type === "trend") {
      const vals = metric.values;
      output += `  ${name.padEnd(42)}: avg=${vals.avg ? vals.avg.toFixed(1) : 0}ms p(50)=${vals.med ? vals.med.toFixed(1) : 0}ms p(95)=${vals["p(95)"] ? vals["p(95)"].toFixed(1) : 0}ms max=${vals.max ? vals.max.toFixed(1) : 0}ms\n`;
    } else if (metric.type === "rate") {
      output += `  ${name.padEnd(42)}: ${(metric.values.rate * 100).toFixed(2)}%\n`;
    } else if (metric.type === "counter") {
      output += `  ${name.padEnd(42)}: ${metric.values.count} (${metric.values.rate ? metric.values.rate.toFixed(1) : 0}/s)\n`;
    }
  }

  output += "\nTHRESHOLDS & REGRESSION GATES:\n";
  let allPassed = true;
  for (const [name, metric] of Object.entries(data.metrics)) {
    if (metric.thresholds) {
      for (const [rule, result] of Object.entries(metric.thresholds)) {
        const mark = result.ok ? "✓ PASS" : "✗ FAIL";
        if (!result.ok) allPassed = false;
        output += `  ${mark} [${name}] ${rule}\n`;
      }
    }
  }

  output += `\nOVERALL BENCHMARK RESULT: ${allPassed ? "PASS (All thresholds satisfied)" : "FAIL (Regression detected - exit code 99)"}\n`;
  output += "=======================================================\n";
  return output;
}

/**
 * Standard k6 handleSummary callback for automated CI artifact export and console logging.
 */
export function handleSummary(data) {
  const summaryPath = __ENV.SUMMARY_PATH || "load/summary.json";
  return {
    [summaryPath]: JSON.stringify(data, null, 2),
    stdout: formatConsoleSummary(data),
  };
}
