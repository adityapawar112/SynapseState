import type { FastifyPluginAsync } from "fastify";

/**
 * Time Synchronization Route.
 *
 * Implements ARCHITECTURE §4.2 Step 1 & SpecDoc §4.1:
 * - GET /v1/time: Returns authoritative server timestamp for workstation clock synchronization
 *   prior to Ed25519 payload signing.
 */
export const timeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/time", async (_req, reply) => {
    return reply
      .header("Cache-Control", "no-cache, no-store, must-revalidate")
      .send({
        server_time: new Date().toISOString(),
      });
  });
};
