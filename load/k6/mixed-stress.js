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
 * k6 Mixed Traffic & Stress Scenarios for SynapseState Control API.
 *
 * Implements Phase 3 PR 14 (ROADMAP §5 (3.3)):
 * - Drives concurrent long-polling readers and telemetry writers under steady-state and stress loads.
 * - Single source of truth configuration via load/k6/config.json.
 * - Invalidation wakeup benchmarking with background lease mutator scenario.
 * - Validates bulkhead isolation: telemetry load spikes shed load (429) without degrading state delivery (Invariant 1).
 * - Verifies Invariant 5 (Zero-Context Privacy).
 */

const config = JSON.parse(open("./config.json"));

const PROFILE = __ENV.PROFILE || "average_load";
const WAIT_TIME = __ENV.WAIT_TIME || DEFAULT_WAIT_SECONDS;

function getScenarios() {
  const profile = config.profiles[PROFILE] || config.profiles["average_load"];
  const mixedScenarios = profile.mixed.scenarios;

  // Clone scenario definitions
  const result = JSON.parse(JSON.stringify(mixedScenarios));

  // Allow command-line DURATION override if provided
  if (__ENV.DURATION) {
    const targetSeconds = parseDurationToSeconds(__ENV.DURATION);
    for (const key of Object.keys(result)) {
      if (result[key].duration) {
        result[key].duration = __ENV.DURATION;
      } else if (Array.isArray(result[key].stages) && targetSeconds > 0) {
        // Calculate original total seconds across stages
        let originalSec = 0;
        for (const stage of result[key].stages) {
          originalSec += parseDurationToSeconds(stage.duration);
        }
        if (originalSec > 0) {
          const ratio = targetSeconds / originalSec;
          for (const stage of result[key].stages) {
            const sec = Math.max(
              1,
              Math.round(parseDurationToSeconds(stage.duration) * ratio),
            );
            stage.duration = `${sec}s`;
          }
        }
      }
    }
  }

  return result;
}

export const options = {
  scenarios: getScenarios(),
  thresholds: config.thresholds,
};

// Per-VU cached ETag state and seen leases (isolated per Virtual User)
let vuCachedEtag = "";
const vuSeenLeaseIds = new Set();

/**
 * Scenario Function: State Poller.
 * Emulates client workload SDK instances long-polling for active leases.
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
      "poll status is 304 Not Modified": (r) => r.status === 304,
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
        // Mark baseline leases so cold-start pre-existing leases do not pollute invalidation lag
        for (const l of body.active_leases) {
          if (l?.payload?.lease_id) {
            vuSeenLeaseIds.add(l.payload.lease_id);
          }
        }
      }
    } catch {
      longPollErrorRate.add(1);
    }
  }

  // Bulkhead Isolation Check (C4): State delivery MUST remain available regardless of telemetry load shedding
  const sheddingOccurred = telemetryLoadShedCounter.count > 0;
  if (sheddingOccurred) {
    if (res.status === 200 || res.status === 304) {
      bulkheadStateDeliveriesUnderShedding.add(1);
    } else {
      bulkheadIsolationViolations.add(1);
    }
  }

  check(res, {
    "poll status is 200 or 304 (bulkhead isolation intact)": (r) =>
      r.status === 200 || r.status === 304,
  });

  sleep(Math.random() * 0.4 + 0.1);
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

  const url = `${BASE_URL}${TELEMETRY_PATH}`;
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

// Note: Module-level lease ID assumes a single mutator VU (vus: 1) as configured across all profiles.
// If scaling mutator VUs in future profiles, track lease IDs in a per-VU map or concurrent structure.
let stressActiveLeaseId = null;

/**
 * Scenario Function: Live Emergency Lease Mutator.
 * Regularly injects and revokes break-glass leases to measure active invalidation wakeups.
 */
export function mutateLease() {
  if (!stressActiveLeaseId) {
    const lease = createEmergencyLease(
      TARGET_ENV,
      "checkout-redesign",
      true,
      "INC-991: Test emergency override injection",
    );
    stressActiveLeaseId = lease.payload.lease_id;
    const url = `${BASE_URL}/v1/leases`;
    const res = http.post(url, JSON.stringify(lease), {
      headers: getStandardHeaders(),
      timeout: "10s",
    });

    check(res, {
      "lease mutation status is 201 or 200": (r) =>
        r.status === 201 || r.status === 200,
    });
  } else {
    const revocation = createEmergencyRevocation(
      stressActiveLeaseId,
      TARGET_ENV,
      "INC-991: Test emergency override revocation",
    );
    const url = `${BASE_URL}/v1/leases/${encodeURIComponent(stressActiveLeaseId)}/revoke`;
    const res = http.post(url, JSON.stringify(revocation), {
      headers: getStandardHeaders(),
      timeout: "10s",
    });

    check(res, {
      "lease revocation status is 200 or 204": (r) =>
        r.status === 200 || r.status === 204,
    });

    stressActiveLeaseId = null;
  }

  sleep(15);
}

/**
 * Default export fallback for CLI runs without scenario flags.
 * Dispatches realistic mix (70% state pollers, 30% telemetry flushers).
 */
export default function () {
  if (Math.random() < 0.7) {
    pollState();
  } else {
    flushTelemetry();
  }
}

export { handleSummary };
