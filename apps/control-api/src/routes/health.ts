import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";

export interface HealthRoutesOptions {
  leasePool: Pool;
}

/**
 * Health and Readiness Probes.
 *
 * Implements Kubernetes standard container lifecycle probes:
 * - GET /healthz: Liveness probe verifying process responsiveness.
 * - GET /readyz: Readiness probe verifying PostgreSQL database connectivity.
 */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  fastify,
  options,
) => {
  const { leasePool } = options;

  fastify.get("/healthz", async () => {
    return { status: "ok" };
  });

  fastify.get("/readyz", async (_req, reply) => {
    try {
      await leasePool.query("SELECT 1");
      return { status: "ok", db: "connected" };
    } catch (err) {
      reply.code(503);
      return {
        status: "error",
        db: "disconnected",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
};
