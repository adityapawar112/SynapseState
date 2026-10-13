import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { telemetryRoutes } from "./telemetry.js";
import { telemetryPool, leasePool } from "../db/pool.js";
import { runMigrations } from "../db/migrator.js";
import { generateUlid, type TelemetryBatchPayload } from "@synapsestate/sdk";

describe("Bulkhead Telemetry Ingestion Route (POST /v1/telemetry/batches)", () => {
  let app: FastifyInstance;
  const testEnv = "telemetry-test-env";
  const testService = "test-service";
  const sdkVersion = "0.1.0";

  beforeAll(async () => {
    await runMigrations(leasePool);

    app = Fastify({ logger: false });
    await app.register(telemetryRoutes, { telemetryPool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await leasePool.query("DELETE FROM flag_usage_daily WHERE env = $1", [
      testEnv,
    ]);
    await leasePool.query("DELETE FROM services WHERE env = $1", [testEnv]);
  });

  it("ingests valid TelemetryBatchPayload and returns HTTP 202 Accepted", async () => {
    const batchId = generateUlid();
    const now = new Date();
    const windowStart = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const windowEnd = now.toISOString();

    const payload: TelemetryBatchPayload & {
      service: string;
      env: string;
      sdk_version: string;
    } = {
      instance_id: "pod-checkout-test-1",
      batch_id: batchId,
      window_start: windowStart,
      window_end: windowEnd,
      service: testService,
      env: testEnv,
      sdk_version: sdkVersion,
      metrics: [
        {
          flag_key: "cart-cache",
          variant: "on",
          reason: "TARGETING_MATCH",
          count: 500,
        },
        {
          flag_key: "checkout-v2",
          variant: "false",
          reason: "OVERRIDE",
          count: 120,
        },
      ],
      propagation_lag_ms: 250,
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/telemetry/batches",
      headers: { "Content-Type": "application/json" },
      payload,
    });

    expect(res.statusCode).toBe(202);
    const resBody = JSON.parse(res.payload);
    expect(resBody.accepted).toBe(true);
    expect(resBody.batch_id).toBe(batchId);

    // Verify flag_usage_daily persistence
    const usageRows = await leasePool.query(
      "SELECT * FROM flag_usage_daily WHERE env = $1 ORDER BY flag_key ASC",
      [testEnv],
    );
    expect(usageRows.rows).toHaveLength(2);
    expect(usageRows.rows[0].flag_key).toBe("cart-cache");
    expect(Number(usageRows.rows[0].eval_count)).toBe(500);
    expect(usageRows.rows[1].flag_key).toBe("checkout-v2");
    expect(Number(usageRows.rows[1].eval_count)).toBe(120);

    // Verify services heartbeat persistence
    const serviceRows = await leasePool.query(
      "SELECT * FROM services WHERE name = $1 AND env = $2",
      [testService, testEnv],
    );
    expect(serviceRows.rows).toHaveLength(1);
    expect(serviceRows.rows[0].status).toBe("ACTIVE");
    expect(serviceRows.rows[0].sdk_version).toBe(sdkVersion);
  });

  it("correctly aggregates eval_count across successive batches on the same day", async () => {
    const today = new Date().toISOString();

    const sendBatch = async (count: number) => {
      const payload = {
        instance_id: "pod-1",
        batch_id: generateUlid(),
        window_start: today,
        window_end: today,
        service: testService,
        env: testEnv,
        sdk_version: sdkVersion,
        metrics: [
          {
            flag_key: "rate-limit-flag",
            variant: "enabled",
            reason: "DEFAULT",
            count,
          },
        ],
      };

      const res = await app.inject({
        method: "POST",
        url: "/v1/telemetry/batches",
        payload,
      });
      expect(res.statusCode).toBe(202);
    };

    // First batch: 100 evals
    await sendBatch(100);
    // Second batch: 250 evals
    await sendBatch(250);

    const usage = await leasePool.query(
      "SELECT eval_count FROM flag_usage_daily WHERE env = $1 AND flag_key = $2",
      [testEnv, "rate-limit-flag"],
    );
    expect(usage.rows).toHaveLength(1);
    expect(Number(usage.rows[0].eval_count)).toBe(350);
  });

  it("updates heartbeat and reactivates a SILENT service to ACTIVE", async () => {
    // Seed service as SILENT
    await leasePool.query(
      `INSERT INTO services (name, env, status, first_seen, last_seen, silent_since, sdk_version)
       VALUES ($1, $2, 'SILENT', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', '0.0.9')`,
      [testService, testEnv],
    );

    const payload = {
      instance_id: "pod-reactivated",
      batch_id: generateUlid(),
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      service: testService,
      env: testEnv,
      sdk_version: "0.1.0",
      metrics: [],
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/telemetry/batches",
      payload,
    });
    expect(res.statusCode).toBe(202);

    const serviceRows = await leasePool.query(
      "SELECT status, silent_since, sdk_version FROM services WHERE name = $1 AND env = $2",
      [testService, testEnv],
    );
    expect(serviceRows.rows[0].status).toBe("ACTIVE");
    expect(serviceRows.rows[0].silent_since).toBeNull();
    expect(serviceRows.rows[0].sdk_version).toBe("0.1.0");
  });

  it("strictly rejects batches containing unexpected or forbidden context attributes (Invariant 5)", async () => {
    // 1. Root level context attributes
    const rootViolation = {
      instance_id: "pod-test",
      batch_id: generateUlid(),
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      service: testService,
      env: testEnv,
      user_id: "user-12345", // FORBIDDEN
      metrics: [
        {
          flag_key: "flag-a",
          variant: "true",
          reason: "TARGETING_MATCH",
          count: 1,
        },
      ],
    };

    const res1 = await app.inject({
      method: "POST",
      url: "/v1/telemetry/batches",
      payload: rootViolation,
    });
    expect(res1.statusCode).toBe(400);
    const body1 = JSON.parse(res1.payload);
    expect(body1.error).toMatch(/Zero-Context violation|forbidden/i);

    // 2. Metric-item level targeting / context attributes
    const metricViolation = {
      instance_id: "pod-test",
      batch_id: generateUlid(),
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      service: testService,
      env: testEnv,
      metrics: [
        {
          flag_key: "flag-a",
          variant: "true",
          reason: "TARGETING_MATCH",
          count: 1,
          targeting_key: "user-999", // FORBIDDEN
        },
      ],
    };

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/telemetry/batches",
      payload: metricViolation,
    });
    expect(res2.statusCode).toBe(400);
    const body2 = JSON.parse(res2.payload);
    expect(body2.error).toMatch(
      /Zero-Context violation|forbidden|unrecognized_keys/i,
    );

    // 3. Metric-item level generic 'context' object
    const contextViolation = {
      instance_id: "pod-test",
      batch_id: generateUlid(),
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      service: testService,
      env: testEnv,
      context: { country: "US" }, // FORBIDDEN
      metrics: [],
    };

    const res3 = await app.inject({
      method: "POST",
      url: "/v1/telemetry/batches",
      payload: contextViolation,
    });
    expect(res3.statusCode).toBe(400);
  });

  it("sorts metrics deterministically and avoids row-lock deadlocks under concurrent batch ingestion", async () => {
    // Generate batches with overlapping flags in opposite order
    const makeBatch = (flagsInOrder: string[]) => ({
      instance_id: `pod-concurrent-${Math.random()}`,
      batch_id: generateUlid(),
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      service: testService,
      env: testEnv,
      sdk_version: sdkVersion,
      metrics: flagsInOrder.map((flag_key) => ({
        flag_key,
        variant: "v1",
        reason: "MATCH",
        count: 10,
      })),
    });

    const flagsForward = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const flagsReverse = [...flagsForward].reverse();

    // Fire 6 concurrent batches with alternating orders
    const promises = [
      app.inject({
        method: "POST",
        url: "/v1/telemetry/batches",
        payload: makeBatch(flagsForward),
      }),
      app.inject({
        method: "POST",
        url: "/v1/telemetry/batches",
        payload: makeBatch(flagsReverse),
      }),
      app.inject({
        method: "POST",
        url: "/v1/telemetry/batches",
        payload: makeBatch(flagsForward),
      }),
      app.inject({
        method: "POST",
        url: "/v1/telemetry/batches",
        payload: makeBatch(flagsReverse),
      }),
      app.inject({
        method: "POST",
        url: "/v1/telemetry/batches",
        payload: makeBatch(flagsForward),
      }),
      app.inject({
        method: "POST",
        url: "/v1/telemetry/batches",
        payload: makeBatch(flagsReverse),
      }),
    ];

    const responses = await Promise.all(promises);
    for (const res of responses) {
      expect(res.statusCode).toBe(202);
    }

    // Verify all 5 flags aggregated 6 * 10 = 60 evals
    const rows = await leasePool.query(
      "SELECT flag_key, eval_count FROM flag_usage_daily WHERE env = $1 ORDER BY flag_key ASC",
      [testEnv],
    );
    expect(rows.rows).toHaveLength(5);
    for (const row of rows.rows) {
      expect(Number(row.eval_count)).toBe(60);
    }
  });

  it("sheds load with HTTP 429 when telemetryPool connection times out", async () => {
    // Create an app instance with a mock exhausted telemetry pool that throws a connection timeout
    const mockExhaustedPool = {
      connect: async () => {
        const timeoutErr = new Error("timeout exceeded when trying to connect");
        (timeoutErr as unknown as { code: string }).code = "ETIMEDOUT";
        throw timeoutErr;
      },
    } as unknown as Pool;

    const sheddingApp = Fastify({ logger: false });
    await sheddingApp.register(telemetryRoutes, {
      telemetryPool: mockExhaustedPool,
    });
    await sheddingApp.ready();

    const payload = {
      instance_id: "pod-1",
      batch_id: generateUlid(),
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      service: testService,
      env: testEnv,
      metrics: [
        {
          flag_key: "checkout-v2",
          variant: "on",
          reason: "DEFAULT",
          count: 10,
        },
      ],
    };

    const res = await sheddingApp.inject({
      method: "POST",
      url: "/v1/telemetry/batches",
      payload,
    });

    expect([429, 503]).toContain(res.statusCode);
    const body = JSON.parse(res.payload);
    expect(body.error).toMatch(/Too Many Requests|Service Unavailable/i);

    await sheddingApp.close();
  });

  it("handles empty metrics array gracefully as a heartbeat-only flush", async () => {
    const payload = {
      instance_id: "pod-heartbeat",
      batch_id: generateUlid(),
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      service: "heartbeat-only-service",
      env: testEnv,
      sdk_version: "0.1.0",
      metrics: [],
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/telemetry/batches",
      payload,
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.payload);
    expect(body.accepted).toBe(true);

    const serviceRows = await leasePool.query(
      "SELECT * FROM services WHERE name = $1 AND env = $2",
      ["heartbeat-only-service", testEnv],
    );
    expect(serviceRows.rows).toHaveLength(1);
    expect(serviceRows.rows[0].status).toBe("ACTIVE");

    const usageRows = await leasePool.query(
      "SELECT * FROM flag_usage_daily WHERE env = $1",
      [testEnv],
    );
    expect(usageRows.rows).toHaveLength(0);
  });
});
