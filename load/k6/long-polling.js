import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL,
  TARGET_ENV,
  DEFAULT_WAIT_SECONDS,
  createEmergencyLease,
  createEmergencyRevocation,
  getStandardHeaders,
  propagationLagTrend,
  longPoll200Counter,
  longPoll304Counter,
  longPollErrorRate,
  longPollDurationTrend,
  invalidationWakeupLagTrend,
  handleSummary,
} from "./common.js";

/**
 * k6 Long-Polling State Delivery Load Harness for SynapseState Control API.
 *
 * Implements Phase 3 PR 14 (ROADMAP §5 (3.3)):
 * - Drives 100 concurrent SDK long-polling instances against GET /v1/sdk/state.
 * - Handles If-None-Match conditional ETag caching.
 * - Verifies HTTP 304 Not Modified quiet-period holding.
 * - Enforces SLO 1: Lease propagation lag <= 10s (measured strictly via server_time - issued_at).
 * - Measures invalidation wakeup lag on lease mutations.
 */

const config = JSON.parse(open("./config.json"));

const VUS = parseInt(__ENV.VUS || "100", 10);
const DURATION = __ENV.DURATION || "2m";
const WAIT_TIME = __ENV.WAIT_TIME || DEFAULT_WAIT_SECONDS;
const INJECT_MUTATIONS = __ENV.INJECT_MUTATIONS === "true";

const scenarios = {
  state_pollers: {
    executor: "constant-vus",
    vus: VUS,
    duration: DURATION,
    exec: "pollState",
  },
};

if (INJECT_MUTATIONS) {
  scenarios.lease_mutator = {
    executor: "constant-vus",
    vus: 1,
    duration: DURATION,
    exec: "mutateLease",
    gracefulStop: "5s",
  };
}

export const options = {
  scenarios,
  thresholds: {
    // Invariant 1: State delivery availability must remain strictly >= 99% (< 1% error)
    synapse_long_poll_error_rate: config.thresholds.synapse_long_poll_error_rate,
    http_req_failed: ["rate<0.01"],
    // SLO: Propagation lag p95 <= 10s (server_time - issued_at)
    synapse_lease_propagation_lag_ms:
      config.thresholds.synapse_lease_propagation_lag_ms,
    // Tightened long-poll duration limit: for 30s wait, p95 must be <= 32s (preventing hidden slop)
    synapse_long_poll_duration_ms:
      config.thresholds.synapse_long_poll_duration_ms,
  },
};

// Per-VU cached ETag state and seen leases (isolated per Virtual User)
let cachedEtag = "";
const seenLeaseIds = new Set();

export function pollState() {
  const url = `${BASE_URL}/v1/sdk/state?env=${TARGET_ENV}&wait=${WAIT_TIME}`;
  const headers = getStandardHeaders();

  if (cachedEtag) {
    headers["If-None-Match"] = `"${cachedEtag}"`;
  }

  // Request timeout higher than wait duration
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

  // Normalize header case lookup (k6 normalizes to lowercase in some versions)
  const etagHeader =
    res.headers["Etag"] || res.headers["ETag"] || res.headers["etag"] || "";
  const cleanHeaderEtag = etagHeader.replace(/^W\//, "").replace(/"/g, "");

  if (res.status === 304) {
    longPoll304Counter.add(1);

    check(res, {
      "status is 304 Not Modified": (r) => r.status === 304,
      "304 ETag matches cached ETag": () =>
        !cleanHeaderEtag || cleanHeaderEtag === cachedEtag,
      "has cache-control headers": (r) => {
        const cc =
          r.headers["Cache-Control"] || r.headers["cache-control"] || "";
        return cc.includes("no-cache");
      },
    });
  } else if (res.status === 200) {
    longPoll200Counter.add(1);

    const etagChanged = Boolean(
      cachedEtag && cleanHeaderEtag && cleanHeaderEtag !== cachedEtag,
    );

    if (cleanHeaderEtag) {
      cachedEtag = cleanHeaderEtag;
    }

    try {
      const body = JSON.parse(res.body);

      // Verify state delivery payload structure
      check(res, {
        "status is 200 OK": (r) => r.status === 200,
        "has ETag header": () => Boolean(cleanHeaderEtag),
        "payload has etag": () => Boolean(body && body.etag),
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
            !seenLeaseIds.has(l.payload.lease_id),
        );

        for (const l of newLeases) {
          seenLeaseIds.add(l.payload.lease_id);
          const issuedAtMs = new Date(l.payload.issued_at).getTime();
          const lagMs = Math.max(0, serverTimeMs - issuedAtMs);
          propagationLagTrend.add(lagMs);
          invalidationWakeupLagTrend.add(lagMs);
        }
      } else if (body && Array.isArray(body.active_leases)) {
        // Mark baseline leases so cold-start pre-existing leases do not pollute invalidation lag
        for (const l of body.active_leases) {
          if (l?.payload?.lease_id) {
            seenLeaseIds.add(l.payload.lease_id);
          }
        }
      }
    } catch {
      longPollErrorRate.add(1);
    }
  } else {
    check(res, {
      "unexpected status code": (r) => r.status === 200 || r.status === 304,
    });
  }

  // Small jitter between poll iterations
  sleep(Math.random() * 0.4 + 0.1);
}

// Note: Module-level lease ID assumes a single mutator VU (vus: 1).
// If scaling mutator VUs in future scenarios, track lease IDs in a per-VU map or concurrent structure.
let activeLeaseId = null;

/**
 * Live Emergency Lease Mutator for invalidation wakeup benchmarking.
 * Cycles between emergency override injection and revocation to exercise bidirectional invalidations.
 */
export function mutateLease() {
  if (!activeLeaseId) {
    const lease = createEmergencyLease(
      TARGET_ENV,
      "killswitch-payment-v2",
      true,
      "INC-991: Automated load test override injection",
    );
    activeLeaseId = lease.payload.lease_id;
    const url = `${BASE_URL}/v1/leases`;
    const res = http.post(url, JSON.stringify(lease), {
      headers: getStandardHeaders(),
      timeout: "10s",
    });

    check(res, {
      "lease mutation accepted": (r) => r.status === 201 || r.status === 200,
    });
  } else {
    const revocation = createEmergencyRevocation(
      activeLeaseId,
      TARGET_ENV,
      "INC-991: Automated load test override revocation",
    );
    const url = `${BASE_URL}/v1/leases/${encodeURIComponent(activeLeaseId)}/revoke`;
    const res = http.post(url, JSON.stringify(revocation), {
      headers: getStandardHeaders(),
      timeout: "10s",
    });

    check(res, {
      "lease revocation accepted": (r) => r.status === 200 || r.status === 204,
    });

    activeLeaseId = null;
  }

  sleep(15);
}

export default function () {
  pollState();
}

export { handleSummary };
