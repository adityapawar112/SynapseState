import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";

export interface ChangeRoutesOptions {
  leasePool: Pool;
}

interface ChangeQuery {
  env?: string;
  since?: string;
  flag_key?: string;
  service?: string;
  limit?: string;
}

/**
 * Parses a relative duration string (e.g. "30s", "15m", "2h", "1d") or an ISO timestamp into a Date.
 */
export function parseSince(sinceStr: string, now: Date = new Date()): Date {
  const trimmed = sinceStr.trim();
  const relMatch = /^(\d+)([smhd])$/i.exec(trimmed);
  if (relMatch) {
    const val = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    let ms = 0;
    if (unit === "s") ms = val * 1000;
    else if (unit === "m") ms = val * 60 * 1000;
    else if (unit === "h") ms = val * 3600 * 1000;
    else if (unit === "d") ms = val * 86400 * 1000;
    return new Date(now.getTime() - ms);
  }

  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  throw new Error(
    `Invalid duration or timestamp format for 'since': "${sinceStr}"`,
  );
}

/**
 * Incident Attribution Change Feed Route Plugin.
 *
 * Implements ARCHITECTURE §11.3 & SpecDoc §4.1:
 * - Queries change history from change_events (occurred_at DESC, id DESC).
 * - Filters by env (required), since (default: 30m), and optional flag_key / service.
 * - Enforces pagination limit constraints (default 50, maximum 200).
 * - Enriches response with evaluation metrics from flag_usage_daily.
 * - Powers synapse log incident investigation CLI command.
 */
export const changeRoutes: FastifyPluginAsync<ChangeRoutesOptions> = async (
  fastify,
  options,
) => {
  const { leasePool } = options;

  fastify.get<{ Querystring: ChangeQuery }>(
    "/v1/changes",
    async (req, reply) => {
      const {
        env,
        since = "30m",
        flag_key,
        service,
        limit: rawLimit,
      } = req.query;

      if (!env || typeof env !== "string" || env.trim() === "") {
        return reply.code(400).send({
          error: "Missing required query parameter: env",
        });
      }

      let sinceDate: Date;
      try {
        sinceDate = parseSince(since);
      } catch {
        return reply.code(400).send({
          error: `Invalid duration or timestamp format for 'since': "${since}"`,
        });
      }

      // Limit parsing & clamping: default 50, maximum 200, minimum 1
      let limit = 50;
      if (rawLimit !== undefined) {
        const parsed = parseInt(rawLimit, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(parsed, 200);
        }
      }

      // Query change_events
      const eventParams: unknown[] = [env, sinceDate];
      let eventSql = `
      SELECT id, event_type, env, flag_key, actor, occurred_at, payload
      FROM change_events
      WHERE env = $1 AND occurred_at >= $2
    `;

      if (flag_key) {
        eventParams.push(flag_key);
        eventSql += ` AND flag_key = $${eventParams.length}`;
      }

      eventSql += ` ORDER BY occurred_at DESC, id DESC LIMIT $${eventParams.length + 1}`;
      eventParams.push(limit);

      const eventResult = await leasePool.query<{
        id: string | number;
        event_type: string;
        env: string;
        flag_key: string | null;
        actor: string;
        occurred_at: Date;
        payload: unknown;
      }>(eventSql, eventParams);

      const events = eventResult.rows.map((row) => {
        let parsedPayload = row.payload;
        if (typeof row.payload === "string") {
          try {
            parsedPayload = JSON.parse(row.payload);
          } catch {
            parsedPayload = row.payload;
          }
        }

        return {
          id: Number(row.id),
          event_type: row.event_type,
          env: row.env,
          flag_key: row.flag_key,
          actor: row.actor,
          occurred_at:
            row.occurred_at instanceof Date
              ? row.occurred_at.toISOString()
              : new Date(row.occurred_at).toISOString(),
          payload: parsedPayload,
        };
      });

      // Query flag_usage_daily for correlated evaluations
      const evalParams: unknown[] = [env, sinceDate.toISOString().slice(0, 10)];
      let evalSql = `
      SELECT flag_key, variant, SUM(eval_count)::bigint AS eval_count
      FROM flag_usage_daily
      WHERE env = $1 AND usage_date >= $2
    `;

      if (service) {
        evalParams.push(service);
        evalSql += ` AND service = $${evalParams.length}`;
      }

      if (flag_key) {
        evalParams.push(flag_key);
        evalSql += ` AND flag_key = $${evalParams.length}`;
      }

      evalSql += ` GROUP BY flag_key, variant ORDER BY flag_key ASC, variant ASC`;

      const evalResult = await leasePool.query<{
        flag_key: string;
        variant: string;
        eval_count: string | number;
      }>(evalSql, evalParams);

      const evaluations = evalResult.rows.map((row) => ({
        flag_key: row.flag_key,
        variant: row.variant,
        eval_count: Number(row.eval_count),
      }));

      return reply.code(200).send({
        query: {
          env,
          since,
          ...(flag_key ? { flag_key } : {}),
          ...(service ? { service } : {}),
          limit,
        },
        events,
        evaluations,
      });
    },
  );
};
