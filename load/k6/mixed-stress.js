import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL,
  TARGET_ENV,
  DEFAULT_WAIT_SECONDS,
  SAMPLE_SERVICES,
  generateTelemetryBatch,
  getStandardHeaders,
  propagationLagTrend,
  longPoll200Counter,
  longPoll304Counter,
  longPollErrorRate,
  longPollDurationTrend,
  invalidationWakeupLagTrend,
  telemetrySuccessCounter,
  telemetryLoadShedCounter,
  telemetryErrorRate,
  telemetryBatchDurationTrend,
  telemetryEvaluationsCounter,
} from "./common.js";

/**
 * k6 Mixed Traffic & Stress Scenarios for SynapseState Control API.
 *
 * Implements Phase 3 PR 14 (ROADMAP §5 (3.3)):
 * - Drives concurrent long-polling readers (100 VUs) and telemetry writers (20-50 VUs).
 * - Simulates full production microservice topology under steady-state and stress loads.
 * - Validates bulkhead isolation: telemetry load spikes shed load (429) without degrading state delivery.
 * - Verifies Invariant 1 (Fail-Safe Hot Path) and Invariant 5 (Zero-Context Privacy).
 */

const PROFILE = __ENV.PROFILE || "average_load";
const WAIT_TIME = __ENV.WAIT_TIME || DEFAULT_WAIT_SECONDS;

function getScenarioConfig() {
  const defaultDuration = __ENV.DURATION || "30s";
  if (PROFILE === "smoke") {
    return {
      state_pollers: {
        executor: "constant-vus",
        vus: 5,
        duration: defaultDuration,
        exec: "pollState",
        gracefulStop: "5s",
      },
      telemetry_flushers: {
        executor: "constant-vus",
        vus: 2,
        duration: defaultDuration,
        exec: "flushTelemetry",
        gracefulStop: "5s",
      },
    };
  }

  if (PROFILE === "stress") {
    return {
      state_pollers: {
        executor: "ramping-vus",
        startVUs: 20,
        stages: [
          { duration: "30s", target: 100 },
          { duration: "1m", target: 200 },
          { duration: "30s", target: 250 },
          { duration: "30s", target: 50 },
        ],
        exec: "pollState",
        gracefulStop: "10s",
      },
      telemetry_flushers: {
        executor: "ramping-vus",
        startVUs: 10,
        stages: [
          { duration: "30s", target: 50 },
          { duration: "1m", target: 100 },
          { duration: "30s", target: 150 },
          { duration: "30s", target: 10 },
        ],
        exec: "flushTelemetry",
        gracefulStop: "10s",
      },
    };
  }

  if (PROFILE === "spike") {
    return {
      state_pollers: {
        executor: "ramping-vus",
        startVUs: 10,
        stages: [
          { duration: "10s", target: 10 },
          { duration: "10s", target: 250 },
          { duration: "30s", target: 250 },
          { duration: "10s", target: 10 },
          { duration: "10s", target: 10 },
        ],
        exec: "pollState",
        gracefulStop: "10s",
      },
      telemetry_flushers: {
        executor: "ramping-vus",
        startVUs: 5,
        stages: [
          { duration: "10s", target: 5 },
          { duration: "10s", target: 100 },
          { duration: "30s", target: 100 },
          { duration: "10s", target: 5 },
          { duration: "10s", target: 5 },
        ],
        exec: "flushTelemetry",
        gracefulStop: "10s",
      },
    };
  }

  // Default: average_load
  return {
    state_pollers: {
      executor: "constant-vus",
      vus: parseInt(__ENV.POLL_VUS || "100", 10),
      duration: __ENV.DURATION || "2m",
      exec: "pollState",
      gracefulStop: "10s",
    },
    telemetry_flushers: {
      executor: "constant-vus",
      vus: parseInt(__ENV.TELEMETRY_VUS || "20", 10),
      duration: __ENV.DURATION || "2m",
      exec: "flushTelemetry",
      gracefulStop: "10s",
    },
  };
}

