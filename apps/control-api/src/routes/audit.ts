import crypto from "node:crypto";
import type { FastifyPluginCallback, FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { GENESIS_PREV_HASH, type AuditEventRecord } from "@synapsestate/lease";

export interface AuditRouteOptions {
  leasePool: Pool;
}

interface AuditEventsQuery {
  from_seq?: string;
  to_seq?: string;
  limit?: string;
}

/**
 * Parses a string strictly as a non-negative integer.
 * Rejects floats ("1.5"), trailing alphas ("10abc"), exponentials ("10e2"), and unsafe numbers.
 */
function parseStrictPositiveInt(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw.trim())) {
    return undefined;
  }
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Safely converts an arbitrary timestamp or Date into an ISO 8601 string.
 * Prevents unhandled RangeError throws on corrupted database values.
 */
function safeIsoString(ts: unknown): string {
  if (ts instanceof Date) {
    return Number.isNaN(ts.getTime()) ? new Date(0).toISOString() : ts.toISOString();
  }
  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/**
 * Authentication and authorization middleware verifying Bearer token.
 * Grants access to operator, admin, or audit_reader roles, or master SYNAPSE_API_TOKEN.
 */
async function authenticateAuditReader(
  req: FastifyRequest,
  reply: FastifyReply,
  pool: Pool,
): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    void reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Missing or malformed Authorization header",
    });
    return false;
  }

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken) {
    void reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Empty Bearer token",
    });
    return false;
  }

  // Constant-time comparison against master SYNAPSE_API_TOKEN to prevent timing side-channels (I2)
  const expectedToken = process.env.SYNAPSE_API_TOKEN ?? "";
  const rawBuf = Buffer.from(rawToken, "utf8");
  const expBuf = Buffer.from(expectedToken, "utf8");
  if (
    expBuf.length > 0 &&
    rawBuf.length === expBuf.length &&
    crypto.timingSafeEqual(rawBuf, expBuf)
  ) {
    return true;
  }

  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const tokenRes = await pool.query<{
    service_name: string;
    roles: string[];
  }>("SELECT service_name, roles FROM api_tokens WHERE token_hash = $1 LIMIT 1", [
    tokenHash,
  ]);

  if (tokenRes.rows.length === 0) {
    void reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Invalid or unauthorized API token",
    });
    return false;
  }

  const roles = tokenRes.rows[0].roles || [];
  if (
    roles.includes("operator") ||
    roles.includes("admin") ||
    roles.includes("audit_reader")
  ) {
    return true;
  }

  void reply.code(403).send({
    error: "FORBIDDEN",
    message: "API token does not have operator, admin, or audit_reader role",
  });
  return false;
}

export const auditRoutes: FastifyPluginCallback<AuditRouteOptions> = (
  server,
  options,
  done,
) => {
  const pool = options.leasePool;

  /**
   * GET /v1/audit/events
   * Streams/pages sealed audit events in sequential order for ledger verification.
   */
  server.get<{ Querystring: AuditEventsQuery }>(
    "/v1/audit/events",
    async (req, reply) => {
      const authorized = await authenticateAuditReader(req, reply, pool);
      if (!authorized) {
        return;
      }

      const fromSeqRaw = req.query.from_seq ?? "1";
      const fromSeq = parseStrictPositiveInt(fromSeqRaw);
      if (fromSeq === undefined || fromSeq < 1) {
        return reply.code(400).send({
          error: "INVALID_PARAM",
          message: "from_seq must be a strict integer >= 1",
        });
      }

      let toSeq: number | undefined;
      if (req.query.to_seq !== undefined) {
        toSeq = parseStrictPositiveInt(req.query.to_seq);
        if (toSeq === undefined || toSeq < fromSeq) {
          return reply.code(400).send({
            error: "INVALID_PARAM",
            message: "to_seq must be a strict integer >= from_seq",
          });
        }
      }

      const limitRaw = req.query.limit ?? "100";
      const limit = parseStrictPositiveInt(limitRaw);
      if (limit === undefined || limit < 1 || limit > 1000) {
        return reply.code(400).send({
          error: "INVALID_PARAM",
          message: "limit must be a strict integer between 1 and 1000",
        });
      }

      const params: (number | string)[] = [fromSeq];
      let sql = "SELECT seq, ts, actor, event_type, payload, prev_hash, hash FROM audit_events WHERE seq >= $1";

      if (toSeq !== undefined) {
        params.push(toSeq);
        sql += ` AND seq <= $${params.length}`;
      }

      params.push(limit + 1);
      sql += ` ORDER BY seq ASC LIMIT $${params.length}`;

      const [eventsRes, countRes] = await Promise.all([
        pool.query<AuditEventRecord>(sql, params),
        pool.query<{ count: string }>("SELECT COUNT(*)::bigint AS count FROM audit_events"),
      ]);

      const total = parseInt(countRes.rows[0]?.count ?? "0", 10);
      const rows = eventsRes.rows;
      const hasMore = rows.length > limit;
      const returnedRows = hasMore ? rows.slice(0, limit) : rows;

      const events: AuditEventRecord[] = returnedRows.map((r) => ({
        seq: Number(r.seq),
        ts: safeIsoString(r.ts),
        actor: r.actor,
        event_type: r.event_type,
        payload: r.payload,
        prev_hash: r.prev_hash,
        hash: r.hash,
      }));

      return reply.code(200).send({
        events,
        count: events.length,
        total, // table-wide sealed total
        sealed_total: total,
        has_more: hasMore,
      });
    },
  );

  /**
   * GET /v1/audit/checkpoint/latest
   * Returns latest sealed sequence and hash for checkpointing and verification.
   */
  server.get("/v1/audit/checkpoint/latest", async (req, reply) => {
    const authorized = await authenticateAuditReader(req, reply, pool);
    if (!authorized) {
      return;
    }

    const [latestRes, countRes] = await Promise.all([
      pool.query<{ seq: string | number; hash: string; ts: Date | string }>(
        "SELECT seq, hash, ts FROM audit_events ORDER BY seq DESC LIMIT 1",
      ),
      pool.query<{ count: string }>("SELECT COUNT(*)::bigint AS count FROM audit_events"),
    ]);

    const total = parseInt(countRes.rows[0]?.count ?? "0", 10);
    if (latestRes.rows.length === 0) {
      return reply.code(200).send({
        checkpoint_seq: 0,
        checkpoint_hash: GENESIS_PREV_HASH,
        sealed_count: 0,
        timestamp: null,
      });
    }

    const latest = latestRes.rows[0];
    return reply.code(200).send({
      checkpoint_seq: Number(latest.seq),
      checkpoint_hash: latest.hash,
      sealed_count: total,
      timestamp: safeIsoString(latest.ts),
    });
  });

  done();
};
