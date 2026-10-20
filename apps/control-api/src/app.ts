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
import { auditRoutes } from "./routes/audit.js";
import { getMetricsRegistry, type SynapseMetrics } from "./metrics/index.js";
import {
  type GitHubReconciler,
  type GitHubClient,
  GitHubReconciler as DefaultGitHubReconciler,
  createGitHubClient,
} from "./github/index.js";
import {
  type GrafanaClient,
  createGrafanaClient,
} from "./grafana/index.js";

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
  githubOwner?: string;
  githubRepo?: string;
  githubBaseBranch?: string;
  alertmanagerWebhookSecret?: string;
  grafanaUrl?: string;
  grafanaApiKey?: string;
  grafanaClient?: GrafanaClient;
  lookbackMinutes?: number;
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

  const githubOwner = options.githubOwner ?? process.env.GITHUB_OWNER;
  const githubRepo = options.githubRepo ?? process.env.GITHUB_REPO;
  const githubBaseBranch =
    options.githubBaseBranch ?? process.env.GITHUB_BASE_BRANCH;

  let activeReconciler = options.githubReconciler;
  if (!activeReconciler && (githubOwner || options.githubClient)) {
    const client = options.githubClient ?? createGitHubClient();
    activeReconciler = new DefaultGitHubReconciler(client, {
      owner: githubOwner || "synapsestate",
      repo: githubRepo || "flags",
      baseBranch: githubBaseBranch || "main",
    });
  }

  const grafanaUrl = options.grafanaUrl ?? process.env.GRAFANA_URL;
  const grafanaApiKey =
    options.grafanaApiKey ??
    process.env.GRAFANA_API_KEY ??
    process.env.GRAFANA_TOKEN;

  let activeGrafanaClient = options.grafanaClient;
  if (!activeGrafanaClient && grafanaUrl && grafanaApiKey) {
    activeGrafanaClient = createGrafanaClient({
      url: grafanaUrl,
      apiKey: grafanaApiKey,
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
    expectedOwner: githubOwner,
    expectedRepo: githubRepo,
    expectedBaseBranch: githubBaseBranch,
    alertmanagerWebhookSecret:
      options.alertmanagerWebhookSecret ?? process.env.ALERTMANAGER_WEBHOOK_SECRET,
    grafanaClient: activeGrafanaClient,
    grafanaUrl,
    grafanaApiKey,
    lookbackMinutes: options.lookbackMinutes,
  });
  void server.register(auditRoutes, {
    leasePool: activePool,
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

  if (process.env.NODE_ENV !== "production") {
    server.post("/__test/reset", async (_req, reply) => {
      try {
        const now = Date.now();
        const activeIssuedAt = new Date(now - 120_000).toISOString();
        const nearIssuedAt = new Date(now - 360_000).toISOString();
        const expIssuedAt = new Date(now - 600_000).toISOString();

        await activePool.query("DELETE FROM revocations");
        await activePool.query("DELETE FROM audit_pending");

        await activePool.query(
          `UPDATE leases 
           SET state = 'ACTIVE', 
               issued_at = $1, 
               expires_at = NOW() + INTERVAL '28 minutes', 
               payload = jsonb_set(payload, '{issued_at}', to_jsonb($1::text)),
               promote_pr_url = NULL 
           WHERE lease_id = '01J9X57YTRPQ8A7F4E00112233'`,
          [activeIssuedAt]
        );

        await activePool.query(
          `UPDATE leases 
           SET state = 'ACTIVE', 
               issued_at = $1, 
               expires_at = NOW() + INTERVAL '4 minutes', 
               payload = jsonb_set(payload, '{issued_at}', to_jsonb($1::text))
           WHERE lease_id = '01J9X57YTRPQ8A7F4E00445566'`,
          [nearIssuedAt]
        );

        await activePool.query(
          `UPDATE leases 
           SET state = 'EXPIRED', 
               issued_at = $1, 
               expires_at = NOW() - INTERVAL '9 minutes', 
               payload = jsonb_set(payload, '{issued_at}', to_jsonb($1::text))
           WHERE lease_id = '01J9X57YTRPQ8A7F4E00778899'`,
          [expIssuedAt]
        );

        await activeStateManager.notifyChange();
      } catch (err) {
        server.log.warn({ err }, "[/__test/reset] Error during test reset query");
      }
      return reply.code(200).send({ status: "reset" });
    });
  }

  return server;
}