export const options = {
  scenarios: getScenarioConfig(),
  thresholds: {
    // SLO: Lease Propagation Lag p95 <= 10s
    synapse_lease_propagation_lag_ms: ["p(95)<=10000"],
    // Long-poll error rate strictly < 1% (zero unexpected drops)
    synapse_long_poll_error_rate: ["rate<0.01"],
    // Telemetry error rate < 5% (allowing graceful 429 load shedding)
    synapse_telemetry_error_rate: ["rate<0.05"],
    // General HTTP failure rate < 5%
    http_req_failed: ["rate<0.05"],
  },
};

// Per-VU ETag cache for state polling
let vuCachedEtag = "";

/**
 * Scenario Function: State Polling Worker.
 * Emulates client SDK instances long-polling with ETag conditional validation.
 */
export function pollState() {
  const url = `${BASE_URL}/v1/sdk/state?env=${TARGET_ENV}&wait=${WAIT_TIME}`;
  const headers = getStandardHeaders();

  if (vuCachedEtag) {
    headers["If-None-Match"] = vuCachedEtag;
  }

  const reqStart = Date.now();
  const res = http.get(url, { headers, timeout: "45s" });
  const duration = Date.now() - reqStart;

  longPollDurationTrend.add(duration);

  const isSuccess = res.status === 200 || res.status === 304;
  longPollErrorRate.add(!isSuccess);

  if (res.status === 304) {
    longPoll304Counter.add(1);
    const etagHeader = res.headers["Etag"] || res.headers["ETag"];
    if (etagHeader) {
      vuCachedEtag = etagHeader;
    }
  } else if (res.status === 200) {
    longPoll200Counter.add(1);
    const etagHeader = res.headers["Etag"] || res.headers["ETag"];
    if (etagHeader) {
      vuCachedEtag = etagHeader;
    }

    try {
      const body = JSON.parse(res.body);
      if (body && body.server_time) {
        const serverTimeMs = new Date(body.server_time).getTime();
        const lagMs = Math.max(0, Date.now() - serverTimeMs);
        propagationLagTrend.add(lagMs);
      }
      if (duration < 25000 && vuCachedEtag) {
        invalidationWakeupLagTrend.add(duration);
      }
    } catch {
      longPollErrorRate.add(1);
    }
  }

  check(res, {
    "poll status is 200 or 304": (r) => r.status === 200 || r.status === 304,
  });

  sleep(Math.random() * 0.5 + 0.1);
}

/**
 * Scenario Function: Telemetry Batch Writer.
 * Emulates microservice SDKs flushing evaluation batches.
 */
export function flushTelemetry() {
  const service =
    SAMPLE_SERVICES[Math.floor(Math.random() * SAMPLE_SERVICES.length)];
  const { payload, totalEvals } = generateTelemetryBatch(
    service,
    TARGET_ENV,
    3,
  );

  const url = `${BASE_URL}/v1/telemetry/batches`;
  const headers = getStandardHeaders();
  const body = JSON.stringify(payload);

  const reqStart = Date.now();
  const res = http.post(url, body, { headers, timeout: "10s" });
  const duration = Date.now() - reqStart;

  telemetryBatchDurationTrend.add(duration);

  if (res.status === 202) {
    telemetrySuccessCounter.add(1);
    telemetryEvaluationsCounter.add(totalEvals);
    telemetryErrorRate.add(0);
  } else if (res.status === 429) {
    telemetryLoadShedCounter.add(1);
    telemetryErrorRate.add(0); // Graceful load shedding
  } else {
    telemetryErrorRate.add(1);
  }

  check(res, {
    "telemetry status is 202 or 429": (r) =>
      r.status === 202 || r.status === 429,
  });

  sleep(Math.random() * 0.3 + 0.1);
}

/**
 * Default export fallback for single-scenario runs or CLI execution.
 */
export default function () {
  pollState();
}
