import http from "node:http";
import {
  computeEventHash,
  ULID_REGEX,
  type LeasePayload,
} from "@synapsestate/lease";
import {
  refreshSeedData,
  getCurrentSeed,
  type SeedDataResult,
} from "./seed-data.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

interface MockLeaseItem {
  payload: LeasePayload;
  sig: string;
  state: string;
}

let currentData = getCurrentSeed();
function initLeasesStore(seed: SeedDataResult): MockLeaseItem[] {
  return [
    {
      ...JSON.parse(JSON.stringify(seed.activeLeaseEnvelope)),
      state: "ACTIVE",
    },
    {
      ...JSON.parse(JSON.stringify(seed.nearExpiryLeaseEnvelope)),
      state: "ACTIVE",
    },
    {
      ...JSON.parse(JSON.stringify(seed.expiredLeaseEnvelope)),
      state: "EXPIRED",
    },
  ];
}

let leasesStore = initLeasesStore(currentData);
const promotedLeases = new Set<string>();

function resetStore() {
  currentData = refreshSeedData();
  leasesStore = initLeasesStore(currentData);
  promotedLeases.clear();
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost:3000"}`,
  );
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PUT, DELETE",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, If-None-Match, x-synapse-csrf",
  );

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mode: "mock-control-server" }));
    return;
  }

  // Test state reset endpoint (PR 27 test isolation)
  if (pathname === "/__test/reset" && method === "POST") {
    resetStore();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "reset",
        active_leases_count: leasesStore.length,
      }),
    );
    return;
  }

  // SDK State Delivery
  if (pathname === "/v1/sdk/state") {
    const env = url.searchParams.get("env") || "prod";
    const filtered = leasesStore.filter(
      (l) => l.payload.env === env && l.state === "ACTIVE",
    );
    res.writeHead(200, {
      "Content-Type": "application/json",
      ETag: '"mock-seed-etag-v1"',
    });
    res.end(
      JSON.stringify({
        etag: "mock-seed-etag-v1",
        server_time: new Date().toISOString(),
        registry_version: 1,
        active_leases: filtered.map(({ payload, sig }) => ({ payload, sig })),
      }),
    );
    return;
  }

  // Leases list for Dashboard
  if (pathname === "/v1/leases" && (method === "GET" || method === "HEAD")) {
    const env = url.searchParams.get("env") || "prod";
    const filtered = leasesStore.filter((l) => l.payload.env === env);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ leases: filtered }));
    return;
  }

  // Ingest or Record Audit Event (POST) - Evaluated before GET to avoid route shadowing
  if (pathname === "/v1/audit/events" && method === "POST") {
    let bodyStr = "";
    req.on("data", (chunk) => {
      bodyStr += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(bodyStr || "{}");
        const prev =
          currentData.auditEvents[currentData.auditEvents.length - 1];
        const seq = currentData.auditEvents.length + 1;
        const prevHash = prev?.hash || "0".repeat(64);
        const eventRecord = {
          seq,
          event_type: parsed.eventType || "DASHBOARD_AUDIT_STAGED",
          actor: parsed.actor || "ops-sre-lead",
          ts: new Date().toISOString(),
          payload: parsed.payload || {},
        };
        const hash = computeEventHash(prevHash, eventRecord);
        currentData.auditEvents.push({
          ...eventRecord,
          prev_hash: prevHash,
          hash,
        });
      } catch {
        // Ignore json parse error in mock server
      }
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ success: true, status: "staged", staged: true }),
      );
    });
    return;
  }

  // Audit Events list (GET)
  if (
    pathname === "/v1/audit/events" &&
    (method === "GET" || method === "HEAD")
  ) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        events: currentData.auditEvents,
        total: currentData.auditEvents.length,
        has_more: false,
      }),
    );
    return;
  }

  // Latest Checkpoint
  if (pathname === "/v1/audit/checkpoint/latest") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(currentData.checkpoint));
    return;
  }

  // Changes & Telemetry Rollups
  if (pathname === "/v1/changes") {
    const env = url.searchParams.get("env") || "prod";
    const flagKey = url.searchParams.get("flag_key");
    let evals = env === "prod" ? currentData.flagEvaluations : [];
    if (flagKey) {
      evals = evals.filter((e) => e.flag_key === flagKey);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        query: { env },
        events: [],
        evaluations: evals,
      }),
    );
    return;
  }

  // Revoke Lease
  if (
    pathname.startsWith("/v1/leases/") &&
    pathname.endsWith("/revoke") &&
    method === "POST"
  ) {
    const authHeader = req.headers["authorization"] || "";
    const expectedToken =
      process.env.SYNAPSE_API_TOKEN || "synapse-e2e-master-token-value-2026";
    if (
      !authHeader.startsWith("Bearer ") ||
      authHeader.slice(7) !== expectedToken
    ) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "UNAUTHORIZED",
          message: "Missing or invalid Bearer token",
        }),
      );
      return;
    }

    const leaseId = pathname.split("/")[3];
    if (!ULID_REGEX.test(leaseId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "INVALID_LEASE_ID",
          message: "Invalid ULID format",
        }),
      );
      return;
    }

    const target = leasesStore.find((l) => l.payload.lease_id === leaseId);
    if (!target) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "NOT_FOUND",
          message: `Lease "${leaseId}" not found`,
        }),
      );
      return;
    }

    target.state = "REVOKED";
    const prev = currentData.auditEvents[currentData.auditEvents.length - 1];
    const seq = currentData.auditEvents.length + 1;
    const prevHash = prev?.hash || "0".repeat(64);
    const eventRecord = {
      seq,
      event_type: "LEASE_REVOKED",
      actor: "ops-sre-lead",
      ts: new Date().toISOString(),
      payload: { lease_id: leaseId },
    };
    const hash = computeEventHash(prevHash, eventRecord);
    currentData.auditEvents.push({
      ...eventRecord,
      prev_hash: prevHash,
      hash,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        lease_id: leaseId,
        state: "REVOKED",
        revoked_at: new Date().toISOString(),
      }),
    );
    return;
  }

  // Promote Lease
  if (
    pathname.startsWith("/v1/leases/") &&
    pathname.endsWith("/promote") &&
    method === "POST"
  ) {
    const authHeader = req.headers["authorization"] || "";
    const expectedToken =
      process.env.SYNAPSE_API_TOKEN || "synapse-e2e-master-token-value-2026";
    if (
      !authHeader.startsWith("Bearer ") ||
      authHeader.slice(7) !== expectedToken
    ) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "UNAUTHORIZED",
          message: "Missing or invalid Bearer token",
        }),
      );
      return;
    }

    const leaseId = pathname.split("/")[3];
    if (!ULID_REGEX.test(leaseId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "INVALID_LEASE_ID",
          message: "Invalid ULID format",
        }),
      );
      return;
    }

    const target = leasesStore.find((l) => l.payload.lease_id === leaseId);
    if (!target) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "NOT_FOUND",
          message: `Lease "${leaseId}" not found`,
        }),
      );
      return;
    }

    if (promotedLeases.has(leaseId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "STALE_PR_CONFLICT",
          message: `Cannot promote lease "${leaseId}": lease is already in state "PROMOTED"`,
          existing_pr_url: `https://github.com/adityapawar112/SynapseState/pull/123`,
          promote_pr_url: `https://github.com/adityapawar112/SynapseState/pull/123`,
        }),
      );
      return;
    }

    promotedLeases.add(leaseId);
    const prev = currentData.auditEvents[currentData.auditEvents.length - 1];
    const seq = currentData.auditEvents.length + 1;
    const prevHash = prev?.hash || "0".repeat(64);
    const eventRecord = {
      seq,
      event_type: "LEASE_PROMOTED",
      actor: "ops-sre-lead",
      ts: new Date().toISOString(),
      payload: { lease_id: leaseId },
    };
    const hash = computeEventHash(prevHash, eventRecord);
    currentData.auditEvents.push({
      ...eventRecord,
      prev_hash: prevHash,
      hash,
    });

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        lease_id: leaseId,
        branch: `synapse/promote-lease-${leaseId}`,
        pr_url: `https://github.com/adityapawar112/SynapseState/pull/123`,
      }),
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "NOT_FOUND", path: pathname }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[MockControlServer] Listening on http://localhost:${PORT}`);
});
