import http from "node:http";
import {
  ALL_SEEDED_LEASES,
  SEEDED_FLAG_EVALUATIONS,
  SEEDED_AUDIT_EVENTS,
  SEEDED_CHECKPOINT,
} from "./seed-data.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

const leasesStore = [...ALL_SEEDED_LEASES];

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost:3000"}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, If-None-Match, x-synapse-csrf");

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

  // SDK State Delivery
  if (pathname === "/v1/sdk/state") {
    const env = url.searchParams.get("env") || "prod";
    const filtered = leasesStore.filter((l) => l.payload.env === env);
    res.writeHead(200, {
      "Content-Type": "application/json",
      ETag: `"etag-seed-${Date.now()}"`,
    });
    res.end(
      JSON.stringify({
        etag: "mock-seed-etag",
        server_time: new Date().toISOString(),
        registry_version: 1,
        active_leases: filtered,
      })
    );
    return;
  }

  // Audit Events
  if (pathname === "/v1/audit/events") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        events: SEEDED_AUDIT_EVENTS,
        total: SEEDED_AUDIT_EVENTS.length,
        has_more: false,
      })
    );
    return;
  }

  // Latest Checkpoint
  if (pathname === "/v1/audit/checkpoint/latest") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(SEEDED_CHECKPOINT));
    return;
  }

  // Changes & Telemetry Rollups
  if (pathname === "/v1/changes") {
    const env = url.searchParams.get("env") || "prod";
    const flagKey = url.searchParams.get("flag_key");
    let evals = env === "prod" ? SEEDED_FLAG_EVALUATIONS : [];
    if (flagKey) {
      evals = evals.filter((e) => e.flag_key === flagKey);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        query: { env },
        events: [],
        evaluations: evals,
      })
    );
    return;
  }

  // Ingest or Record Audit Event
  if (pathname === "/v1/audit/events" && method === "POST") {
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, staged: true }));
    return;
  }

  // Revoke Lease
  if (pathname.startsWith("/v1/leases/") && pathname.endsWith("/revoke") && method === "POST") {
    const leaseId = pathname.split("/")[3];
    const idx = leasesStore.findIndex((l) => l.payload.lease_id === leaseId);
    if (idx !== -1) {
      // Mark as revoked
      leasesStore.splice(idx, 1);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        lease_id: leaseId,
        state: "REVOKED",
        revoked_at: new Date().toISOString(),
      })
    );
    return;
  }

  // Promote Lease
  if (pathname.startsWith("/v1/leases/") && pathname.endsWith("/promote") && method === "POST") {
    const leaseId = pathname.split("/")[3];
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        lease_id: leaseId,
        branch: `synapse/promote-lease-${leaseId}`,
        pr_url: `https://github.com/adityapawar112/SynapseState/pull/123`,
      })
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "NOT_FOUND", path: pathname }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[MockControlServer] Listening on http://localhost:${PORT}`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
