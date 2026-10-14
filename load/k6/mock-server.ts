import http from "node:http";
import crypto from "node:crypto";

/**
 * Zero-Dependency Pure Node.js Mock Control API Server for k6 Load Testing.
 *
 * Implements architectural boundaries:
 * - Invariant 1: Fail-safe state delivery with ETag conditional validation and instant in-memory wake-up.
 * - Invariant 5: Zero-context privacy verification on telemetry batches.
 * - Bulkhead emulation: sheds load (HTTP 429) when telemetry concurrency exceeds bulkhead limit.
 */

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

interface ActiveLease {
  payload: {
    v: number;
    lease_id: string;
    env: string;
    flag_key: string;
    value: unknown;
    reason: string;
    issued_at: string;
    ttl_seconds: number;
    kid: string;
    nonce: string;
  };
  sig: string;
}

let currentRegistryVersion = 1;
const activeLeases = new Map<string, ActiveLease>();
let currentEtag = computeEtag();
const suspendedWaiters = new Set<() => void>();

function computeEtag(): string {
  const content = JSON.stringify({
    version: currentRegistryVersion,
    leases: Array.from(activeLeases.values()),
  });
  return crypto.createHash("sha256").update(content).digest("hex");
}

function notifyStateMutation() {
  currentRegistryVersion++;
  currentEtag = computeEtag();
  const waiters = Array.from(suspendedWaiters);
  suspendedWaiters.clear();
  for (const resume of waiters) {
    resume();
  }
}

const FORBIDDEN_CONTEXT_KEYS = new Set([
  "user_id",
  "userId",
  "user",
  "context",
  "attributes",
  "targeting_key",
  "targetingKey",
  "session_id",
  "sessionId",
  "targeting",
  "traits",
  "custom_attributes",
]);

let inFlightTelemetry = 0;
const MAX_CONCURRENT_TELEMETRY = 15; // Simulates 10-connection pool bulkhead

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
  headers: Record<string, string> = {},
) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag",
    ...headers,
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let acc = "";
    req.on("data", (chunk) => {
      acc += chunk;
    });
    req.on("end", () => resolve(acc));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(
    req.url || "/",
    `http://${req.headers.host || "127.0.0.1"}`,
  );
  const pathname = parsedUrl.pathname;

  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, If-None-Match, Authorization",
      "Access-Control-Expose-Headers": "ETag",
    });
    res.end();
    return;
  }

  // GET /health
  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { status: "ok", server_time: new Date().toISOString() });
    return;
  }

  // GET /v1/time
  if (req.method === "GET" && pathname === "/v1/time") {
    sendJson(res, 200, { server_time: new Date().toISOString() });
    return;
  }

  // GET /v1/sdk/state
  if (req.method === "GET" && pathname === "/v1/sdk/state") {
    const rawWait = parsedUrl.searchParams.get("wait");
    let waitSeconds = 0;
    if (rawWait) {
      const match = rawWait.match(/^(\d{1,2})s?$/);
      if (match) {
        waitSeconds = Math.min(parseInt(match[1], 10), 60);
      }
    }

    const ifNoneMatchHeader = req.headers["if-none-match"];
    const ifNoneMatch = ifNoneMatchHeader
      ? String(ifNoneMatchHeader).replace(/^W\//, "").replace(/"/g, "").trim()
      : null;

    const currentCleanEtag = currentEtag;

    // Immediate 200 if cold or client has outdated/no ETag
    if (!ifNoneMatch || ifNoneMatch !== currentCleanEtag) {
      sendJson(
        res,
        200,
        {
          etag: currentCleanEtag,
          server_time: new Date().toISOString(),
          registry_version: currentRegistryVersion,
          active_leases: Array.from(activeLeases.values()),
          revocations: [],
          key_revocations: [],
        },
        {
          ETag: `"${currentCleanEtag}"`,
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      );
      return;
    }

    // If wait=0, immediate 304 Not Modified
    if (waitSeconds <= 0) {
      res.writeHead(304, {
        ETag: `"${currentCleanEtag}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "ETag",
      });
      res.end();
      return;
    }

    // Suspend long-poll request
    let timer: NodeJS.Timeout | null = null;
    let hasCompleted = false;

    const complete = (status: 200 | 304) => {
      if (hasCompleted) return;
      hasCompleted = true;
      if (timer) clearTimeout(timer);

      if (status === 304) {
        res.writeHead(304, {
          ETag: `"${currentEtag}"`,
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "ETag",
        });
        res.end();
      } else {
        sendJson(
          res,
          200,
          {
            etag: currentEtag,
            server_time: new Date().toISOString(),
            registry_version: currentRegistryVersion,
            active_leases: Array.from(activeLeases.values()),
            revocations: [],
            key_revocations: [],
          },
          {
            ETag: `"${currentEtag}"`,
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        );
      }
    };

    const resumeCallback = () => complete(200);
    suspendedWaiters.add(resumeCallback);

    req.on("close", () => {
      suspendedWaiters.delete(resumeCallback);
      if (timer) clearTimeout(timer);
    });

    timer = setTimeout(() => {
      suspendedWaiters.delete(resumeCallback);
      complete(304);
    }, waitSeconds * 1000);
    return;
  }

  // POST /v1/telemetry/batches & POST /v1/telemetry/flags
  if (
    req.method === "POST" &&
    (pathname === "/v1/telemetry/batches" || pathname === "/v1/telemetry/flags")
  ) {
    const rawBody = await readBody(req);
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON payload" });
      return;
    }

    // Invariant 5: Zero-Context validation
    if (body && typeof body === "object") {
      for (const key of Object.keys(body)) {
        if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
          sendJson(res, 400, {
            error: `Zero-Context violation: batch contains forbidden context attribute "${key}"`,
          });
          return;
        }
      }
    }

    // Emulate bulkhead load shedding
    inFlightTelemetry++;
    try {
      if (inFlightTelemetry > MAX_CONCURRENT_TELEMETRY) {
        sendJson(res, 429, {
          error: "Too Many Requests",
          message:
            "Telemetry connection pool exhausted or timed out; load shed.",
        });
        return;
      }

      // Small async delay simulating DB upsert (5-10ms)
      await new Promise((r) => setTimeout(r, Math.random() * 8 + 4));

      const batchId = (body?.batch_id as string) || `batch-${Date.now()}`;
      sendJson(res, 202, {
        accepted: true,
        batch_id: batchId,
      });
      return;
    } finally {
      inFlightTelemetry--;
    }
  }

  // POST /v1/leases (Emergency Break-Glass Mutation)
  if (req.method === "POST" && pathname === "/v1/leases") {
    const rawBody = await readBody(req);
    let body: ActiveLease | null = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    if (!body || !body.payload || !body.payload.lease_id) {
      sendJson(res, 400, { error: "Invalid lease payload" });
      return;
    }

    activeLeases.set(body.payload.lease_id, body);
    notifyStateMutation();

    sendJson(res, 201, {
      status: "ACTIVE",
      lease_id: body.payload.lease_id,
      etag: currentEtag,
    });
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
});

server.listen(PORT, HOST, () => {
  console.log(
    `SynapseState mock control-api listening on http://${HOST}:${PORT}`,
  );
});
