import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../app.js";
import { leasePool, closePools } from "../db/pool.js";
import { runMigrations } from "../db/migrator.js";
import { computeEventHash, GENESIS_PREV_HASH } from "@synapsestate/lease";

describe("Phase 4 PR 19: Audit Export Routes (apps/control-api/src/routes/audit.ts)", () => {
  let app: FastifyInstance;
  const masterToken = "test-master-audit-token";
  const auditReaderToken = "test-audit-reader-token";
  const unauthorizedToken = "test-unauthorized-token";

  beforeAll(async () => {
    await runMigrations(leasePool);

    process.env.SYNAPSE_API_TOKEN = masterToken;

    // Insert test api_tokens
    const readerHash = crypto
      .createHash("sha256")
      .update(auditReaderToken)
      .digest("hex");
    const unauthHash = crypto
      .createHash("sha256")
      .update(unauthorizedToken)
      .digest("hex");

    await leasePool.query(
      `INSERT INTO api_tokens (token_id, token_hash, service_name, env, roles)
       VALUES 
         ('audit-reader-id', $1, 'audit-scanner', 'production', ARRAY['audit_reader']),
         ('unauth-id', $2, 'metrics-fetcher', 'production', ARRAY['metrics_viewer'])
       ON CONFLICT (token_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, roles = EXCLUDED.roles`,
      [readerHash, unauthHash],
    );

    app = buildServer({ leasePool });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.SYNAPSE_API_TOKEN;
    if (app) {
      await app.close();
    }
    await closePools();
  });

  beforeEach(async () => {
    await leasePool.query("DELETE FROM audit_events");
    await leasePool.query("DELETE FROM audit_pending");
  });

  describe("GET /v1/audit/events Authentication & Authorization", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/events",
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("returns 401 when Bearer token is invalid", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/events",
        headers: {
          authorization: "Bearer wrong-token-12345",
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when token lacks operator, admin, or audit_reader role", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/events",
        headers: {
          authorization: `Bearer ${unauthorizedToken}`,
        },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("FORBIDDEN");
    });

    it("succeeds with master SYNAPSE_API_TOKEN", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/events",
        headers: {
          authorization: `Bearer ${masterToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.events).toEqual([]);
      expect(body.count).toBe(0);
      expect(body.total).toBe(0);
    });

    it("succeeds with audit_reader role token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/events",
        headers: {
          authorization: `Bearer ${auditReaderToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /v1/audit/events Ledger Query & Pagination", () => {
    async function seedAuditEvents(count: number) {
      let prevHash = GENESIS_PREV_HASH;
      for (let i = 1; i <= count; i++) {
        const ts = new Date(Date.now() - (count - i) * 1000).toISOString();
        const eventData = {
          seq: i,
          ts,
          actor: `sre-operator-${i}`,
          event_type: "LEASE_CREATED",
          payload: { lease_id: `LEASE_${i}` },
        };
        const hash = computeEventHash(prevHash, eventData);
        await leasePool.query(
          `INSERT INTO audit_events (seq, ts, actor, event_type, payload, prev_hash, hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            i,
            ts,
            eventData.actor,
            eventData.event_type,
            JSON.stringify(eventData.payload),
            prevHash,
            hash,
          ],
        );
        prevHash = hash;
      }
    }

    it("returns events in strict seq order", async () => {
      await seedAuditEvents(5);

      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/events",
        headers: { authorization: `Bearer ${masterToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.events.length).toBe(5);
      expect(body.count).toBe(5);
      expect(body.total).toBe(5);
      expect(body.events[0].seq).toBe(1);
      expect(body.events[4].seq).toBe(5);
      expect(body.events[0].prev_hash).toBe(GENESIS_PREV_HASH);
    });

    it("supports pagination with from_seq, to_seq, and limit", async () => {
      await seedAuditEvents(10);

      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/events?from_seq=3&to_seq=6&limit=3",
        headers: { authorization: `Bearer ${masterToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.events.length).toBe(3);
      expect(body.events[0].seq).toBe(3);
      expect(body.events[2].seq).toBe(5);
      expect(body.has_more).toBe(true);
    });

    it("rejects invalid query parameters with 400", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/events?limit=-5",
        headers: { authorization: `Bearer ${masterToken}` },
      });
      expect(res.statusCode).toBe(400);

      const res2 = await app.inject({
        method: "GET",
        url: "/v1/audit/events?limit=5000",
        headers: { authorization: `Bearer ${masterToken}` },
      });
      expect(res2.statusCode).toBe(400);
    });
  });

  describe("GET /v1/audit/checkpoint/latest", () => {
    it("returns genesis checkpoint when audit ledger is empty", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/checkpoint/latest",
        headers: { authorization: `Bearer ${masterToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.checkpoint_seq).toBe(0);
      expect(body.checkpoint_hash).toBe(GENESIS_PREV_HASH);
      expect(body.sealed_count).toBe(0);
      expect(body.timestamp).toBeNull();
    });

    it("returns latest sealed sequence and hash when events exist", async () => {
      const ts = new Date().toISOString();
      const eventData = {
        seq: 1,
        ts,
        actor: "sre-alice",
        event_type: "LEASE_CREATED",
        payload: { flag: "dark-mode" },
      };
      const hash = computeEventHash(GENESIS_PREV_HASH, eventData);

      await leasePool.query(
        `INSERT INTO audit_events (seq, ts, actor, event_type, payload, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [1, ts, eventData.actor, eventData.event_type, JSON.stringify(eventData.payload), GENESIS_PREV_HASH, hash],
      );

      const res = await app.inject({
        method: "GET",
        url: "/v1/audit/checkpoint/latest",
        headers: { authorization: `Bearer ${masterToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.checkpoint_seq).toBe(1);
      expect(body.checkpoint_hash).toBe(hash);
      expect(body.sealed_count).toBe(1);
      expect(body.timestamp).toBeDefined();
    });
  });
});
