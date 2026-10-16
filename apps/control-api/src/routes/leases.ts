import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import {
  LeaseEnvelopeSchema,
  RevocationEnvelopeSchema,
  DEFAULT_SKEW_TOLERANCE_MS,
  getKey,
  isKeyActive,
  canSignLease,
  canRevokeLease,
  verifyLease,
  verifyRevocationWithKeyset,
} from "@synapsestate/lease";
import { withTransaction } from "../db/transaction.js";
import type { KeysetProvider } from "../keyset.js";
import type { StateManager } from "../services/state-manager.js";
import type { SynapseMetrics } from "../metrics/index.js";
import {
  type GitHubReconciler,
  type LeaseRecord,
  StalePrConflictError,
  FlagNotFoundError,
  InvalidFlagKeyError,
} from "../github/index.js";

export interface LeaseRoutesOptions {
  leasePool: Pool;
  keysetProvider: KeysetProvider;
  stateManager: StateManager;
  metrics?: SynapseMetrics;
  githubReconciler?: GitHubReconciler;
}

/**
 * Emergency Break-Glass Lease Ingestion Route.
 *
 * Implements ARCHITECTURE §4.2 Step 2 & SpecDoc §4.1:
 * - Validates Ed25519 signature against Git-pinned keyset.
 * - Performs soft reference catalog check (flags & telemetry), emitting UNKNOWN_FLAG warning if flag is unregistered.
 * - Transactionally supersedes existing active lease for (flag_key, env) and inserts new ACTIVE lease.
 * - Atomically stages LEASE_SUPERSEDED and LEASE_CREATED events into audit_pending and change_events.
 * - Emits in-memory event to wake up active long-polling connections within <100ms.
 */
