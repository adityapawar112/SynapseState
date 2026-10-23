import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL,
  TARGET_ENV,
  DEFAULT_WAIT_SECONDS,
  TELEMETRY_PATH,
  SAMPLE_SERVICES,
  generateTelemetryBatch,
  createEmergencyLease,
  createEmergencyRevocation,
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
  bulkheadIsolationViolations,
  bulkheadStateDeliveriesUnderShedding,
  parseDurationToSeconds,
  handleSummary,
} from "./common.js";

/**
 * Standardized 4-Phase Story Arc Traffic Orchestration for SynapseState.
 *
 * Implements Phase 8 PR 30 (ROADMAP §8.1 & §8.2):
 * - Phase 1: Steady-State Baseline: 100 concurrent SDKs long-polling with ETag caching (95%+ HTTP 304, 0 active leases).
 * - Phase 2: 2 AM Incident Break-Glass Override: SRE signs emergency lease, Control API broadcasts invalidation (<500ms wakeup, <=10s lag SLO).
 * - Phase 3: Bulkhead Saturation & Load-Shedding: High-volume telemetry batch flushes (5,000+ evals/s, 429 shedding, 0 state drops).
 * - Phase 4: Graceful Expiry & Revocation: Lease revoked, active leases count returns to 0, returns to quiet 304 baseline.
 */

// Timing and scale configuration
const VUS = parseInt(__ENV.VUS || "100", 10);
const TELEMETRY_VUS = parseInt(__ENV.TELEMETRY_VUS || "50", 10);
const WAIT_TIME = __ENV.WAIT_TIME || DEFAULT_WAIT_SECONDS;

const totalSec = parseDurationToSeconds(__ENV.DURATION, 150);
// Phase boundary proportions: Phase 1 (20%), Phase 2 (20%), Phase 3 (40%), Phase 4 (remaining ~20%)
const p1Sec = Math.max(5, Math.round(totalSec * 0.2));
const p2Sec = Math.max(5, Math.round(totalSec * 0.2));
const p3Sec = Math.max(10, Math.round(totalSec * 0.4));

const phase2Start = `${p1Sec}s`;
const phase3Start = `${p1Sec + p2Sec}s`;
const phase4Start = `${p1Sec + p2Sec + p3Sec}s`;
const totalDurationStr = `${totalSec}s`;

export const options = {
  scenarios: {
    // Continuous state delivery fleet across all 4 phases
    state_delivery_fleet: {
      executor: "constant-vus",
      vus: VUS,
      duration: totalDurationStr,
      exec: "pollState",
      gracefulStop: "10s",
    },
    // Phase 2: Injects emergency override at phase 2 start
    incident_break_glass: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      startTime: phase2Start,
      exec: "injectBreakGlassLease",
      gracefulStop: "5s",
    },
    // Phase 3: High-throughput telemetry saturation burst
    bulkhead_saturation_telemetry: {
      executor: "ramping-vus",
      startVUs: Math.min(10, TELEMETRY_VUS),
      stages: [
        { duration: `${Math.round(p3Sec * 0.2)}s`, target: TELEMETRY_VUS },
        { duration: `${Math.round(p3Sec * 0.6)}s`, target: TELEMETRY_VUS },
        { duration: `${Math.round(p3Sec * 0.2)}s`, target: 0 },
      ],
      startTime: phase3Start,
      exec: "flushBurstTelemetry",
      gracefulStop: "10s",
    },
    // Phase 4: Revokes emergency override at phase 4 start
    incident_revocation: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      startTime: phase4Start,
      exec: "revokeBreakGlassLease",
      gracefulStop: "5s",
    },
  },
  thresholds: {
    // SLO 1: Lease propagation lag p95 <= 10s (measured via server_time - issued_at)
    synapse_lease_propagation_lag_ms: ["p(95)<=10000"],
    // Invariant 1: State delivery availability must remain strictly >= 99%
    synapse_long_poll_error_rate: ["rate<0.01"],
    // Invariant 1 & Bulkhead Isolation: Zero state delivery failures during telemetry 429 shedding
    synapse_bulkhead_isolation_violations: ["count===0"],
    // Handled telemetry error rate (< 5% unhandled; 429 is expected bulkhead behavior)
    synapse_telemetry_error_rate: ["rate<0.05"],
    // Standard k6 http failure rate (< 1%)
    http_req_failed: ["rate<0.01"],
  },
};

