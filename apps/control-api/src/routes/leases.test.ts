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

import { vi } from "vitest";
import {
  StalePrConflictError,
  type GitHubReconciler,
} from "../github/index.js";

describe("Lease Ingestion & Revocation Routes", () => {
  let app: FastifyInstance;
  let operatorKey: ReturnType<typeof crypto.generateKeyPairSync>;
  let operatorPubB64: string;
  let testKeyset: Keyset;
  let mockReconciler: {
    promoteLease: ReturnType<typeof vi.fn>;
  };
  const env = "leases-test-env";
  const validToken = "sre-secret-bearer-token";

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
      }),
    );

    // Insert valid API token for promotion tests
    const tokenHash = crypto
      .createHash("sha256")
      .update(validToken)
      .digest("hex");
    await leasePool.query(
      `INSERT INTO api_tokens (token_id, token_hash, service_name, env, roles)
       VALUES ('tok-test-promote', $1, 'sre-alice', 'leases-test-env', ARRAY['operator', 'admin'])
       ON CONFLICT (token_id) DO UPDATE SET token_hash = EXCLUDED.token_hash`,
      [tokenHash],
    );

    mockReconciler = {
      promoteLease: vi.fn(),
    };

    app = buildServer({
      leasePool,
      keyset: testKeyset,
      githubReconciler: mockReconciler as unknown as GitHubReconciler,
      fastifyOptions: { logger: false },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePools();
  });

  beforeEach(async () => {
    // Clean test state before each run scoped to this test environment (P1.9)
    await leasePool.query(
      "DELETE FROM revocations WHERE lease_id IN (SELECT lease_id FROM leases WHERE env = $1)",
      [env],
    );
    await leasePool.query(
      "DELETE FROM audit_pending WHERE payload->>'env' = $1 OR payload->>'lease_id' IN (SELECT lease_id FROM leases WHERE env = $1)",
      [env],
    );
    await leasePool.query("DELETE FROM leases WHERE env = $1", [env]);
    await leasePool.query("DELETE FROM change_events WHERE env = $1", [env]);
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
    const leaseRow = await leasePool.query(
      "SELECT * FROM leases WHERE lease_id = $1",
      [payload.lease_id],
    );
    expect(leaseRow.rows).toHaveLength(1);
    expect(leaseRow.rows[0].state).toBe("ACTIVE");
    expect(leaseRow.rows[0].created_by_kid).toBe("sre-alice");

    // Verify audit_pending & change_events staging
    const auditRow = await leasePool.query(
      "SELECT * FROM audit_pending WHERE event_type = 'LEASE_CREATED'",
    );
    expect(auditRow.rows.length).toBeGreaterThan(0);

    const changeRow = await leasePool.query(
      "SELECT * FROM change_events WHERE event_type = 'LEASE_CREATED' AND flag_key = $1",
      ["test-unregistered-flag"],
    );
    expect(changeRow.rows).toHaveLength(1);
  });

  it("does not emit UNKNOWN_FLAG warning when flag exists in flags registry", async () => {
    const flagKey = "test-registered-flag";
    await leasePool.query(
      `INSERT INTO flags (key, env, class, owner, description)
       VALUES ($1, $2, 'release', 'team-checkout', 'Checkout flag')
       ON CONFLICT (key, env) DO NOTHING`,
      [flagKey, env],
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
    const l1 = await leasePool.query(
      "SELECT state FROM leases WHERE lease_id = $1",
      [payload1.lease_id],
    );
    expect(l1.rows[0].state).toBe("SUPERSEDED");

    const l2 = await leasePool.query(
      "SELECT state FROM leases WHERE lease_id = $1",
      [payload2.lease_id],
    );
    expect(l2.rows[0].state).toBe("ACTIVE");

    // Verify LEASE_SUPERSEDED change event was recorded
    const supersededChanges = await leasePool.query(
      "SELECT * FROM change_events WHERE event_type = 'LEASE_SUPERSEDED' AND flag_key = $1 AND env = $2",
      [flagKey, env],
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

  it("enforces exactly one ACTIVE lease under concurrent ingestion for same (flag_key, env) (P0.2)", async () => {
    const flagKey = "test-concurrent-race-flag";

    const payload1 = createTestLease({
      flag_key: flagKey,
      value: "variant-1",
      reason: "Concurrent lease 1",
    });
    const payload2 = createTestLease({
      flag_key: flagKey,
      value: "variant-2",
      reason: "Concurrent lease 2",
    });

    const env1 = signLease(payload1, operatorKey.privateKey);
    const env2 = signLease(payload2, operatorKey.privateKey);

    // Fire both requests concurrently
    const [res1, res2] = await Promise.all([
      app.inject({ method: "POST", url: "/v1/leases", payload: env1 }),
      app.inject({ method: "POST", url: "/v1/leases", payload: env2 }),
    ]);

    // Both requests must complete with valid status codes (never 500)
    expect([201, 409]).toContain(res1.statusCode);
    expect([201, 409]).toContain(res2.statusCode);

    // Partial unique index guarantees EXACTLY ONE active lease in the DB
    const activeRows = await leasePool.query(
      "SELECT * FROM leases WHERE flag_key = $1 AND env = $2 AND state = 'ACTIVE'",
      [flagKey, env],
    );
    expect(activeRows.rows).toHaveLength(1);
  });

  it("idempotently succeeds when re-submitting an identical signed lease (P1.10)", async () => {
    const payload = createTestLease({
      flag_key: "test-idempotent-flag",
      value: true,
      reason: "Initial idempotent override",
    });
    const envelope = signLease(payload, operatorKey.privateKey);

    const firstRes = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });
    expect(firstRes.statusCode).toBe(201);

    // Resend exact same lease envelope
    const secondRes = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: envelope,
    });
    expect(secondRes.statusCode).toBe(201);

    const countRows = await leasePool.query(
      "SELECT COUNT(*)::int AS count FROM leases WHERE lease_id = $1",
      [payload.lease_id],
    );
    expect(countRows.rows[0].count).toBe(1);
  });

  it("rejects re-submitting same lease_id with different payload with 409 Conflict (P1.10)", async () => {
    const leaseId = generateUlid();
    const payload1 = createTestLease({
      lease_id: leaseId,
      flag_key: "test-id-conflict-flag",
      value: true,
    });
    const env1 = signLease(payload1, operatorKey.privateKey);

    const firstRes = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: env1,
    });
    expect(firstRes.statusCode).toBe(201);

    // Create different payload with same lease_id
    const payload2 = createTestLease({
      lease_id: leaseId,
      flag_key: "test-id-conflict-flag",
      value: false,
    });
    const env2 = signLease(payload2, operatorKey.privateKey);

    const secondRes = await app.inject({
      method: "POST",
      url: "/v1/leases",
      payload: env2,
    });
    expect(secondRes.statusCode).toBe(409);
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
    const leaseRow = await leasePool.query(
      "SELECT state FROM leases WHERE lease_id = $1",
      [payload.lease_id],
    );
    expect(leaseRow.rows[0].state).toBe("REVOKED");

    // Verify revocations table row
    const revRow = await leasePool.query(
      "SELECT * FROM revocations WHERE lease_id = $1",
      [payload.lease_id],
    );
    expect(revRow.rows).toHaveLength(1);
    expect(revRow.rows[0].revoked_by_kid).toBe("sre-alice");

    // Verify change event
    const changeRow = await leasePool.query(
      "SELECT * FROM change_events WHERE event_type = 'LEASE_REVOKED' AND flag_key = $1 AND env = $2",
      [flagKey, env],
    );
    expect(changeRow.rows).toHaveLength(1);
  });

  describe("POST /v1/leases/:id/promote (PR 18)", () => {
    it("rejects promotion request missing Bearer token with 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/leases/01J9X57YTRPQ8A7F4E12345678/promote",
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("UNAUTHORIZED");
    });

    it("rejects promotion request with invalid Bearer token with 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/leases/01J9X57YTRPQ8A7F4E12345678/promote",
        headers: {
          authorization: "Bearer wrong-token",
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("UNAUTHORIZED");
    });

    it("returns 404 when lease is not found", async () => {
      const nonExistentId = generateUlid();
      const res = await app.inject({
        method: "POST",
        url: `/v1/leases/${nonExistentId}/promote`,
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("NOT_FOUND");
    });

    it("returns 409 Conflict when lease is already in state PROMOTED", async () => {
      const leaseId = generateUlid();
      await leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid, promote_pr_url)
         VALUES ($1, 'flag-already-promoted', $2, '{}'::jsonb, 'sig', 'PROMOTED', NOW(), 600, NOW() + INTERVAL '600s', 'sre-alice', 'https://github.com/org/repo/pull/123')`,
        [leaseId, env],
      );

      const res = await app.inject({
        method: "POST",
        url: `/v1/leases/${leaseId}/promote`,
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("CONFLICT");
      expect(res.json().promote_pr_url).toBe(
        "https://github.com/org/repo/pull/123",
      );
    });

    it("returns 409 Conflict when lease is REVOKED", async () => {
      const leaseId = generateUlid();
      await leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
         VALUES ($1, 'flag-revoked', $2, '{}'::jsonb, 'sig', 'REVOKED', NOW(), 600, NOW() + INTERVAL '600s', 'sre-alice')`,
        [leaseId, env],
      );

      const res = await app.inject({
        method: "POST",
        url: `/v1/leases/${leaseId}/promote`,
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("CONFLICT");
    });

    it("returns 409 STALE_PR_CONFLICT when reconciler throws StalePrConflictError", async () => {
      const leaseId = generateUlid();
      const payload = createTestLease({ lease_id: leaseId });
      await leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
         VALUES ($1, $2, $3, $4, 'sig', 'ACTIVE', NOW(), 600, NOW() + INTERVAL '600s', 'sre-alice')`,
        [leaseId, payload.flag_key, env, JSON.stringify(payload)],
      );

      mockReconciler.promoteLease.mockRejectedValueOnce(
        new StalePrConflictError(
          "Stale PR conflict",
          "https://github.com/org/repo/pull/999",
        ),
      );

      const res = await app.inject({
        method: "POST",
        url: `/v1/leases/${leaseId}/promote`,
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("STALE_PR_CONFLICT");
      expect(res.json().existing_pr_url).toBe(
        "https://github.com/org/repo/pull/999",
      );
    });

    it("promotes ACTIVE lease: calls reconciler, records promote_pr_url, and returns 202 Accepted", async () => {
      const leaseId = generateUlid();
      const payload = createTestLease({ lease_id: leaseId });
      await leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
         VALUES ($1, $2, $3, $4, 'sig', 'ACTIVE', NOW(), 600, NOW() + INTERVAL '600s', 'sre-alice')`,
        [leaseId, payload.flag_key, env, JSON.stringify(payload)],
      );

      mockReconciler.promoteLease.mockResolvedValueOnce({
        lease_id: leaseId,
        pr_url: "https://github.com/org/repo/pull/333",
        branch: `synapse/promote-lease-${leaseId}`,
        number: 333,
      });

      const res = await app.inject({
        method: "POST",
        url: `/v1/leases/${leaseId}/promote`,
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        lease_id: leaseId,
        pr_url: "https://github.com/org/repo/pull/333",
        branch: `synapse/promote-lease-${leaseId}`,
      });

      // Verify DB was updated with promote_pr_url
      const checkDb = await leasePool.query(
        "SELECT promote_pr_url FROM leases WHERE lease_id = $1",
        [leaseId],
      );
      expect(checkDb.rows[0].promote_pr_url).toBe(
        "https://github.com/org/repo/pull/333",
      );
    });

    it("promotes EXPIRED lease: calls reconciler and returns 202 Accepted", async () => {
      const leaseId = generateUlid();
      const payload = createTestLease({ lease_id: leaseId });
      await leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
         VALUES ($1, $2, $3, $4, 'sig', 'EXPIRED', NOW() - INTERVAL '1200s', 600, NOW() - INTERVAL '600s', 'sre-alice')`,
        [leaseId, payload.flag_key, env, JSON.stringify(payload)],
      );

      mockReconciler.promoteLease.mockResolvedValueOnce({
        lease_id: leaseId,
        pr_url: "https://github.com/org/repo/pull/444",
        branch: `synapse/promote-lease-${leaseId}`,
        number: 444,
      });

      const res = await app.inject({
        method: "POST",
        url: `/v1/leases/${leaseId}/promote`,
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({
        lease_id: leaseId,
        pr_url: "https://github.com/org/repo/pull/444",
        branch: `synapse/promote-lease-${leaseId}`,
      });
    });

    it("rejects promotion with 403 Forbidden when token lacks operator role (C3 blocker)", async () => {
      const readOnlyToken = "readonly-telemetry-token-xyz";
      const tokenHash = crypto
        .createHash("sha256")
        .update(readOnlyToken)
        .digest("hex");
      await leasePool.query(
        `INSERT INTO api_tokens (token_id, token_hash, service_name, env, roles)
         VALUES ('tok-test-readonly', $1, 'telemetry-collector', $2, ARRAY['telemetry'])
         ON CONFLICT (token_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, roles = EXCLUDED.roles`,
        [tokenHash, env],
      );

      const leaseId = generateUlid();
      const res = await app.inject({
        method: "POST",
        url: `/v1/leases/${leaseId}/promote`,
        headers: {
          authorization: `Bearer ${readOnlyToken}`,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("FORBIDDEN");
    });

    it("rejects promotion with 400 when lease ID is not a valid 26-char Crockford ULID", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/leases/invalid-id-too-short/promote",
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("INVALID_LEASE_ID");
    });

    it("rejects promotion with 400 when requested env does not match lease env", async () => {
      const leaseId = generateUlid();
      const payload = createTestLease({ lease_id: leaseId });
      await leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
         VALUES ($1, $2, $3, $4, 'sig', 'ACTIVE', NOW(), 600, NOW() + INTERVAL '600s', 'sre-alice')`,
        [leaseId, payload.flag_key, env, JSON.stringify(payload)],
      );

      const res = await app.inject({
        method: "POST",
        url: `/v1/leases/${leaseId}/promote`,
        headers: {
          authorization: `Bearer ${validToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ env: "other-env" }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("ENVIRONMENT_MISMATCH");
    });
  });
});
