import type { FastifyPluginAsync } from "fastify";
import type { StateManager } from "../services/state-manager.js";

export interface StateRoutesOptions {
  stateManager: StateManager;
}

/**
 * Parses wait duration parameter in seconds.
 * Supports strings like "30s", "30", or numbers. Defaults to 0s, max 60s.
 */
export function parseWaitSeconds(rawWait?: unknown): number {
  if (rawWait === undefined || rawWait === null || rawWait === "") {
    return 0;
  }
  let str = String(rawWait).trim().toLowerCase();
  if (str.endsWith("s")) {
    str = str.slice(0, -1);
  }
  const parsed = parseInt(str, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, 60);
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
  options
) => {
  const { stateManager } = options;

  fastify.get("/v1/sdk/state", async (req, reply) => {
    const query = req.query as { env?: string; wait?: string };
    const env = query.env || "prod";
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
        abortController.signal
      );

      // Clean up abort listener
      req.raw.removeListener("close", onClose);

      if (result.status === 304) {
        return reply
          .code(304)
          .header("ETag", `"${result.state.etag}"`)
          .send();
      }

      const payload = stateManager.formatPayload(result.state);
      return reply
        .code(200)
        .header("ETag", `"${result.state.etag}"`)
        .send(payload);
    } catch (err) {
      req.raw.removeListener("close", onClose);
      req.log.error(err, "Error in state delivery route");
      throw err;
    }
  });
};