export const leaseRoutes: FastifyPluginAsync<LeaseRoutesOptions> = async (
  fastify,
  options,
) => {
  const { leasePool, keysetProvider, stateManager, metrics } = options;

  // POST /v1/leases
  fastify.post("/v1/leases", async (req, reply) => {
    // 1. Envelope schema validation
    const parseResult = LeaseEnvelopeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: "Invalid lease envelope",
        details: parseResult.error.issues,
      });
    }

    const envelope = parseResult.data;
    const { payload, sig } = envelope;

    // 2. Keyset existence
    const keyset = keysetProvider.getKeyset();
    const key = getKey(keyset, payload.kid);

    if (!key) {
      return reply.code(400).send({
        error: `Unknown key identifier: "${payload.kid}"`,
      });
    }

    // 3. Ed25519 cryptographic signature verification FIRST (prevents policy probe oracle - P1.1)
    const isValidSig = verifyLease(envelope, key.public_key);
    if (!isValidSig) {
      return reply.code(400).send({
        error: "Invalid Ed25519 signature",
      });
    }

    // 4. Key status & authorization policy enforcement
    if (!isKeyActive(key)) {
      return reply.code(403).send({
        error: `Key "${payload.kid}" is not active`,
      });
    }

    if (!canSignLease(key)) {
      return reply.code(403).send({
        error: `Key "${payload.kid}" is not authorized to sign emergency leases`,
      });
    }

    if (
      key.max_ttl_seconds !== undefined &&
      payload.ttl_seconds > key.max_ttl_seconds
    ) {
      return reply.code(400).send({
        error: `Lease TTL (${payload.ttl_seconds}s) exceeds key max TTL (${key.max_ttl_seconds}s)`,
      });
    }

    if (payload.ttl_seconds <= 0 || payload.ttl_seconds > 86400) {
      return reply.code(400).send({
        error: "Lease TTL must be between 1 and 86400 seconds",
      });
    }

    // 4. Clock skew and anti-future dating validation
    const issuedAtMs = Date.parse(payload.issued_at);
    const nowMs = Date.now();
    const SKEW_TOLERANCE_MS = DEFAULT_SKEW_TOLERANCE_MS; // 30s

    if (issuedAtMs > nowMs + SKEW_TOLERANCE_MS) {
      return reply.code(400).send({
        error: "Lease issued_at is in the future beyond tolerance",
      });
    }

    if (nowMs >= issuedAtMs + payload.ttl_seconds * 1000 + SKEW_TOLERANCE_MS) {
      return reply.code(400).send({
        error: "Lease has already expired",
      });
    }

    const query = req.query as { supersede?: string };
    const allowSupersede = query.supersede !== "false";

    // 5. Transactional persistence
    let warnings: string[] = [];
    try {
      await withTransaction(leasePool, async (client) => {
        // Soft reference check
        const flagRes = await client.query(
          "SELECT 1 FROM flags WHERE key = $1 AND env = $2 LIMIT 1",
          [payload.flag_key, payload.env],
        );
        let knownFlag = flagRes.rowCount !== null && flagRes.rowCount > 0;

        if (!knownFlag) {
          const telemetryRes = await client.query(
            "SELECT 1 FROM flag_usage_daily WHERE flag_key = $1 AND env = $2 LIMIT 1",
            [payload.flag_key, payload.env],
          );
          knownFlag =
            telemetryRes.rowCount !== null && telemetryRes.rowCount > 0;
        }

        warnings = knownFlag ? [] : ["UNKNOWN_FLAG"];

        // Check for existing lease by lease_id (idempotency & retry guard - P1.10)
        const existingLeaseIdRes = await client.query<{
          lease_id: string;
          sig: string;
          state: string;
        }>("SELECT lease_id, sig, state FROM leases WHERE lease_id = $1", [
          payload.lease_id,
        ]);
        if (existingLeaseIdRes.rows.length > 0) {
          const row = existingLeaseIdRes.rows[0];
          if (row.sig === sig) {
            // Idempotent retry: identical signed lease already committed
            return;
          }
          const conflictErr = new Error(
            `Lease with ID "${payload.lease_id}" already exists with different payload or signature`,
          );
          (conflictErr as unknown as { statusCode: number }).statusCode = 409;
          throw conflictErr;
        }

        // Check for existing active lease for (flag_key, env)
        const existingRes = await client.query<{ lease_id: string }>(
          `SELECT lease_id FROM leases 
           WHERE flag_key = $1 AND env = $2 AND state = 'ACTIVE' 
           FOR UPDATE`,
          [payload.flag_key, payload.env],
        );

        if (existingRes.rows.length > 0) {
          if (!allowSupersede) {
            const err = new Error(
              "An active lease already exists for this flag and environment",
            );
            (err as unknown as { statusCode: number }).statusCode = 409;
            throw err;
          }

          // Supersede existing active lease(s)
          await client.query(
            `UPDATE leases SET state = 'SUPERSEDED' 
             WHERE flag_key = $1 AND env = $2 AND state = 'ACTIVE'`,
            [payload.flag_key, payload.env],
          );

          for (const oldLease of existingRes.rows) {
            await client.query(
              `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
               VALUES ('LEASE_SUPERSEDED', $1, $2, $3, NOW(), $4)`,
              [
                payload.env,
                payload.flag_key,
                payload.kid,
                JSON.stringify({
                  superseded_lease_id: oldLease.lease_id,
                  new_lease_id: payload.lease_id,
                }),
              ],
            );

            await client.query(
              `INSERT INTO audit_pending (actor, event_type, payload)
               VALUES ($1, 'LEASE_SUPERSEDED', $2)`,
              [
                payload.kid,
                JSON.stringify({
                  superseded_lease_id: oldLease.lease_id,
                  new_lease_id: payload.lease_id,
                  flag_key: payload.flag_key,
                  env: payload.env,
                }),
              ],
            );
          }
        }

        // Insert new ACTIVE lease
        const expiresAt = new Date(
          issuedAtMs + payload.ttl_seconds * 1000,
        ).toISOString();
        await client.query(
          `INSERT INTO leases (
             lease_id, flag_key, env, payload, sig, state, 
             issued_at, ttl_seconds, expires_at, created_by_kid
           ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $9)`,
          [
            payload.lease_id,
            payload.flag_key,
            payload.env,
            JSON.stringify(payload),
            sig,
            payload.issued_at,
            payload.ttl_seconds,
            expiresAt,
            payload.kid,
          ],
        );

        // Stage LEASE_CREATED to change_events
        await client.query(
          `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
           VALUES ('LEASE_CREATED', $1, $2, $3, NOW(), $4)`,
          [
            payload.env,
            payload.flag_key,
            payload.kid,
            JSON.stringify({
              lease_id: payload.lease_id,
              value: payload.value,
              reason: payload.reason,
              ttl_seconds: payload.ttl_seconds,
            }),
          ],
        );

        // Stage LEASE_CREATED to audit_pending
        await client.query(
          `INSERT INTO audit_pending (actor, event_type, payload)
           VALUES ($1, 'LEASE_CREATED', $2)`,
          [
            payload.kid,
            JSON.stringify({
              lease_id: payload.lease_id,
              flag_key: payload.flag_key,
              env: payload.env,
              value: payload.value,
              reason: payload.reason,
              ttl_seconds: payload.ttl_seconds,
              issued_at: payload.issued_at,
            }),
          ],
        );

        // Record metrics
        if (metrics) {
          if (existingRes.rows.length > 0) {
            metrics.leaseTransitionsTotal.inc(
              { from: "ACTIVE", to: "SUPERSEDED" },
              existingRes.rows.length,
            );
          } else {
            // Synchronous increment provides immediate local visibility; periodic GET /metrics scrape provides authoritative eventual consistency
            metrics.leasesActive.inc({ env: payload.env });
          }
          metrics.leaseTransitionsTotal.inc({ from: "NONE", to: "ACTIVE" });
        }
      });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 409) {
        return reply.code(409).send({
          error: (err as Error).message,
        });
      }
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({
          error:
            "An active lease already exists or was created concurrently for this flag and environment",
        });
      }
      throw err;
    }

    // 6. Wake up active long-polling connections (non-fatal notification - P1.2)
    try {
      await stateManager.notifyChange(payload.env);
    } catch (notifyErr) {
      req.log.warn(
        { err: notifyErr },
        "[POST /v1/leases] Error waking up long-polling connections",
      );
    }

    // 7. Response 201 Created
    return reply.code(201).send({
      lease_id: payload.lease_id,
      state: "ACTIVE",
      warnings,
    });
  });

  // POST /v1/leases/:id/revoke
  fastify.post("/v1/leases/:id/revoke", async (req, reply) => {
    const { id } = req.params as { id: string };

    const parseResult = RevocationEnvelopeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: "Invalid revocation envelope",
        details: parseResult.error.issues,
      });
    }

    const envelope = parseResult.data;
    const { payload, sig } = envelope;

    if (payload.lease_id !== id) {
      return reply.code(400).send({
        error: `Revocation payload lease_id (${payload.lease_id}) does not match path param (${id})`,
      });
    }

    const keyset = keysetProvider.getKeyset();
    const key = getKey(keyset, payload.kid);

    if (!key) {
      return reply.code(400).send({
        error: `Unknown key identifier: "${payload.kid}"`,
      });
    }

    if (!isKeyActive(key) || !canRevokeLease(key)) {
      return reply.code(403).send({
        error: `Key "${payload.kid}" is not authorized to revoke leases`,
      });
    }

    const validSig = verifyRevocationWithKeyset(envelope, keyset);
    if (!validSig) {
      return reply.code(400).send({
        error: "Invalid Ed25519 revocation signature",
      });
    }

    let env = "prod";
    try {
      await withTransaction(leasePool, async (client) => {
        const leaseRes = await client.query<{
          flag_key: string;
          env: string;
          expires_at: Date;
          state: string;
        }>(
          "SELECT flag_key, env, expires_at, state FROM leases WHERE lease_id = $1 FOR UPDATE",
          [id],
        );

        if (leaseRes.rows.length === 0) {
          const err = new Error(`Lease "${id}" not found`);
          (err as unknown as { statusCode: number }).statusCode = 404;
          throw err;
        }

        const lease = leaseRes.rows[0];
        if (lease.state !== "ACTIVE") {
          const err = new Error(
            `Cannot revoke lease "${id}": lease is in state "${lease.state}"`,
          );
          (err as unknown as { statusCode: number }).statusCode = 409;
          throw err;
        }

        env = lease.env;

        // Transition lease to REVOKED
        await client.query(
          "UPDATE leases SET state = 'REVOKED' WHERE lease_id = $1",
          [id],
        );

        // Insert into revocations (retention bounded by expires_at + SKEW)
        const expiresAt = new Date(
          new Date(lease.expires_at).getTime() + DEFAULT_SKEW_TOLERANCE_MS,
        ).toISOString();
        await client.query(
          `INSERT INTO revocations (lease_id, payload, sig, revoked_by_kid, revoked_at, expires_at)
           VALUES ($1, $2, $3, $4, NOW(), $5)
           ON CONFLICT (lease_id) DO NOTHING`,
          [id, JSON.stringify(payload), sig, payload.kid, expiresAt],
        );

        // Stage LEASE_REVOKED to change_events
        await client.query(
          `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
           VALUES ('LEASE_REVOKED', $1, $2, $3, NOW(), $4)`,
          [
            env,
            lease.flag_key,
            payload.kid,
            JSON.stringify({
              lease_id: id,
              reason: payload.reason,
            }),
          ],
        );

        // Stage LEASE_REVOKED to audit_pending
        await client.query(
          `INSERT INTO audit_pending (actor, event_type, payload)
           VALUES ($1, 'LEASE_REVOKED', $2)`,
          [
            payload.kid,
            JSON.stringify({
              lease_id: id,
              flag_key: lease.flag_key,
              env,
              reason: payload.reason,
            }),
          ],
        );

        // Record metrics
        if (metrics) {
          metrics.leaseTransitionsTotal.inc({ from: "ACTIVE", to: "REVOKED" });
          metrics.leasesActive.dec({ env });
        }
      });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({
          error: (err as Error).message,
        });
      }
      if ((err as { statusCode?: number }).statusCode === 409) {
        return reply.code(409).send({
          error: (err as Error).message,
        });
      }
      throw err;
    }

    // Wake up active long-polling connections (non-fatal notification - P1.2)
    try {
      await stateManager.notifyChange(env);
    } catch (notifyErr) {
      req.log.warn(
        { err: notifyErr },
        "[POST /v1/leases/:id/revoke] Error waking up long-polling connections",
      );
    }

    return reply.code(200).send({
      lease_id: id,
      state: "REVOKED",
    });
  });

  // POST /v1/leases/:id/promote
  fastify.post("/v1/leases/:id/promote", async (req, reply) => {
    // 1. Bearer token authentication
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Missing or invalid Authorization header with Bearer token",
      });
    }

    const rawToken = authHeader.slice(7).trim();
    if (!rawToken) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Empty Bearer token",
      });
    }

    let authorized = false;
    if (
      process.env.SYNAPSE_API_TOKEN &&
      rawToken === process.env.SYNAPSE_API_TOKEN
    ) {
      authorized = true;
    } else {
      const tokenHash = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");
      const tokenRes = await leasePool.query<{
        service_name: string;
        roles: string[];
      }>(
        "SELECT service_name, roles FROM api_tokens WHERE token_hash = $1 LIMIT 1",
        [tokenHash],
      );
      if (tokenRes.rows.length > 0) {
        authorized = true;
      }
    }

    if (!authorized) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Invalid or unauthorized API token",
      });
    }

    // 2. Fetch lease from database
    const { id } = req.params as { id: string };
    const leaseRes = await leasePool.query<LeaseRecord>(
      `SELECT lease_id, flag_key, env, payload, sig, state, created_by_kid, promote_pr_url
       FROM leases WHERE lease_id = $1`,
      [id],
    );

    if (leaseRes.rows.length === 0) {
      return reply.code(404).send({
        error: "NOT_FOUND",
        message: `Lease "${id}" not found`,
      });
    }

    const lease = leaseRes.rows[0];

    // 3. State validation
    if (lease.state === "PROMOTED") {
      return reply.code(409).send({
        error: "CONFLICT",
        message: `Cannot promote lease "${id}": lease is already in state "PROMOTED"`,
        promote_pr_url: lease.promote_pr_url,
      });
    }

    if (lease.state !== "ACTIVE" && lease.state !== "EXPIRED") {
      return reply.code(409).send({
        error: "CONFLICT",
        message: `Cannot promote lease "${id}": lease is in state "${lease.state}"`,
      });
    }

    // 4. Verify GitHub reconciler is configured
    const reconciler = options.githubReconciler;
    if (!reconciler) {
      return reply.code(503).send({
        error: "GITHUB_NOT_CONFIGURED",
        message: "GitHub reconciler is not configured on this server",
      });
    }

    // 5. Execute promotion via reconciler
    try {
      const parsedPayload =
        typeof lease.payload === "string"
          ? JSON.parse(lease.payload)
          : lease.payload;

      const result = await reconciler.promoteLease({
        ...lease,
        payload: parsedPayload,
      });

      // Update promote_pr_url in database
      await leasePool.query(
        "UPDATE leases SET promote_pr_url = $1 WHERE lease_id = $2",
        [result.pr_url, id],
      );

      return reply.code(202).send({
        lease_id: lease.lease_id,
        pr_url: result.pr_url,
        branch: result.branch,
      });
    } catch (err: unknown) {
      if (err instanceof StalePrConflictError) {
        return reply.code(409).send({
          error: "STALE_PR_CONFLICT",
          message: err.message,
          existing_pr_url: err.existingPrUrl,
        });
      }
      if (err instanceof FlagNotFoundError) {
        return reply.code(404).send({
          error: "FLAG_NOT_FOUND",
          message: err.message,
        });
      }
      if (err instanceof InvalidFlagKeyError) {
        return reply.code(400).send({
          error: "INVALID_FLAG_KEY",
          message: err.message,
        });
      }
      throw err;
    }
  });
};
