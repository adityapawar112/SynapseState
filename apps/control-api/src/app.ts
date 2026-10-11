import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import type { Keyset } from "@synapsestate/lease";
import { leasePool } from "./db/pool.js";
import { createKeysetProvider, type KeysetProvider } from "./keyset.js";
import { StateManager } from "./services/state-manager.js";
import { AuditSealer } from "./sealer/index.js";
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
  auditSealer?: AuditSealer;
  enableAuditSealer?: boolean;
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

  // Audit Sealer configuration and lifecycle management
  let activeAuditSealer: AuditSealer | undefined = options.auditSealer;
  if (!activeAuditSealer && options.enableAuditSealer) {
    activeAuditSealer = new AuditSealer({
      pool: activePool,
    });
  }

  if (activeAuditSealer) {
    const sealer = activeAuditSealer;
    server.addHook("onReady", async () => {
      sealer.start();
    });

    server.addHook("onClose", async () => {
      await sealer.stop();
    });
  }

  return server;
}
