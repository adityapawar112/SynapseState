import http from "node:http";
import crypto from "node:crypto";

/**
 * Zero-Dependency Pure Node.js Mock Control API Server for k6 Load Testing.
 *
 * Implements architectural boundaries:
 * - Invariant 1: Fail-safe state delivery with per-environment ETag conditional validation and instant in-memory wake-up.
 * - Invariant 5: Zero-context privacy verification on telemetry batches (top-level and nested item validation).
 * - Bulkhead emulation: simulates 10-connection PostgreSQL pool with queue timeout and HTTP 429 load shedding.
 * - RFC 8785 deterministic canonical JSON ETag hashing.
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

interface EnvState {
  version: number;
  activeLeases: Map<string, ActiveLease>;
  etag: string;
  waiters: Set<() => void>;
}

const envStates = new Map<string, EnvState>();

/**
 * RFC 8785 deterministic canonical JSON serializer for byte-identical ETag hashing.
 */
function canonicalize(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map(canonicalize).join(",") + "]";
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  return (
    "{" +
    sortedKeys
      .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
      .join(",") +
    "}"
  );
}

function computeEtagForState(state: EnvState): string {
  const content = canonicalize({
    version: state.version,
    leases: Array.from(state.activeLeases.values()),
  });
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getOrCreateEnvState(env: string): EnvState {
  let state = envStates.get(env);
  if (!state) {
    state = {
      version: 1,
      activeLeases: new Map<string, ActiveLease>(),
      etag: "",
      waiters: new Set<() => void>(),
    };
    state.etag = computeEtagForState(state);
    envStates.set(env, state);
  }
  return state;
}

function notifyStateMutation(env: string) {
  const state = getOrCreateEnvState(env);
  state.version++;
  state.etag = computeEtagForState(state);
  const waiters = Array.from(state.waiters);
  state.waiters.clear();
  for (const resume of waiters) {
    resume();
  }
}

// Invariant 5: Zero-Context Forbidden Attributes (mirrors production)
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

// Allowed keys mirroring production Zod schemas
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "instance_id",
  "batch_id",
  "window_start",
  "window_end",
  "metrics",
  "propagation_lag_ms",
  "dropped_count",
  "service",
  "service_name",
  "env",
  "sdk_version",
]);

const ALLOWED_METRIC_KEYS = new Set(["flag_key", "variant", "reason", "count"]);

/**
 * Bulkhead 10-Connection PostgreSQL Pool Simulation with queue timeout and 429 shedding.
 */
const MAX_CONCURRENT_TELEMETRY = 10;
const TELEMETRY_QUEUE_TIMEOUT_MS = 500;
const MAX_TELEMETRY_QUEUE_DEPTH = 50;

let activeTelemetryWorkers = 0;
const telemetryWaitQueue: Array<{
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}> = [];

function acquireTelemetrySlot(): Promise<void> {
  if (activeTelemetryWorkers < MAX_CONCURRENT_TELEMETRY) {
    activeTelemetryWorkers++;
    return Promise.resolve();
  }
  if (telemetryWaitQueue.length >= MAX_TELEMETRY_QUEUE_DEPTH) {
    return Promise.reject(new Error("TELEMETRY_POOL_OVERFLOW"));
  }
  return new Promise<void>((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const idx = telemetryWaitQueue.indexOf(entry);
        if (idx !== -1) {
          telemetryWaitQueue.splice(idx, 1);
        }
        reject(new Error("TELEMETRY_POOL_TIMEOUT"));
      }, TELEMETRY_QUEUE_TIMEOUT_MS),
    };
    telemetryWaitQueue.push(entry);
  });
}

function releaseTelemetrySlot(): void {
  const next = telemetryWaitQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  } else {
    activeTelemetryWorkers--;
  }
}

/**
 * Production-aligned wait parser (mirrors apps/control-api/src/routes/state.ts:14-25).
 */
