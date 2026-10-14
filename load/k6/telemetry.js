import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL,
  TARGET_ENV,
  TELEMETRY_PATH,
  SAMPLE_SERVICES,
  generateTelemetryBatch,
  getStandardHeaders,
  telemetrySuccessCounter,
  telemetryLoadShedCounter,
  telemetryErrorRate,
  telemetryBatchDurationTrend,
  telemetryEvaluationsCounter,
} from "./common.js";

/**
 * k6 High-Throughput Telemetry Ingestion Harness for SynapseState Control API.
 *
 * Implements Phase 3 PR 14 (ROADMAP §5 (3.3)):
 * - Simulates concurrent SDK clients flushing evaluation metrics batches.
 * - Enforces Invariant 5 (Zero-Context Privacy): only (flag_key, variant, reason, count).
 * - Benchmarks database batch upsert ingestion rate and bulkhead load-shedding response (429).
 * - Target endpoint is strictly canonical POST /v1/telemetry/batches.
 */

const VUS = parseInt(__ENV.VUS || "20", 10);
const DURATION = __ENV.DURATION;
const ENDPOINT_PATH = TELEMETRY_PATH;

const stagesConfig = DURATION
  ? [{ duration: DURATION, target: VUS }]
  : [
      { duration: "30s", target: VUS },
      { duration: "1m", target: VUS },
      { duration: "30s", target: 0 },
    ];

export const options = {
  scenarios: {
    telemetry_flushers: {
      executor: "ramping-vus",
      startVUs: Math.min(5, VUS),
      stages: stagesConfig,
      gracefulStop: "5s",
    },
  },
  thresholds: {
    // Under normal load, unhandled error rate must be < 5% (allowing graceful 429 load shedding)
    synapse_telemetry_error_rate: ["rate<0.05"],
    // 95% of successful batch writes should complete within 500ms
    synapse_telemetry_batch_duration_ms: ["p(95)<=500"],
  },
};

export default function () {
  const service =
    SAMPLE_SERVICES[Math.floor(Math.random() * SAMPLE_SERVICES.length)];
  const { payload, totalEvals } = generateTelemetryBatch(
    service,
    TARGET_ENV,
    4,
  );

  const url = `${BASE_URL}${ENDPOINT_PATH}`;
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

    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // JSON parse failure treated as error
    }

    check(res, {
      "status is 202 Accepted": (r) => r.status === 202,
      "response confirmed acceptance": () =>
        Boolean(parsed && parsed.accepted === true),
      "response contains batch_id": () =>
        Boolean(parsed && parsed.batch_id === payload.batch_id),
    });
  } else if (res.status === 429) {
    // Bulkhead connection pool load shedding (Invariant 5 & Arch §4.4)
    telemetryLoadShedCounter.add(1);
    telemetryErrorRate.add(0); // Graceful 429 is expected architectural behavior under saturation

    check(res, {
      "status is 429 Too Many Requests (bulkhead load shed)": (r) =>
        r.status === 429,
    });
  } else {
    telemetryErrorRate.add(1);

    check(res, {
      "unexpected status code": (r) => r.status === 202 || r.status === 429,
    });
  }

  // Realistic SDK flush cadence jitter
  sleep(Math.random() * 0.4 + 0.1);
}
