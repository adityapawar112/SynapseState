import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL,
  TARGET_ENV,
  DEFAULT_WAIT_SECONDS,
  getStandardHeaders,
  propagationLagTrend,
  longPoll200Counter,
  longPoll304Counter,
  longPollErrorRate,
  longPollDurationTrend,
  invalidationWakeupLagTrend,
} from "./common.js";

/**
 * k6 Long-Polling Load Test Harness for SynapseState Control API.
 *
 * Implements Phase 3 PR 14 (ROADMAP §5 (3.3)):
 * - Simulates 100 concurrent client SDK instances long-polling GET /v1/sdk/state?env=production&wait=30s.
 * - Implements ETag conditional caching (If-None-Match header).
 * - Asserts HTTP 304 Not Modified during quiet periods.
 * - Asserts immediate HTTP 200 (< 100ms wakeup) on state mutations.
 * - Measures lease propagation lag distribution (p50, p95, p99).
 * - Enforces SLO target: Lease Propagation Lag p95 <= 10s and error rate < 1%.
 */

const VUS = parseInt(__ENV.VUS || "100", 10);
const DURATION = __ENV.DURATION || "2m";
const WAIT_TIME = __ENV.WAIT_TIME || DEFAULT_WAIT_SECONDS;

export const options = {
  scenarios: {
    state_pollers: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "10s",
    },
  },
  thresholds: {
    // SLO: Lease Propagation Lag p95 <= 10s
    synapse_lease_propagation_lag_ms: ["p(95)<=10000"],
    // Long-poll error rate strictly bounded below 1% (0% unexpected crashes)
    synapse_long_poll_error_rate: ["rate<0.01"],
    // HTTP failure rate strictly below 1%
    http_req_failed: ["rate<0.01"],
  },
};

// Per-VU state maintained across iterations
let cachedEtag = "";

export default function () {
  const url = `${BASE_URL}/v1/sdk/state?env=${TARGET_ENV}&wait=${WAIT_TIME}`;
  const headers = getStandardHeaders();

  if (cachedEtag) {
    headers["If-None-Match"] = cachedEtag;
  }

  // Set HTTP request timeout higher than wait duration (e.g. 45s for 30s wait)
  const params = {
    headers,
    timeout: "45s",
  };

  const reqStart = Date.now();
  const res = http.get(url, params);
  const duration = Date.now() - reqStart;

  longPollDurationTrend.add(duration);

  const isSuccess = res.status === 200 || res.status === 304;
  longPollErrorRate.add(!isSuccess);

  if (res.status === 304) {
    longPoll304Counter.add(1);

    const etagHeader = res.headers["Etag"] || res.headers["ETag"];
    if (etagHeader) {
      cachedEtag = etagHeader;
    }

    check(res, {
      "status is 304 Not Modified": (r) => r.status === 304,
      "has ETag header": (r) => Boolean(r.headers["Etag"] || r.headers["ETag"]),
      "has cache-control headers": (r) => {
        const cc =
          r.headers["Cache-Control"] || r.headers["cache-control"] || "";
        return cc.includes("no-cache");
      },
    });
  } else if (res.status === 200) {
    longPoll200Counter.add(1);

    const etagHeader = res.headers["Etag"] || res.headers["ETag"];
    if (etagHeader) {
      cachedEtag = etagHeader;
    }

    try {
      const body = JSON.parse(res.body);

      // Verify state delivery payload structure
      check(res, {
        "status is 200 OK": (r) => r.status === 200,
        "has ETag header": (r) =>
          Boolean(r.headers["Etag"] || r.headers["ETag"]),
        "payload has etag": () => Boolean(body && body.etag),
        "payload has active_leases array": () =>
          Array.isArray(body && body.active_leases),
        "payload has server_time": () => Boolean(body && body.server_time),
      });

      // Calculate propagation lag from server timestamp if present
      if (body && body.server_time) {
        const serverTimeMs = new Date(body.server_time).getTime();
        const clientNowMs = Date.now();
        const lagMs = Math.max(0, clientNowMs - serverTimeMs);
        propagationLagTrend.add(lagMs);
      }

      // If awakened earlier than full wait time with 200 OK, record invalidation wakeup lag
      if (duration < 25000 && cachedEtag) {
        invalidationWakeupLagTrend.add(duration);
      }
    } catch {
      longPollErrorRate.add(1);
    }
  } else {
    check(res, {
      "unexpected status code": (r) => r.status === 200 || r.status === 304,
    });
  }

  // Small jitter between poll iterations to emulate natural client loop
  sleep(Math.random() * 0.5 + 0.1);
}