// Global shared state for break-glass incident (recorded on successful Phase 2 injection)
let recordedLeaseId = null;

// Per-VU caching for ETag validation
let vuCachedEtag = "";
const vuSeenLeaseIds = new Set();

/**
 * State Delivery Worker: Emulates concurrent application SDKs long-polling state.
 */
export function pollState() {
  const url = `${BASE_URL}/v1/sdk/state?env=${TARGET_ENV}&wait=${WAIT_TIME}`;
  const headers = getStandardHeaders();

  if (vuCachedEtag) {
    headers["If-None-Match"] = `"${vuCachedEtag}"`;
  }

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

  // Normalize header case lookup
  const etagHeader =
    res.headers["Etag"] || res.headers["ETag"] || res.headers["etag"] || "";
  const cleanHeaderEtag = etagHeader.replace(/^W\//, "").replace(/"/g, "");

  if (res.status === 304) {
    longPoll304Counter.add(1);

    check(res, {
      "304 Not Modified received": (r) => r.status === 304,
      "304 ETag matches cached ETag": () =>
        !cleanHeaderEtag || cleanHeaderEtag === vuCachedEtag,
    });
  } else if (res.status === 200) {
    longPoll200Counter.add(1);

    const etagChanged = Boolean(
      vuCachedEtag && cleanHeaderEtag && cleanHeaderEtag !== vuCachedEtag,
    );

    if (cleanHeaderEtag) {
      vuCachedEtag = cleanHeaderEtag;
    }

    try {
      const body = JSON.parse(res.body);

      // Verify state payload schema
      check(res, {
        "200 OK state delivery received": (r) => r.status === 200,
        "payload has active_leases array": () =>
          Array.isArray(body && body.active_leases),
        "payload has server_time": () => Boolean(body && body.server_time),
      });

      // Calculate propagation lag strictly on awakened lease delivery (when ETag changes)
      if (
        etagChanged &&
        body &&
        body.server_time &&
        Array.isArray(body.active_leases) &&
        body.active_leases.length > 0
      ) {
        const serverTimeMs = new Date(body.server_time).getTime();
        const newLeases = body.active_leases.filter(
          (l) =>
            l &&
            l.payload &&
            l.payload.lease_id &&
            !vuSeenLeaseIds.has(l.payload.lease_id),
        );

        for (const l of newLeases) {
          vuSeenLeaseIds.add(l.payload.lease_id);
          const issuedAtMs = new Date(l.payload.issued_at).getTime();
          const lagMs = Math.max(0, serverTimeMs - issuedAtMs);
          propagationLagTrend.add(lagMs);
          invalidationWakeupLagTrend.add(lagMs);
        }
      } else if (body && Array.isArray(body.active_leases)) {
        for (const l of body.active_leases) {
          if (l?.payload?.lease_id) {
            vuSeenLeaseIds.add(l.payload.lease_id);
          }
        }
      }
    } catch {
      longPollErrorRate.add(1);
    }
  } else {
    check(res, {
      "unexpected status code on state poll": (r) =>
        r.status === 200 || r.status === 304,
    });
  }

  // Bulkhead isolation invariant: state delivery MUST remain functional even when telemetry pool sheds 429
  if (telemetryLoadShedCounter.count > 0) {
    if (res.status === 200 || res.status === 304) {
      bulkheadStateDeliveriesUnderShedding.add(1);
    } else {
      bulkheadIsolationViolations.add(1);
    }
  }

  sleep(Math.random() * 0.4 + 0.1);
}

/**
 * Phase 2 Worker: Injects signed emergency override lease (2 AM incident simulation).
 */
export function injectBreakGlassLease() {
  const lease = createEmergencyLease(
    TARGET_ENV,
    "checkout-v2-flow",
    true,
    "INC-2041: 2 AM Emergency payment circuit breaker",
    "ops-primary-01",
  );

  const url = `${BASE_URL}/v1/leases`;
  const res = http.post(url, JSON.stringify(lease), {
    headers: getStandardHeaders(),
    timeout: "10s",
  });

  const success = res.status === 201 || res.status === 200;
  if (success && lease?.payload?.lease_id) {
    recordedLeaseId = lease.payload.lease_id;
  }

  check(res, {
    "Phase 2: Emergency override injected successfully": (r) =>
      r.status === 201 || r.status === 200,
  });
}

/**
 * Phase 3 Worker: High-volume telemetry batch flushes simulating fleet-wide saturation.
 */
export function flushBurstTelemetry() {
  const service =
    SAMPLE_SERVICES[Math.floor(Math.random() * SAMPLE_SERVICES.length)];
  const { payload, totalEvals } = generateTelemetryBatch(
    service,
    TARGET_ENV,
    25, // Large batch size to drive >5,000 evals/sec
  );

  const url = `${BASE_URL}${TELEMETRY_PATH}`;
  const res = http.post(url, JSON.stringify(payload), {
    headers: getStandardHeaders(),
    timeout: "10s",
  });

  telemetryBatchDurationTrend.add(res.timings.duration);

  if (res.status === 202) {
    telemetrySuccessCounter.add(1);
    telemetryEvaluationsCounter.add(totalEvals);
    telemetryErrorRate.add(0);
  } else if (res.status === 429) {
    // Bulkhead load-shedding is expected and verified under saturation
    telemetryLoadShedCounter.add(1);
    telemetryErrorRate.add(0);
  } else {
    telemetryErrorRate.add(1);
  }

  check(res, {
    "Phase 3: Telemetry accepted (202) or gracefully shed by bulkhead (429)": (
      r,
    ) => r.status === 202 || r.status === 429,
  });

  sleep(Math.random() * 0.2 + 0.05);
}

/**
 * Phase 4 Worker: Revokes emergency override lease, restoring baseline state.
 */
export function revokeBreakGlassLease() {
  let leaseIdToRevoke = recordedLeaseId;

  // In multi-scenario k6 runs where VUs do not share module JS state,
  // query the active leases inventory to resolve the lease injected in Phase 2
  if (!leaseIdToRevoke) {
    const listUrl = `${BASE_URL}/v1/leases?env=${TARGET_ENV}`;
    const listRes = http.get(listUrl, {
      headers: getStandardHeaders(),
      timeout: "10s",
    });
    if (listRes.status === 200) {
      try {
        const body = JSON.parse(listRes.body);
        const match = (body.leases || []).find(
          (l) => l?.payload?.flag_key === "checkout-v2-flow",
        );
        if (match?.payload?.lease_id) {
          leaseIdToRevoke = match.payload.lease_id;
        }
      } catch {
        // Fallback to null
      }
    }
  }

  if (!leaseIdToRevoke) {
    check(null, {
      "Phase 4: Emergency override revoked successfully": () => false,
    });
    return;
  }

  const revocation = createEmergencyRevocation(
    leaseIdToRevoke,
    TARGET_ENV,
    "INC-2041: Incident mitigated; emergency override recalled",
    "ops-primary-01",
  );

  const url = `${BASE_URL}/v1/leases/${encodeURIComponent(leaseIdToRevoke)}/revoke`;
  const res = http.post(url, JSON.stringify(revocation), {
    headers: getStandardHeaders(),
    timeout: "10s",
  });

  check(res, {
    "Phase 4: Emergency override revoked successfully": (r) =>
      r.status === 200 || r.status === 204,
  });
}

export default function () {
  pollState();
}

export { handleSummary };
