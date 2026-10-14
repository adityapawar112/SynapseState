import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import crypto from "node:crypto";
import type { SynapseMetrics } from "../metrics/index.js";

export interface TelemetryRoutesOptions {
  telemetryPool: Pool;
  metrics?: SynapseMetrics;
}

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

export const MetricItemSchema = z
  .object({
    flag_key: z.string().min(1).max(128),
    variant: z.string().min(1).max(64),
    reason: z.string().min(1).max(64),
    count: z.number().int().nonnegative(),
  })
  .strict();

export type MetricItem = z.infer<typeof MetricItemSchema>;

export const TelemetryBatchPayloadSchema = z
  .object({
    instance_id: z.string().min(1),
    batch_id: z.string().min(1),
    window_start: z.string().refine((s) => !isNaN(Date.parse(s)), {
      message: "window_start must be a valid ISO 8601 date string",
    }),
    window_end: z.string().refine((s) => !isNaN(Date.parse(s)), {
      message: "window_end must be a valid ISO 8601 date string",
    }),
    metrics: z.array(MetricItemSchema),
    propagation_lag_ms: z.number().optional(),
    dropped_count: z.number().int().nonnegative().optional(),
    service: z.string().optional(),
    service_name: z.string().optional(),
    env: z.string().optional(),
    sdk_version: z.string().optional(),
  })
  .strict()
  .refine(
    (data) =>
      new Date(data.window_start).getTime() <=
      new Date(data.window_end).getTime(),
    {
      message: "window_start must be less than or equal to window_end",
      path: ["window_start"],
    },
  );

export type TelemetryBatchPayload = z.infer<typeof TelemetryBatchPayloadSchema>;

/**
 * Bulkhead Telemetry Ingestion Route Plugin.
 *
 * Implements Invariant 5 (Zero-Context Privacy) & ARCH §4.4:
 * - Dedicated telemetryPool bulkhead isolates telemetry flushes from lease traffic.
 * - Sheds load with HTTP 429 / 503 upon pool connection timeout or exhaustion.
 * - Rejects any payload containing user IDs, context, or targeting attributes.
 * - Deterministically sorts metrics by code-unit order (flag_key ASC, variant ASC, reason ASC) before upsert,
 *   preventing PostgreSQL row-lock deadlocks during concurrent multi-row batch writes.
 * - Atomically updates service heartbeats and aggregates daily evaluation counts.
 */
export const telemetryRoutes: FastifyPluginAsync<
  TelemetryRoutesOptions
