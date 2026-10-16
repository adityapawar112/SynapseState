import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import type { Keyset } from "@synapsestate/lease";
import { leasePool, telemetryPool } from "./db/pool.js";
import { createKeysetProvider, type KeysetProvider } from "./keyset.js";
import { StateManager } from "./services/state-manager.js";
import { AuditSealer } from "./sealer/index.js";
import { timeRoutes } from "./routes/time.js";
import { leaseRoutes } from "./routes/leases.js";
import { stateRoutes } from "./routes/state.js";
import { healthRoutes } from "./routes/health.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { changeRoutes } from "./routes/changes.js";
import { metricsRoutes } from "./routes/metrics.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { getMetricsRegistry, type SynapseMetrics } from "./metrics/index.js";
import {
  type GitHubReconciler,
  type GitHubClient,
  GitHubReconciler as DefaultGitHubReconciler,
  createGitHubClient,
} from "./github/index.js";

export interface ServerOptions {
  fastifyOptions?: FastifyServerOptions;
  leasePool?: Pool;
  telemetryPool?: Pool;
  keyset?: Keyset;
  keysetPath?: string;
  keysetProvider?: KeysetProvider;
  stateManager?: StateManager;
  auditSealer?: AuditSealer;
  enableAuditSealer?: boolean;
  metrics?: SynapseMetrics;
  githubClient?: GitHubClient;
  githubReconciler?: GitHubReconciler;
  githubWebhookSecret?: string;
}

/**
 * Creates and configures the Control API Fastify server instance.
 */
export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify(
    options.fastifyOptions ?? {
      logger: process.env.NODE_ENV === "test" ? false : true,
    },
  );

  const activePool = options.leasePool ?? leasePool;
  const activeTelemetryPool = options.telemetryPool ?? telemetryPool;
  const activeKeysetProvider =
    options.keysetProvider ??
    createKeysetProvider({
      keyset: options.keyset,
      keysetPath: options.keysetPath,
    });
  const activeStateManager =
    options.stateManager ?? new StateManager(activePool);
  const activeMetrics = options.metrics ?? getMetricsRegistry();

  let activeReconciler = options.githubReconciler;
  if (!activeReconciler && (process.env.GITHUB_OWNER || options.githubClient)) {
    const client = options.githubClient ?? createGitHubClient();
    activeReconciler = new DefaultGitHubReconciler(client, {
      owner: process.env.GITHUB_OWNER || "synapsestate",
      repo: process.env.GITHUB_REPO || "flags",
      baseBranch: process.env.GITHUB_BASE_BRANCH || "main",
    });
  }

  // Parse JSON with raw body capture for HMAC verification
  server.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      try {
        (_req as unknown as { rawBody?: Buffer | string }).rawBody = body;
        if (!body || body.length === 0) {
          done(null, {});
          return;
        }
        const json = JSON.parse(body.toString("utf-8"));
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
  void server.register(metricsRoutes, {
    metrics: activeMetrics,
    leasePool: activePool,
  });
  void server.register(leaseRoutes, {
    leasePool: activePool,
    keysetProvider: activeKeysetProvider,
    stateManager: activeStateManager,
    metrics: activeMetrics,
    githubReconciler: activeReconciler,
  });
  void server.register(stateRoutes, {
    stateManager: activeStateManager,
    metrics: activeMetrics,
  });
  void server.register(telemetryRoutes, {
    telemetryPool: activeTelemetryPool,
    metrics: activeMetrics,
  });
  void server.register(changeRoutes, {
    leasePool: activePool,
  });
  void server.register(webhookRoutes, {
    leasePool: activePool,
    stateManager: activeStateManager,
    metrics: activeMetrics,
    webhookSecret: options.githubWebhookSecret,
  });

  // Audit Sealer configuration and lifecycle management
  let activeAuditSealer: AuditSealer | undefined = options.auditSealer;
  if (!activeAuditSealer && options.enableAuditSealer) {
    activeAuditSealer = new AuditSealer({
      pool: activePool,
      metrics: activeMetrics,
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