function parseWaitSeconds(rawWait?: unknown): number {
  if (rawWait === undefined || rawWait === null || rawWait === "") {
    return 0;
  }
  const str = String(rawWait).trim().toLowerCase();
  const match = str.match(/^(\d{1,2})s?$/);
  if (!match) {
    return 0;
  }
  const parsed = parseInt(match[1], 10);
  return Math.min(Math.max(parsed, 0), 60);
}

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
    const env = parsedUrl.searchParams.get("env") || "production";
    const envState = getOrCreateEnvState(env);

    const waitSeconds = parseWaitSeconds(parsedUrl.searchParams.get("wait"));
    const ifNoneMatch = req.headers["if-none-match"];

    // Clean client ETag (strip W/ and quotes)
    let clientEtag = ifNoneMatch;
    if (clientEtag) {
      if (clientEtag.startsWith("W/")) {
        clientEtag = clientEtag.slice(2);
      }
      if (clientEtag.startsWith('"') && clientEtag.endsWith('"')) {
        clientEtag = clientEtag.slice(1, -1);
      }
    }

    const currentEtag = envState.etag;

    // If client ETag is absent or does not match current state, immediate 200 OK
    if (!clientEtag || clientEtag !== currentEtag) {
      sendJson(
        res,
        200,
        {
          etag: currentEtag,
          server_time: new Date().toISOString(),
          registry_version: envState.version,
          active_leases: Array.from(envState.activeLeases.values()),
          revocations: [],
          key_revocations: [],
        },
        {
          ETag: `"${currentEtag}"`,
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      );
      return;
    }

    // If wait=0, immediate 304 Not Modified
    if (waitSeconds <= 0) {
      res.writeHead(304, {
        ETag: `"${currentEtag}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "ETag",
      });
      res.end();
      return;
    }

    // Suspend long-poll request up to waitSeconds
    let timer: NodeJS.Timeout | null = null;
    let hasCompleted = false;

    const complete = (status: 200 | 304) => {
      if (hasCompleted) return;
      hasCompleted = true;
      if (timer) clearTimeout(timer);

      if (status === 304) {
        res.writeHead(304, {
          ETag: `"${envState.etag}"`,
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
            etag: envState.etag,
            server_time: new Date().toISOString(),
            registry_version: envState.version,
            active_leases: Array.from(envState.activeLeases.values()),
            revocations: [],
            key_revocations: [],
          },
          {
            ETag: `"${envState.etag}"`,
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        );
      }
    };

    const resumeCallback = () => complete(200);
    envState.waiters.add(resumeCallback);

    req.on("close", () => {
      // Guard against double clean-up when request already completed normally
      if (hasCompleted) return;
      envState.waiters.delete(resumeCallback);
      if (timer) clearTimeout(timer);
    });

    timer = setTimeout(() => {
      envState.waiters.delete(resumeCallback);
      complete(304);
    }, waitSeconds * 1000);
    return;
  }

  // POST /v1/telemetry/batches (Canonical ingestion route)
  if (req.method === "POST" && pathname === "/v1/telemetry/batches") {
    const rawBody = await readBody(req);
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON payload" });
      return;
    }

    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "Payload must be a JSON object" });
      return;
    }

    // Invariant 5: Top-level Zero-Context & unknown key validation
    for (const key of Object.keys(body)) {
      if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
        sendJson(res, 400, {
          error: `Zero-Context violation: batch contains forbidden context or targeting attribute "${key}"`,
        });
        return;
      }
      if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
        sendJson(res, 400, {
          error: `Unrecognized key in batch payload: "${key}"`,
        });
        return;
      }
    }

    // Invariant 5: Nested metrics item validation
    if (!Array.isArray(body.metrics)) {
      sendJson(res, 400, { error: "metrics must be an array" });
      return;
    }

    for (const item of body.metrics) {
      if (!item || typeof item !== "object") {
        sendJson(res, 400, { error: "metric item must be an object" });
        return;
      }
      for (const mKey of Object.keys(item)) {
        if (FORBIDDEN_CONTEXT_KEYS.has(mKey)) {
          sendJson(res, 400, {
            error: `Zero-Context violation: metric item contains forbidden context attribute "${mKey}"`,
          });
          return;
        }
        if (!ALLOWED_METRIC_KEYS.has(mKey)) {
          sendJson(res, 400, {
            error: `Unrecognized key in metric item: "${mKey}"`,
          });
          return;
        }
      }
    }

    // Acquire pool worker slot (bulkhead load shedding emulation)
    try {
      await acquireTelemetrySlot();
    } catch {
      sendJson(res, 429, {
        error: "Too Many Requests",
        message: "Telemetry connection pool exhausted or timed out; load shed.",
      });
      return;
    }

    try {
      // Simulate DB batch insert latency (4-10ms)
      await new Promise((r) => setTimeout(r, Math.random() * 6 + 4));

      const batchId = (body.batch_id as string) || `batch-${Date.now()}`;
      sendJson(res, 202, {
        accepted: true,
        batch_id: batchId,
      });
      return;
    } finally {
      releaseTelemetrySlot();
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

    const env = body.payload.env || "production";
    const envState = getOrCreateEnvState(env);

    envState.activeLeases.set(body.payload.lease_id, body);
    notifyStateMutation(env);

    sendJson(res, 201, {
      status: "ACTIVE",
      lease_id: body.payload.lease_id,
      etag: envState.etag,
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