> = async (fastify, options) => {
  const { telemetryPool, metrics } = options;

  const handleTelemetryBatch = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const rawBody = req.body as Record<string, unknown> | null;

    // 1. Invariant 5: Check top-level payload for forbidden context attributes
    if (rawBody && typeof rawBody === "object") {
      for (const key of Object.keys(rawBody)) {
        if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
          return reply.code(400).send({
            error: `Zero-Context violation: batch contains forbidden context or targeting attribute "${key}"`,
          });
        }
      }

      // Check metric items for forbidden context attributes
      if (Array.isArray(rawBody.metrics)) {
        for (const item of rawBody.metrics) {
          if (item && typeof item === "object") {
            for (const key of Object.keys(item)) {
              if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
                return reply.code(400).send({
                  error: `Zero-Context violation: metric tuple contains forbidden context attribute "${key}"`,
                });
              }
            }
          }
        }
      }
    }

    // 2. Validate payload schema (strictly typed root and metric tuples)
    const parseResult = TelemetryBatchPayloadSchema.safeParse(rawBody);
    if (!parseResult.success) {
      const hasUnrecognized = parseResult.error.issues.some(
        (issue) => issue.code === "unrecognized_keys",
      );
      return reply.code(400).send({
        error: hasUnrecognized
          ? "Zero-Context violation: unrecognized keys in telemetry payload"
          : "Invalid telemetry batch payload",
        details: parseResult.error.issues,
      });
    }

    const payload = parseResult.data;

    // 3. Resolve service, env, and sdk_version (from body, headers, or token)
    let service =
      payload.service ||
      payload.service_name ||
      (req.headers["x-service-name"] as string) ||
      (req.headers["x-service"] as string);

    let env =
      payload.env ||
      (req.headers["x-env"] as string) ||
      (req.headers["x-synapse-env"] as string);

    const sdkVersion =
      payload.sdk_version ||
      (req.headers["x-sdk-version"] as string) ||
      (req.headers["x-synapse-sdk-version"] as string) ||
      "unknown";

    // 4. Check Bearer token in Authorization header against api_tokens if service/env not explicit
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ") && (!service || !env)) {
      const rawToken = authHeader.slice(7).trim();
      const tokenHash = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");
      try {
        const tokenRes = await telemetryPool.query<{
          service_name: string;
          env: string;
        }>(
          "SELECT service_name, env FROM api_tokens WHERE token_hash = $1 LIMIT 1",
          [tokenHash],
        );
        if (tokenRes.rows[0]) {
          service = service || tokenRes.rows[0].service_name;
          env = env || tokenRes.rows[0].env;
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (
          errMsg.includes("timeout") ||
          (err as { code?: string }).code === "ETIMEDOUT"
        ) {
          return reply.code(429).send({
            error: "Too Many Requests",
            message: "Telemetry token lookup timed out; load shed.",
          });
        }
        // Non-blocking fallback for other non-timeout errors
      }
    }

    const resolvedService = service || "default-service";
    const resolvedEnv = env || "default";

    if (!service || !env) {
      req.log.warn(
        {
          instance_id: payload.instance_id,
          service: resolvedService,
          env: resolvedEnv,
        },
        "Telemetry batch ingested without explicit service/env metadata; attributing to default bucket",
      );
    }

    // 5. Invariant 3 (Deadlock Prevention): Coalesce and sort metric keys deterministically using code-unit comparison
    const metricMap = new Map<string, MetricItem>();
    for (const item of payload.metrics) {
      const compositeKey = `${item.flag_key}\0${item.variant}\0${item.reason}`;
      const existing = metricMap.get(compositeKey);
      if (existing) {
        existing.count += item.count;
      } else {
        metricMap.set(compositeKey, { ...item });
      }
    }

    const sortedMetrics = Array.from(metricMap.values()).sort((a, b) => {
      if (a.flag_key !== b.flag_key) return a.flag_key < b.flag_key ? -1 : 1;
      if (a.variant !== b.variant) return a.variant < b.variant ? -1 : 1;
      if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
      return 0;
    });

    // 6. Connect to isolated telemetryPool bulkhead with load shedding
    let client: PoolClient;
    try {
      client = await telemetryPool.connect();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        errMsg.includes("timeout") ||
        (err as { code?: string }).code === "ETIMEDOUT" ||
        (err as { code?: string }).code === "ECONNREFUSED";

      if (isTimeout) {
        return reply.code(429).send({
          error: "Too Many Requests",
          message:
            "Telemetry connection pool exhausted or timed out; load shed.",
        });
      }

      return reply.code(503).send({
        error: "Service Unavailable",
        message: "Telemetry pool unavailable; load shed.",
      });
    }

    try {
      await client.query("BEGIN");

      // 7. Heartbeat update in services table (preserving existing sdk_version if current is 'unknown')
      await client.query(
        `INSERT INTO services (name, env, status, first_seen, last_seen, silent_since, sdk_version)
         VALUES ($1, $2, 'ACTIVE', NOW(), NOW(), NULL, $3)
         ON CONFLICT (name, env)
         DO UPDATE SET 
           last_seen = NOW(),
           status = 'ACTIVE',
           silent_since = NULL,
           sdk_version = COALESCE(NULLIF(EXCLUDED.sdk_version, 'unknown'), services.sdk_version)`,
        [resolvedService, resolvedEnv, sdkVersion],
      );

      // 8. Idempotent multi-row upsert into flag_usage_daily
      if (sortedMetrics.length > 0) {
        const usageDate = new Date(payload.window_end)
          .toISOString()
          .slice(0, 10);
        const windowStart = new Date(payload.window_start);
        const windowEnd = new Date(payload.window_end);

        const valueClauses: string[] = [];
        const params: unknown[] = [];
        let pIdx = 1;

        for (const m of sortedMetrics) {
          valueClauses.push(
            `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7})`,
          );
          params.push(
            m.flag_key,
            resolvedEnv,
            resolvedService,
            m.variant,
            usageDate,
            m.count,
            windowStart,
            windowEnd,
          );
          pIdx += 8;
        }

        const upsertSql = `
          INSERT INTO flag_usage_daily (flag_key, env, service, variant, usage_date, eval_count, first_seen, last_seen)
          VALUES ${valueClauses.join(", ")}
          ON CONFLICT (flag_key, env, service, variant, usage_date)
          DO UPDATE SET 
            eval_count = flag_usage_daily.eval_count + EXCLUDED.eval_count,
            last_seen = GREATEST(flag_usage_daily.last_seen, EXCLUDED.last_seen)
        `;

        await client.query(upsertSql, params);
      }

      await client.query("COMMIT");

      if (payload.propagation_lag_ms !== undefined && metrics) {
        metrics.leasePropagationSeconds.observe(
          payload.propagation_lag_ms / 1000,
        );
      }

      return reply.code(202).send({
        accepted: true,
        batch_id: payload.batch_id,
      });
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => {});
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes("timeout") ||
        (err as { code?: string }).code === "ETIMEDOUT"
      ) {
        return reply.code(429).send({
          error: "Too Many Requests",
          message: "Telemetry query timed out; load shed.",
        });
      }
      throw err;
    } finally {
      client.release();
    }
  };

  fastify.post("/v1/telemetry/batches", handleTelemetryBatch);
  fastify.post("/v1/telemetry/flags", handleTelemetryBatch);
};
