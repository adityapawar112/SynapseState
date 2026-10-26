import type { FastifyPluginAsync } from "fastify";
import type { StateManager } from "../services/state-manager.js";
import type { SynapseMetrics } from "../metrics/index.js";

export interface StateRoutesOptions {
  stateManager: StateManager;
  metrics?: SynapseMetrics;
}

/**
 * Parses wait duration parameter in seconds.
 * Supports strings like "30s", "30", or numbers. Defaults to 0s, max 60s.
 */
export function parseWaitSeconds(rawWait?: unknown): number {
  if (rawWait === undefined || rawWait === null || rawWait === "") {
    return 0;
  }
  const str = String(rawWait).trim().toLowerCase();
  const match = str.match(/^(\d{1,2})s?$/);
  if (!match) {
    return 0;
  }
  const parsed = parseInt(match[1], 10);
  return Math.min(Math.max(parsed, 0), 60);
}

/**
 * ETag Long-Polling State Delivery Route.
 *
 * Implements ARCHITECTURE §4.1, ADR 0003 & SpecDoc §4.1:
 * - GET /v1/sdk/state?env={env}&wait=30s
 * - Handles If-None-Match conditional caching.
 * - Serves 304 Not Modified immediately when wait=0 or unchanged.
 * - Suspends long-polling request in Node.js memory up to wait seconds.
 * - Instantly resumes (<100ms) and delivers HTTP 200 on state changes.
 * - Clean lifecycle on client socket disconnect.
 */
export const stateRoutes: FastifyPluginAsync<StateRoutesOptions> = async (
  fastify,
  options,
) => {
  const { stateManager, metrics } = options;

  const handleStateRequest = async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const startTime = process.hrtime.bigint();
    const recordMetric = (statusCode: number) => {
      if (metrics) {
        const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
        metrics.statePollDurationSeconds.observe(
          { status_code: String(statusCode) },
          durationSec,
        );
      }
    };

    const query = req.query as { env?: string; wait?: string };
    const env = query.env || "prod";

    // Validate env format to prevent unbounded cardinality / cache key injection (P1.7)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(env)) {
      recordMetric(400);
      return reply.code(400).send({
        error:
          "Invalid environment parameter. Must be alphanumeric with hyphens or underscores (1-64 characters).",
      });
    }

    const waitSeconds = parseWaitSeconds(query.wait);

    const ifNoneMatchHeader = req.headers["if-none-match"];
    const ifNoneMatch = Array.isArray(ifNoneMatchHeader)
      ? ifNoneMatchHeader[0]
      : ifNoneMatchHeader;

    const abortController = new AbortController();
    const onClose = () => {
      abortController.abort();
    };
    req.raw.on("close", onClose);

    try {
      const result = await stateManager.waitForChange(
        env,
        ifNoneMatch,
        waitSeconds,
        abortController.signal,
      );

      // Clean up abort listener
      req.raw.removeListener("close", onClose);

      // Reply-after-abort guard: if socket was destroyed or aborted, exit without writing (P1.8)
      if (req.raw.destroyed || abortController.signal.aborted) {
        return;
      }

      if (result.status === 304) {
        recordMetric(304);
        return reply
          .code(304)
          .header("ETag", `"${result.state.etag}"`)
          .header("Cache-Control", "no-cache, no-store, must-revalidate")
          .send();
      }

      const payload = stateManager.formatPayload(result.state);
      recordMetric(200);
      return reply
        .code(200)
        .header("ETag", `"${result.state.etag}"`)
        .header("Cache-Control", "no-cache, no-store, must-revalidate")
        .send(payload);
    } catch (err) {
      recordMetric(500);
      req.raw.removeListener("close", onClose);
      req.log.error(err, "Error in state delivery route");
      throw err;
    }
  };

  fastify.get("/v1/sdk/state", handleStateRequest);
  fastify.get("/v1/state", handleStateRequest);
};
