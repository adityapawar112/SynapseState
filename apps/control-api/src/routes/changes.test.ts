import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { changeRoutes } from "./changes.js";
import { leasePool } from "../db/pool.js";
import { runMigrations } from "../db/migrator.js";

describe("Change Events Feed Route (GET /v1/changes)", () => {
  let app: FastifyInstance;
  const testEnv = "changes-test-env";
  const otherEnv = "changes-other-env";

  beforeAll(async () => {
    await runMigrations(leasePool);

    app = Fastify({ logger: false });
    await app.register(changeRoutes, { leasePool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await leasePool.query("DELETE FROM change_events WHERE env IN ($1, $2)", [
      testEnv,
      otherEnv,
    ]);
    await leasePool.query(
      "DELETE FROM flag_usage_daily WHERE env IN ($1, $2)",
      [testEnv, otherEnv],
    );
  });

  it("rejects request missing required env query parameter with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/changes",
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toMatch(/Missing required query parameter: env/i);
  });

  it("rejects request with invalid since format with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&since=invalid_time_span`,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toMatch(/Invalid duration or timestamp format/i);
  });

  it("returns change events filtered by env and since window", async () => {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // Insert events in testEnv
    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES 
         ('LEASE_CREATED', $1, 'flag-recent', 'sre-alice', $2, '{"value":false}'),
         ('LEASE_CREATED', $1, 'flag-old', 'sre-bob', $3, '{"value":true}')`,
      [testEnv, tenMinAgo, twoHoursAgo],
    );

    // Insert event in otherEnv (should be excluded)
    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES ('LEASE_CREATED', $1, 'flag-other', 'sre-carol', $2, '{"value":true}')`,
      [otherEnv, tenMinAgo],
    );

    // Query since 30m
    const res = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&since=30m`,
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload);
    expect(data.query.env).toBe(testEnv);
    expect(data.query.since).toBe("30m");
    expect(data.events).toHaveLength(1);
    expect(data.events[0].flag_key).toBe("flag-recent");
    expect(data.events[0].actor).toBe("sre-alice");
  });

  it("supports relative duration strings (30m, 2h, 1d) and ISO timestamps", async () => {
    const now = new Date();
    const fortyMinAgo = new Date(now.getTime() - 40 * 60 * 1000);
    const threeHoursAgo = new Date(now.getTime() - 3 * 3600 * 1000);

    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES 
         ('LEASE_CREATED', $1, 'flag-40m', 'sre-1', $2, '{}'),
         ('LEASE_REVOKED', $1, 'flag-3h', 'sre-2', $3, '{}')`,
      [testEnv, fortyMinAgo, threeHoursAgo],
    );

    // Query since 1h should see flag-40m, not flag-3h
    const res1h = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&since=1h`,
    });
    expect(res1h.statusCode).toBe(200);
    const body1h = JSON.parse(res1h.payload);
    expect(body1h.events).toHaveLength(1);
    expect(body1h.events[0].flag_key).toBe("flag-40m");

    // Query since 4h should see both
    const res4h = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&since=4h`,
    });
    expect(res4h.statusCode).toBe(200);
    const body4h = JSON.parse(res4h.payload);
    expect(body4h.events).toHaveLength(2);

    // Query with explicit ISO timestamp (e.g. 2 hours ago)
    const twoHoursAgoIso = new Date(
      now.getTime() - 2 * 3600 * 1000,
    ).toISOString();
    const resIso = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&since=${encodeURIComponent(twoHoursAgoIso)}`,
    });
    expect(resIso.statusCode).toBe(200);
    const bodyIso = JSON.parse(resIso.payload);
    expect(bodyIso.events).toHaveLength(1);
    expect(bodyIso.events[0].flag_key).toBe("flag-40m");
  });

  it("filters by optional flag_key query parameter", async () => {
    const now = new Date();
    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES 
         ('LEASE_CREATED', $1, 'target-flag', 'sre-1', $2, '{}'),
         ('LEASE_CREATED', $1, 'other-flag', 'sre-2', $2, '{}')`,
      [testEnv, now],
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&flag_key=target-flag`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].flag_key).toBe("target-flag");
  });

  it("orders events deterministically by occurred_at DESC, id DESC", async () => {
    const t0 = new Date("2026-10-13T08:00:00Z");
    const t1 = new Date("2026-10-13T08:30:00Z");

    // Two events at t1, one event at t0
    await leasePool.query(
      `INSERT INTO change_events (id, event_type, env, flag_key, actor, occurred_at, payload)
       VALUES 
         (1001, 'LEASE_CREATED', $1, 'flag-first', 'sre', $2, '{}'),
         (1002, 'LEASE_CREATED', $1, 'flag-second', 'sre', $3, '{}'),
         (1003, 'LEASE_REVOKED', $1, 'flag-third', 'sre', $3, '{}')`,
      [testEnv, t0, t1],
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&since=24h`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.events).toHaveLength(3);
    // At t1, id 1003 should appear before id 1002
    expect(body.events[0].id).toBe(1003);
    expect(body.events[1].id).toBe(1002);
    // t0 appears last
    expect(body.events[2].id).toBe(1001);
  });

  it("enforces limit constraints (default 50, maximum 200)", async () => {
    const now = new Date();
    // Insert 3 events
    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES 
         ('LEASE_CREATED', $1, 'flag-1', 'sre', $2, '{}'),
         ('LEASE_CREATED', $1, 'flag-2', 'sre', $2, '{}'),
         ('LEASE_CREATED', $1, 'flag-3', 'sre', $2, '{}')`,
      [testEnv, now],
    );

    // Limit 2
    const resLimit2 = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&limit=2`,
    });
    const bodyLimit2 = JSON.parse(resLimit2.payload);
    expect(bodyLimit2.events).toHaveLength(2);
    expect(bodyLimit2.query.limit).toBe(2);

    // Default limit
    const resDefault = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}`,
    });
    const bodyDefault = JSON.parse(resDefault.payload);
    expect(bodyDefault.query.limit).toBe(50);

    // Limit > 200 should be capped at 200
    const resOver = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&limit=500`,
    });
    const bodyOver = JSON.parse(resOver.payload);
    expect(bodyOver.query.limit).toBe(200);
  });

  it("includes evaluation counts from flag_usage_daily in response", async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES ('LEASE_CREATED', $1, 'checkout-v2', 'sre', $2, '{"value":false}')`,
      [testEnv, now],
    );

    await leasePool.query(
      `INSERT INTO flag_usage_daily (flag_key, env, service, variant, usage_date, eval_count, first_seen, last_seen)
       VALUES 
         ('checkout-v2', $1, 'checkout-service', 'false', $2, 1420, $3, $3),
         ('checkout-v2', $1, 'checkout-service', 'true', $2, 80, $3, $3)`,
      [testEnv, today, now],
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/changes?env=${testEnv}&service=checkout-service`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.evaluations).toBeDefined();
    expect(body.evaluations.length).toBeGreaterThanOrEqual(1);

    const falseVariant = body.evaluations.find(
      (e: { flag_key: string; variant: string; eval_count: number }) =>
        e.flag_key === "checkout-v2" && e.variant === "false",
    );
    expect(falseVariant).toBeDefined();
    expect(falseVariant.eval_count).toBe(1420);
  });
});
