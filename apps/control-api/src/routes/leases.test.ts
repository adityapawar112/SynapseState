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
import { generateUlid } from "@synapsestate/sdk";
import { buildServer } from "../app.js";
import { leasePool, closePools } from "../db/pool.js";
import { runMigrations } from "../db/migrator.js";

describe("Lease Ingestion & Revocation Routes", () => {
  let app: FastifyInstance;
  let operatorKey: ReturnType<typeof crypto.generateKeyPairSync>;
  let operatorPubB64: string;
  let testKeyset: Keyset;
  const env = "leases-test-env";

  function createTestLease(overrides?: Partial<LeasePayload>): LeasePayload {
    return {
      v: 1,
      lease_id: generateUlid(),
      env,
      flag_key: "test-flag",
      value: true,
      reason: "Incident mitigation override",
      issued_at: new Date().toISOString(),
      ttl_seconds: 600,
      kid: "sre-alice",
      nonce: crypto.randomBytes(16).toString("base64url"),
      ...overrides,
    };
  }

  beforeAll(async () => {
    await runMigrations(leasePool);

    operatorKey = crypto.generateKeyPairSync("ed25519");
    operatorPubB64 = formatPublicKeyToBase64Url(operatorKey.publicKey);

    testKeyset = parseKeysetJson(
      JSON.stringify({
        "sre-alice": {
          public_key: operatorPubB64,
          role: "operator",
          max_ttl_seconds: 3600,
        },
        "revoker-bob": {
          public_key: operatorPubB64,
          roles: ["key_revoker"], // not a lease_signer
          status: "active",
        },
      })
    );

    app = buildServer({
      leasePool,
      keyset: testKeyset,
      fastifyOptions: { logger: false },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePools();
  });

  beforeEach(async () => {
    // Clean test state before each run scoped to this test environment
    await leasePool.query(
      "DELETE FROM revocations WHERE lease_id IN (SELECT lease_id FROM leases WHERE env = $1)",
      [env]
    );
    await leasePool.query("DELETE FROM leases WHERE env = $1", [env]);
    await leasePool.query("DELETE FROM change_events WHERE env = $1", [env]);
    await leasePool.query("DELETE FROM audit_pending WHERE actor = 'sre-alice'");
    await leasePool.query("DELETE FROM flags WHERE env = $1", [env]);
  });

  it("ingests a valid signed emergency lease and returns 201 Created with UNKNOWN_FLAG warning", async () => {
    const payload = createTestLease({
      flag_key: "test-unregistered-flag",
      reason: "INC-999: DB connection pool exhaustion",
      ttl_seconds: 1800,
    });

    const envelope = signLease(payload, operatorKey.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({
      lease_id: payload.lease_id,
      state: "ACTIVE",
      warnings: ["UNKNOWN_FLAG"],
    });

    // Verify DB persistence
    const leaseRow = await leasePool.query("SELECT * FROM leases WHERE lease_id = $1", [payload.lease_id]);
    expect(leaseRow.rows).toHaveLength(1);
    expect(leaseRow.rows[0].state).toBe("ACTIVE");
    expect(leaseRow.rows[0].created_by_kid).toBe("sre-alice");

    // Verify audit_pending & change_events staging
    const auditRow = await leasePool.query(
      "SELECT * FROM audit_pending WHERE event_type = 'LEASE_CREATED'"
    );
    expect(auditRow.rows.length).toBeGreaterThan(0);

    const changeRow = await leasePool.query(
      "SELECT * FROM change_events WHERE event_type = 'LEASE_CREATED' AND flag_key = $1",
      ["test-unregistered-flag"]
    );
    expect(changeRow.rows).toHaveLength(1);
  });

  it("does not emit UNKNOWN_FLAG warning when flag exists in flags registry", async () => {
    const flagKey = "test-registered-flag";
    await leasePool.query(
      `INSERT INTO flags (key, env, class, owner, description)
       VALUES ($1, $2, 'release', 'team-checkout', 'Checkout flag')
       ON CONFLICT (key, env) DO NOTHING`,
      [flagKey, env]
    );

    const payload = createTestLease({
      flag_key: flagKey,
      value: false,
      reason: "INC-1000: Rollback killswitch",
      ttl_seconds: 1200,
    });

    const envelope = signLease(payload, operatorKey.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.warnings).toEqual([]);
  });

  it("supersedes existing active lease for (flag_key, env) in the same transaction", async () => {
    const flagKey = "test-supersede-flag";

    // First lease
    const payload1 = createTestLease({
      flag_key: flagKey,
      value: true,
      reason: "Initial override",
    });
    const envelope1 = signLease(payload1, operatorKey.privateKey);

    const res1 = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope1,
    });
    expect(res1.statusCode).toBe(201);

    // Second lease replacing the first
    const payload2 = createTestLease({
      flag_key: flagKey,
      value: false,
      reason: "Updated override with inverted value",
      ttl_seconds: 900,
    });
    const envelope2 = signLease(payload2, operatorKey.privateKey);

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope2,
    });
    expect(res2.statusCode).toBe(201);

    // Verify lease 1 became SUPERSEDED and lease 2 is ACTIVE
    const l1 = await leasePool.query("SELECT state FROM leases WHERE lease_id = $1", [payload1.lease_id]);
    expect(l1.rows[0].state).toBe("SUPERSEDED");

    const l2 = await leasePool.query("SELECT state FROM leases WHERE lease_id = $1", [payload2.lease_id]);
    expect(l2.rows[0].state).toBe("ACTIVE");

    // Verify LEASE_SUPERSEDED change event was recorded
    const supersededChanges = await leasePool.query(
      "SELECT * FROM change_events WHERE event_type = 'LEASE_SUPERSEDED' AND flag_key = $1 AND env = $2",
      [flagKey, env]
    );
    expect(supersededChanges.rows).toHaveLength(1);
    expect(supersededChanges.rows[0].payload).toMatchObject({
      superseded_lease_id: payload1.lease_id,
      new_lease_id: payload2.lease_id,
    });
  });

  it("returns 409 Conflict if supersede=false and an active lease exists", async () => {
    const flagKey = "test-conflict-flag";

    const payload1 = createTestLease({
      flag_key: flagKey,
      value: true,
      reason: "Initial override",
    });
    const envelope1 = signLease(payload1, operatorKey.privateKey);

    await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope1,
    });

    const payload2 = createTestLease({
      flag_key: flagKey,
      value: false,
      reason: "Conflicting override without supersede",
    });
    const envelope2 = signLease(payload2, operatorKey.privateKey);

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/leases?supersede=false",
      payload: envelope2,
    });

    expect(res2.statusCode).toBe(409);
    const body = JSON.parse(res2.payload);
    expect(body.error).toContain("An active lease already exists");
  });

  it("rejects unknown kid with 400 Bad Request", async () => {
    const payload = createTestLease({
      kid: "unknown-kid-01",
    });
    const envelope = signLease(payload, operatorKey.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("Unknown key identifier");
  });

  it("rejects key without lease-signing authorization with 403 Forbidden", async () => {
    const payload = createTestLease({
      kid: "revoker-bob",
    });
    const envelope = signLease(payload, operatorKey.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("not authorized to sign emergency leases");
  });

  it("rejects TTL exceeding key max_ttl_seconds ceiling with 400 Bad Request", async () => {
    const payload = createTestLease({
      ttl_seconds: 7200, // alice limit is 3600
      kid: "sre-alice",
    });
    const envelope = signLease(payload, operatorKey.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("exceeds key max TTL");
  });

  it("rejects tampered signature with 400 Bad Request", async () => {
    const payload = createTestLease();
    const envelope = signLease(payload, operatorKey.privateKey);

    envelope.sig = "tampered_signature_bytes_base64url";

    const res = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("Invalid Ed25519 signature");
  });

  it("rejects future-dated lease beyond clock skew tolerance with 400 Bad Request", async () => {
    const futureDate = new Date(Date.now() + 120_000).toISOString();
    const payload = createTestLease({
      issued_at: futureDate,
    });
    const envelope = signLease(payload, operatorKey.privateKey);

    const res = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("in the future beyond tolerance");
  });

  it("revokes an active lease via POST /v1/leases/:id/revoke", async () => {
    const flagKey = "test-revoked-flag";

    // 1. Create active lease
    const payload = createTestLease({
      flag_key: flagKey,
    });
    const envelope = signLease(payload, operatorKey.privateKey);

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });
    expect(createRes.statusCode).toBe(201);

    // 2. Revoke the lease
    const revPayload: RevocationPayload = {
      v: 1,
      lease_id: payload.lease_id,
      revoked_at: new Date().toISOString(),
      kid: "sre-alice",
      reason: "Incident resolved ahead of schedule",
    };

    const revEnvelope = signRevocation(revPayload, operatorKey.privateKey);

    const revRes = await app.inject({
      method: "POST",
      url: `/v1/leases/${payload.lease_id}/revoke`,
      payload: revEnvelope,
    });

    expect(revRes.statusCode).toBe(200);
    const revBody = JSON.parse(revRes.payload);
    expect(revBody).toEqual({
      lease_id: payload.lease_id,
      state: "REVOKED",
    });

    // Verify lease row state in DB
    const leaseRow = await leasePool.query("SELECT state FROM leases WHERE lease_id = $1", [payload.lease_id]);
    expect(leaseRow.rows[0].state).toBe("REVOKED");

    // Verify revocations table row
    const revRow = await leasePool.query("SELECT * FROM revocations WHERE lease_id = $1", [payload.lease_id]);
    expect(revRow.rows).toHaveLength(1);
    expect(revRow.rows[0].revoked_by_kid).toBe("sre-alice");

    // Verify change event
    const changeRow = await leasePool.query(
      "SELECT * FROM change_events WHERE event_type = 'LEASE_REVOKED' AND flag_key = $1 AND env = $2",
      [flagKey, env]
    );
    expect(changeRow.rows).toHaveLength(1);
  });
});
