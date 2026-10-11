import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import type { Keyset } from "@synapsestate/lease";
import { leasePool } from "./db/pool.js";
import { createKeysetProvider, type KeysetProvider } from "./keyset.js";
import { StateManager } from "./services/state-manager.js";
import { timeRoutes } from "./routes/time.js";
import { leaseRoutes } from "./routes/leases.js";
import { stateRoutes } from "./routes/state.js";
import { healthRoutes } from "./routes/health.js";

export interface ServerOptions {
  fastifyOptions?: FastifyServerOptions;
  leasePool?: Pool;
  keyset?: Keyset;
  keysetPath?: string;
  keysetProvider?: KeysetProvider;
  stateManager?: StateManager;
}

/**
 * Creates and configures the Control API Fastify server instance.
 */
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify(
    options.fastifyOptions ?? {
      logger: process.env.NODE_ENV === "test" ? false : true,
    }
  );

  const activePool = options.leasePool ?? leasePool;
  const activeKeysetProvider =
    options.keysetProvider ??
    createKeysetProvider({
      keyset: options.keyset,
      keysetPath: options.keysetPath,
    });
  const activeStateManager = options.stateManager ?? new StateManager(activePool);

  // Enable CORS
  void server.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "If-None-Match"],
    exposedHeaders: ["ETag"],
  });

  // Register route plugins
  void server.register(healthRoutes, { leasePool: activePool });
  void server.register(timeRoutes);
  void server.register(leaseRoutes, {
    leasePool: activePool,
    keysetProvider: activeKeysetProvider,
    stateManager: activeStateManager,
  });
  void server.register(stateRoutes, {
    stateManager: activeStateManager,
  });

  return server;
}
