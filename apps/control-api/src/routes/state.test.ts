import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  signLease,
  signRevocation,
  formatPublicKeyToBase64Url,
  parseKeysetJson,
  type Keyset,
  type LeasePayload,
  type RevocationPayload,
} from "@synapsestate/lease";
import { buildServer } from "../app.js";
import { leasePool, closePools } from "../db/pool.js";
import { generateUlid } from "@synapsestate/sdk";

describe("State Delivery & Long-Polling Route (GET /v1/sdk/state)", () => {
  let app: FastifyInstance;
  let operatorKey: ReturnType<typeof crypto.generateKeyPairSync>;
  let testKeyset: Keyset;

  beforeAll(async () => {
    operatorKey = crypto.generateKeyPairSync("ed25519");
    const pubB64 = formatPublicKeyToBase64Url(operatorKey.publicKey);

    testKeyset = parseKeysetJson(
      JSON.stringify({
        "sre-alice": {
          public_key: pubB64,
          role: "operator",
          max_ttl_seconds: 3600,
        },
      })
    );

    app = buildServer({
      leasePool,
      keyset: testKeyset,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePools();
  });

  beforeEach(async () => {
    await leasePool.query("DELETE FROM revocations");
    await leasePool.query("DELETE FROM leases");
    await leasePool.query("DELETE FROM change_events");
    await leasePool.query("DELETE FROM audit_pending");
  });

  it("returns immediate HTTP 200 with complete payload and ETag header on initial request", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/sdk/state?env=test-env",
    });

    expect(res.statusCode).toBe(200);
    const etagHeader = res.headers["etag"] as string;
    expect(etagHeader).toBeDefined();

    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty("etag");
    expect(body).toHaveProperty("server_time");
    expect(body).toHaveProperty("registry_version");
    expect(body).toHaveProperty("active_leases");
    expect(body).toHaveProperty("revocations");
    expect(body).toHaveProperty("key_revocations");

    expect(body.active_leases).toEqual([]);
    expect(body.revocations).toEqual([]);
    expect(body.key_revocations).toEqual([]);
    expect(typeof body.registry_version).toBe("number");
  });

  it("returns immediate HTTP 304 when client ETag matches and wait=0s", async () => {
    // 1. Initial fetch
    const firstRes = await app.inject({
      method: "GET",
      url: "/v1/sdk/state?env=test-env",
    });
    const etag = firstRes.headers["etag"] as string;

    // 2. Poll with matching If-None-Match and wait=0s
    const secondRes = await app.inject({
      method: "GET",
      url: "/v1/sdk/state?env=test-env&wait=0s",
      headers: {
        "if-none-match": etag,
      },
    });

    expect(secondRes.statusCode).toBe(304);
    expect(secondRes.payload).toBe("");
  });

  it("suspends long-polling request and returns HTTP 304 upon wait timeout if unchanged", async () => {
    const firstRes = await app.inject({
      method: "GET",
      url: "/v1/sdk/state?env=test-env",
    });
    const etag = firstRes.headers["etag"] as string;

    const start = Date.now();
    const pollRes = await app.inject({
      method: "GET",
      url: "/v1/sdk/state?env=test-env&wait=1s",
      headers: {
        "if-none-match": etag,
      },
    });
    const elapsed = Date.now() - start;

    expect(pollRes.statusCode).toBe(304);
    expect(elapsed).toBeGreaterThanOrEqual(950);
  });

  it("immediately wakes up suspended long-poll request (<100ms) when a new lease is ingested", async () => {
    // 1. Initial state
    const initialRes = await app.inject({
      method: "GET",
      url: "/v1/sdk/state?env=test-env",
    });
    const initialEtag = initialRes.headers["etag"] as string;

    // 2. Start suspended long-poll waiting for up to 5 seconds
    const longPollPromise = app.inject({
      method: "GET",
      url: "/v1/sdk/state?env=test-env&wait=5s",
      headers: {
        "if-none-match": initialEtag,
      },
    });

    // 3. Ingest a new lease shortly after
    await new Promise((resolve) => setTimeout(resolve, 50));

    const leaseId = generateUlid();
    const payload: LeasePayload = {
      v: 1,
      lease_id: leaseId,
      env: "test-env",
      flag_key: "test-wake-flag",
      value: "variant-b",
      reason: "Emergency wake up test",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "sre-alice",
      nonce: crypto.randomBytes(16).toString("base64url"),
    };
    const envelope = signLease(payload, operatorKey.privateKey);

    const postStart = Date.now();
    const postRes = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });
    expect(postRes.statusCode).toBe(201);

    // 4. Await long-poll response
    const wakeRes = await longPollPromise;
    const latency = Date.now() - postStart;

    expect(wakeRes.statusCode).toBe(200);
    // Instant wake-up (<100ms)
    expect(latency).toBeLessThan(500);

    const wakeBody = JSON.parse(wakeRes.payload);
    expect(wakeBody.etag).not.toBe(initialEtag);
    expect(wakeBody.active_leases).toHaveLength(1);
    expect(wakeBody.active_leases[0].payload.lease_id).toBe(leaseId);
    expect(wakeBody.active_leases[0].payload.value).toBe("variant-b");
  });

  it("immediately wakes up suspended long-poll request when an active lease is revoked", async () => {
    const env = "test-env";
    const leaseId = generateUlid();

    // 1. Ingest lease
    const envelope = signLease(
      {
        v: 1,
        lease_id: leaseId,
        env,
        flag_key: "test-revoke-wake-flag",
        value: true,
        reason: "Pre-revocation lease",
        issued_at: new Date().toISOString(),
        ttl_seconds: 600,
        kid: "sre-alice",
        nonce: crypto.randomBytes(16).toString("base64url"),
      },
      operatorKey.privateKey
    );
    await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });

    // 2. Fetch current state with the active lease
    const stateRes = await app.inject({
      method: "GET",
      url: `/v1/sdk/state?env=${env}`,
    });
    const currentEtag = stateRes.headers["etag"] as string;

    // 3. Suspend long-poll waiting for changes
    const longPollPromise = app.inject({
      method: "GET",
      url: `/v1/sdk/state?env=${env}&wait=5s`,
      headers: {
        "if-none-match": currentEtag,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // 4. Revoke the lease
    const revPayload: RevocationPayload = {
      v: 1,
      lease_id: leaseId,
      revoked_at: new Date().toISOString(),
      kid: "sre-alice",
      reason: "Revoke wake-up test",
    };
    const revEnvelope = signRevocation(revPayload, operatorKey.privateKey);

    const revRes = await app.inject({
      method: "POST",
      url: `/v1/leases/${leaseId}/revoke`,
      payload: revEnvelope,
    });
    expect(revRes.statusCode).toBe(200);

    // 5. Long-poll should wake up with 200 and updated state
    const wakeRes = await longPollPromise;
    expect(wakeRes.statusCode).toBe(200);
    const body = JSON.parse(wakeRes.payload);
    expect(body.active_leases).toHaveLength(0);
    expect(body.revocations).toHaveLength(1);
    expect(body.revocations[0].payload.lease_id).toBe(leaseId);
  });
});
