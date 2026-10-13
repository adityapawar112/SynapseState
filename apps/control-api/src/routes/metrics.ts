import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { getMetricsRegistry, type SynapseMetrics } from "../metrics/index.js";

export interface MetricsRoutesOptions {
  metrics?: SynapseMetrics;
  leasePool?: Pool;
}

/**
 * Prometheus Metrics Route (GET /metrics).
 *
 * Implements ARCHITECTURE §11.1:
 * - Exports Prometheus text metrics format.
 * - On scrape, optionally refreshes database-backed gauges (active leases, pending queue, chain length).
 * - Enforces fail-safe error containment: DB errors during scrape do not fail the /metrics endpoint.
 */
export const metricsRoutes: FastifyPluginAsync<MetricsRoutesOptions> = async (
  fastify,
  options
) => {
  const metrics = options.metrics ?? getMetricsRegistry();
  const pool = options.leasePool;

  fastify.get("/metrics", async (_req, reply) => {
    if (pool) {
      try {
        // 1. Refresh active leases count per environment
        const activeRes = await pool.query<{ env: string; count: string | number }>(
          `SELECT env, COUNT(*)::bigint AS count 
           FROM leases 
           WHERE state = 'ACTIVE' AND expires_at > NOW() 
           GROUP BY env;`
        );
        for (const row of activeRes.rows) {
          metrics.leasesActive.set({ env: row.env }, Number(row.count));
        }

        // 2. Refresh audit pending queue size and age
        const pendingRes = await pool.query<{ count: string | number; oldest_created_at: Date | string | null }>(
          `SELECT COUNT(*)::bigint AS count, MIN(created_at) AS oldest_created_at 
           FROM audit_pending;`
        );
        if (pendingRes.rows.length > 0) {
          const row = pendingRes.rows[0]!;
          metrics.auditPendingQueueSize.set(Number(row.count));
          if (row.oldest_created_at) {
            const oldestMs = new Date(row.oldest_created_at).getTime();
            const ageSeconds = Math.max(0, (Date.now() - oldestMs) / 1000);
            metrics.auditPendingAgeSeconds.set(ageSeconds);
          } else {
            metrics.auditPendingAgeSeconds.set(0);
          }
        }

        // 3. Refresh audit chain length
        const chainRes = await pool.query<{ max_seq: string | number }>(
          "SELECT COALESCE(MAX(seq), 0)::bigint AS max_seq FROM audit_events;"
        );
        if (chainRes.rows.length > 0) {
          metrics.auditChainLength.set(Number(chainRes.rows[0]!.max_seq));
        }
      } catch (err) {
        // Defensive error containment: scrape continues even if database query fails
        fastify.log.warn({ err }, "[GET /metrics] Warning refreshing database metrics during scrape");
      }
    }

    const payload = await metrics.registry.metrics();
    return reply
      .header("Content-Type", metrics.registry.contentType)
      .send(payload);
  });
};
