import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { withTransaction } from "../db/transaction.js";
import type { StateManager } from "../services/state-manager.js";
import type { SynapseMetrics } from "../metrics/index.js";
import type { GitHubWebhookPullRequestPayload } from "../github/types.js";
import type { GrafanaClient } from "../grafana/index.js";
import {
  rankSuspects,
  buildRemediationCommand,
  type ChangeEvent,
  type FlagEvaluationRecord,
} from "@synapsestate/lease";

export interface WebhookRoutesOptions {
  leasePool: Pool;
  stateManager: StateManager;
  metrics?: SynapseMetrics;
  webhookSecret?: string;
  expectedOwner?: string;
  expectedRepo?: string;
  expectedBaseBranch?: string;
  alertmanagerWebhookSecret?: string;
  grafanaUrl?: string;
  grafanaApiKey?: string;
  grafanaClient?: GrafanaClient;
  lookbackMinutes?: number;
}

const LEASE_ID_BRANCH_REGEX = /synapse\/promote-lease-([0-9A-HJKMNP-TV-Z]{26})/;

/**
 * GitHub App Webhook Reconciliation Route.
 *
 * Implements ARCHITECTURE §4.3 & ROADMAP §5 Phase 4 PR 18:
 * - Verifies x-hub-signature-256 HMAC SHA-256 with timing-safe comparison.
 * - Filters for merged pull_request events on promotion branches.
 * - Atomically transitions the associated emergency lease to PROMOTED in PostgreSQL.
 * - Emits GIT_MERGE and LEASE_PROMOTED into change_events.
 * - Stages LEASE_PROMOTED into audit_pending for asynchronous cryptographic sealing.
 * - Wakes active long-polling SDKs via stateManager.notifyChange(env) (<100ms lag).
 */
export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (
  fastify,
  options,
) => {
  const { leasePool, stateManager, metrics, webhookSecret } = options;
  const expectedOwner = options.expectedOwner ?? process.env.GITHUB_OWNER;
  const expectedRepo = options.expectedRepo ?? process.env.GITHUB_REPO;
  const expectedBaseBranch =
    options.expectedBaseBranch ?? process.env.GITHUB_BASE_BRANCH;

  if (!expectedOwner || !expectedRepo) {
    fastify.log.warn(
      "[Webhook] Security notice: GITHUB_OWNER or GITHUB_REPO is not configured; source repository verification is inactive",
    );
  }

  fastify.post("/v1/webhooks/github", async (req, reply) => {
    // 1. Webhook secret validation (with SYNAPSE_WEBHOOK_SECRET fallback)
    const secret =
      webhookSecret ??
      process.env.GITHUB_WEBHOOK_SECRET ??
      process.env.SYNAPSE_WEBHOOK_SECRET;
    if (!secret) {
      req.log.error(
        "Neither GITHUB_WEBHOOK_SECRET nor SYNAPSE_WEBHOOK_SECRET is configured on server",
      );
      return reply.code(500).send({
        error: "WEBHOOK_SECRET_NOT_CONFIGURED",
        message: "Webhook secret is not configured on the server",
      });
    }

    // 2. Signature verification
    const sigHeader = req.headers["x-hub-signature-256"];
    if (!sigHeader || typeof sigHeader !== "string") {
      return reply.code(401).send({
        error: "MISSING_SIGNATURE",
        message: "Missing x-hub-signature-256 header",
      });
    }

    const rawPayload = (req as unknown as { rawBody?: Buffer | string })
      .rawBody;
    if (!rawPayload) {
      req.log.error(
        "Raw request body is missing for webhook signature verification",
      );
      return reply.code(500).send({
        error: "RAW_BODY_UNAVAILABLE",
        message:
          "Server configuration error: raw body capture unavailable for webhook signature verification",
      });
    }

    const hmac = crypto
      .createHmac("sha256", secret)
      .update(rawPayload)
      .digest("hex");
    const expectedSig = `sha256=${hmac}`;

    const sigBuf = Buffer.from(sigHeader);
    const expectedBuf = Buffer.from(expectedSig);

    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return reply.code(401).send({
        error: "INVALID_SIGNATURE",
        message: "HMAC SHA-256 signature verification failed",
      });
    }

    // 3. Event filter
    const githubEvent = req.headers["x-github-event"];
    if (githubEvent === "ping") {
      return reply.code(200).send({ status: "pong" });
    }

    if (githubEvent !== "pull_request") {
      return reply.code(200).send({
        status: "ignored",
        reason: `Event "${String(githubEvent)}" ignored`,
      });
    }

    const payload = req.body as GitHubWebhookPullRequestPayload;
    if (payload.action !== "closed" || !payload.pull_request?.merged) {
      return reply.code(200).send({
        status: "ignored",
        reason: "Pull request not merged",
      });
    }

    // Verify source repository matches configured owner/repo (prevent cross-repo forgery)
    if (expectedOwner) {
      const actualOwner = payload.repository?.owner?.login;
      if (!actualOwner) {
        req.log.warn(
          { expectedOwner },
          "[Webhook] Ignoring event with missing repository owner",
        );
        return reply.code(200).send({
          status: "ignored",
          reason: "Missing repository owner in webhook payload",
        });
      }
      if (actualOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
        req.log.warn(
          {
            expectedOwner,
            actualOwner,
          },
          "[Webhook] Ignoring event from unexpected repository owner",
        );
        return reply.code(200).send({
          status: "ignored",
          reason: "Repository owner mismatch",
        });
      }
    }

    if (expectedRepo) {
      const actualRepo = payload.repository?.name;
      if (!actualRepo) {
        req.log.warn(
          { expectedRepo },
          "[Webhook] Ignoring event with missing repository name",
        );
        return reply.code(200).send({
          status: "ignored",
          reason: "Missing repository name in webhook payload",
        });
      }
      if (actualRepo.toLowerCase() !== expectedRepo.toLowerCase()) {
        req.log.warn(
          {
            expectedRepo,
            actualRepo,
          },
          "[Webhook] Ignoring event from unexpected repository name",
        );
        return reply.code(200).send({
          status: "ignored",
          reason: "Repository name mismatch",
        });
      }
    }

    const pr = payload.pull_request;
    if (expectedBaseBranch && pr.base?.ref) {
      if (pr.base.ref !== expectedBaseBranch) {
        req.log.warn(
          {
            expectedBaseBranch,
            actualBaseBranch: pr.base.ref,
          },
          "[Webhook] Ignoring event with unexpected target base branch",
        );
        return reply.code(200).send({
          status: "ignored",
          reason: "Target base branch mismatch",
        });
      }
    }

    const branchName = pr.head.ref;

    // 4. Extract lease ID from branch or URL lookup
    let targetLeaseId: string | null = null;
    const branchMatch = LEASE_ID_BRANCH_REGEX.exec(branchName);
    if (branchMatch) {
      targetLeaseId = branchMatch[1];
    } else if (pr.html_url) {
      const lookup = await leasePool.query<{ lease_id: string }>(
        "SELECT lease_id FROM leases WHERE promote_pr_url = $1 LIMIT 1",
        [pr.html_url],
      );
      if (lookup.rows.length > 0) {
        targetLeaseId = lookup.rows[0].lease_id;
      }
    }

    if (!targetLeaseId) {
      return reply.code(200).send({
        status: "ignored",
        reason: "No matching lease found for promotion branch or PR URL",
      });
    }

    // 5. Transactional reconciliation
    let targetEnv = "";
    let reconciled = false;
    let alreadyPromoted = false;
    let revokedIgnored = false;
    let stateIgnored = false;

    await withTransaction(leasePool, async (client) => {
      const leaseRes = await client.query<{
        lease_id: string;
        flag_key: string;
        env: string;
        state: string;
        created_by_kid: string;
        expires_at: Date;
      }>(
        "SELECT lease_id, flag_key, env, state, created_by_kid, expires_at FROM leases WHERE lease_id = $1 FOR UPDATE",
        [targetLeaseId],
      );

      if (leaseRes.rows.length === 0) {
        return;
      }

      const lease = leaseRes.rows[0];
      targetEnv = lease.env;
      const previousState = lease.state;

      if (previousState === "PROMOTED") {
        alreadyPromoted = true;
        return;
      }

      // Invariant 4 & Lifecycle: Revoked leases must NEVER be promoted
      if (previousState === "REVOKED") {
        revokedIgnored = true;
        return;
      }

      // Only ACTIVE or EXPIRED leases may be promoted
      if (previousState !== "ACTIVE" && previousState !== "EXPIRED") {
        stateIgnored = true;
        return;
      }

      // Transition state to PROMOTED
      await client.query(
        "UPDATE leases SET state = 'PROMOTED' WHERE lease_id = $1",
        [lease.lease_id],
      );

      const afterExpiry = previousState === "EXPIRED";
      const actor = pr.merged_by?.login || lease.created_by_kid;

      // Insert GIT_MERGE event into change_events
      await client.query(
        `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
         VALUES ('GIT_MERGE', $1, $2, $3, NOW(), $4)`,
        [
          lease.env,
          lease.flag_key,
          pr.merged_by?.login || "github-actions",
          JSON.stringify({
            lease_id: lease.lease_id,
            pr_url: pr.html_url,
            pr_number: pr.number,
            branch: pr.head.ref,
            merge_commit_sha: pr.merge_commit_sha,
            merged_at: pr.merged_at,
          }),
        ],
      );

      // Insert LEASE_PROMOTED event into change_events
      await client.query(
        `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
         VALUES ('LEASE_PROMOTED', $1, $2, $3, NOW(), $4)`,
        [
          lease.env,
          lease.flag_key,
          actor,
          JSON.stringify({
            lease_id: lease.lease_id,
            flag_key: lease.flag_key,
            env: lease.env,
            pr_url: pr.html_url,
            merge_commit_sha: pr.merge_commit_sha,
            after_expiry: afterExpiry,
            previous_state: previousState,
          }),
        ],
      );

      // Stage LEASE_PROMOTED into audit_pending
      await client.query(
        `INSERT INTO audit_pending (actor, event_type, payload)
         VALUES ($1, 'LEASE_PROMOTED', $2)`,
        [
          actor,
          JSON.stringify({
            lease_id: lease.lease_id,
            flag_key: lease.flag_key,
            env: lease.env,
            pr_url: pr.html_url,
            merge_commit_sha: pr.merge_commit_sha,
            after_expiry: afterExpiry,
            previous_state: previousState,
          }),
        ],
      );

      // Prometheus metrics
      if (metrics) {
        metrics.leaseTransitionsTotal.inc({
          from: previousState,
          to: "PROMOTED",
        });
        if (previousState === "ACTIVE") {
          metrics.leasesActive.dec({ env: lease.env });
        }
      }

      reconciled = true;
    });

    if (alreadyPromoted) {
      return reply.code(200).send({
        status: "already_promoted",
        lease_id: targetLeaseId,
      });
    }

    if (revokedIgnored) {
      req.log.warn(
        { leaseId: targetLeaseId },
        "[Webhook] Lease is REVOKED and cannot be promoted to Git",
      );
      return reply.code(200).send({
        status: "ignored",
        reason: "Lease has been revoked and cannot be promoted",
      });
    }

    if (stateIgnored) {
      return reply.code(200).send({
        status: "ignored",
        reason: "Lease state is not eligible for promotion",
      });
    }

    if (!reconciled) {
      return reply.code(200).send({
        status: "ignored",
        reason: "Lease not found in database",
      });
    }

    // Wake up active long-polling connections
    if (targetEnv) {
      try {
        await stateManager.notifyChange(targetEnv);
      } catch (notifyErr) {
        req.log.warn(
          { err: notifyErr },
          `[Webhook] Error waking long-polling connections for env "${targetEnv}"`,
        );
      }
    }

    return reply.code(200).send({
      status: "reconciled",
      lease_id: targetLeaseId,
    });
  });

  /**
   * Prometheus Alertmanager Incident Webhook Route.
   *
   * Implements ARCHITECTURE §11.4 & ROADMAP §5 Phase 6 PR 26:
   * - Validates ALERTMANAGER_WEBHOOK_SECRET via timing-safe comparison.
   * - Filters for firing alerts and stages INCIDENT_ALERT_RECEIVED into audit_pending.
   * - Correlates with recent change_events and flag_usage_daily within configurable lookback.
   * - Ranks suspect flag modifications using shared rankSuspects pure heuristic.
   * - Stages INCIDENT_ATTRIBUTION_EMITTED into audit_pending when a change is attributed.
   * - Formats copy-pasteable emergency override commands for incident responders.
   * - Emits Grafana annotations with fail-open timeout protection.
   */
  fastify.post("/v1/webhooks/alertmanager", async (req, reply) => {
    // 1. Secret validation
    const alertSecret =
      options.alertmanagerWebhookSecret ?? process.env.ALERTMANAGER_WEBHOOK_SECRET;

    if (!alertSecret) {
      req.log.warn(
        "Alertmanager webhook called but ALERTMANAGER_WEBHOOK_SECRET is not configured",
      );
      return reply.code(503).send({
        error: "SERVICE_UNAVAILABLE",
        message:
          "Alertmanager webhook is not enabled: ALERTMANAGER_WEBHOOK_SECRET is not configured on this server",
      });
    }

    const headerSecret =
      typeof req.headers["x-alertmanager-secret"] === "string"
        ? req.headers["x-alertmanager-secret"]
        : undefined;
    const authHeader = req.headers.authorization;
    let bearerSecret: string | undefined;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      bearerSecret = authHeader.slice(7).trim();
    }

    // Fixed-length SHA-256 comparison without early short-circuit (I1)
    const matchHeader = isTimingSafeMatch(headerSecret, alertSecret);
    const matchBearer = isTimingSafeMatch(bearerSecret, alertSecret);
    const isAuthorized = matchHeader || matchBearer;

    if (!isAuthorized) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Missing or invalid Alertmanager webhook secret",
      });
    }

    // 2. Payload validation
    const body = req.body as AlertmanagerPayload | undefined;
    if (!body || typeof body !== "object" || !Array.isArray(body.alerts)) {
      return reply.code(400).send({
        error: "INVALID_PAYLOAD",
        message: "Malformed Alertmanager payload: expected alerts array",
      });
    }

    const firingAlerts = body.alerts.filter((a) => a.status === "firing");
    if (firingAlerts.length === 0) {
      return reply.code(200).send({
        status: "ignored",
        reason: "No firing alerts in payload",
      });
    }

    // 3. Attribution & Correlation
    // Clamp lookbackMinutes to [1, 1440] (1m to 24h) to avoid DoS query exhaustion (I2)
    const rawLookback = Number(options.lookbackMinutes);
    const lookbackMinutes = Number.isFinite(rawLookback)
      ? Math.min(1440, Math.max(1, Math.round(rawLookback)))
      : 60;

    // Cap processed firing alerts per batch (max 10) to prevent connection starvation (I2)
    const MAX_ALERTS_PER_BATCH = 10;
    const alertsToProcess = firingAlerts.slice(0, MAX_ALERTS_PER_BATCH);
    const isTruncated = firingAlerts.length > MAX_ALERTS_PER_BATCH;
    if (isTruncated) {
      req.log.warn(
        { count: firingAlerts.length, max: MAX_ALERTS_PER_BATCH },
        "[Webhook] Truncating firing alerts batch to maximum limit (10)",
      );
    }

    const attributions: Array<{
      alertname: string;
      service?: string;
      env: string;
      attributed: boolean;
      suspected_flag?: string;
      score?: number;
      remediation_command?: string;
      reason?: string;
      grafana_annotation_id?: number;
    }> = [];

    for (const alert of alertsToProcess) {
      const alertname = alert.labels?.alertname || "UnknownAlert";
      const env = alert.labels?.env || "production";
      const service =
        alert.labels?.service ||
        alert.labels?.app ||
        alert.labels?.job ||
        alert.labels?.repo ||
        "";

      const parsedStartsAt = alert.startsAt ? new Date(alert.startsAt) : new Date();
      const startsAtDate = Number.isFinite(parsedStartsAt.getTime())
        ? parsedStartsAt
        : new Date();

      // Lookback window: default 60 minutes prior to startsAtDate
      const lookbackMs = lookbackMinutes * 60 * 1000;
      const lookbackStart = new Date(startsAtDate.getTime() - lookbackMs);
      // Small skew tolerance (30s) prevents causality inversion (I3)
      const SKEW_TOLERANCE_MS = 30_000;
      const lookbackEnd = new Date(
        Math.min(
          startsAtDate.getTime() + SKEW_TOLERANCE_MS,
          Date.now() + SKEW_TOLERANCE_MS,
        ),
      );

      // Execute database operations per alert atomically inside transaction (I4)
      const alertAttributionResult = await withTransaction(
        leasePool,
        async (client) => {
          // Stage INCIDENT_ALERT_RECEIVED into audit_pending
          await client.query(
            `INSERT INTO audit_pending (actor, event_type, payload)
             VALUES ($1, 'INCIDENT_ALERT_RECEIVED', $2)`,
            [
              "alertmanager",
              JSON.stringify({
                alertname,
                service,
                env,
                severity: alert.labels?.severity || "unknown",
                starts_at: startsAtDate.toISOString(),
                annotations: alert.annotations || {},
              }),
            ],
          );

          // Query change_events for env
          const changeSql = `
            SELECT id, event_type, env, flag_key, actor, occurred_at, payload
            FROM change_events
            WHERE env = $1 AND occurred_at >= $2 AND occurred_at <= $3
            ORDER BY occurred_at DESC, id DESC
            LIMIT 50
          `;
          const changeRes = await client.query<{
            id: string | number;
            event_type: string;
            env: string;
            flag_key: string | null;
            actor: string;
            occurred_at: Date | string;
            payload: unknown;
          }>(changeSql, [env, lookbackStart, lookbackEnd]);

          // Safe row-by-row parse prevents corrupt rows from failing the entire batch (C2)
          const events: ChangeEvent[] = [];
          for (const row of changeRes.rows) {
            let payload: Record<string, unknown> = {};
            try {
              if (typeof row.payload === "string") {
                payload = JSON.parse(row.payload);
              } else if (row.payload && typeof row.payload === "object") {
                payload = row.payload as Record<string, unknown>;
              }
            } catch (err) {
              req.log.warn(
                { err, rowId: row.id },
                "[Webhook] Malformed change_events payload JSON; falling back to empty payload",
              );
              payload = {};
            }

            let occurredAtIso: string;
            try {
              if (row.occurred_at instanceof Date) {
                occurredAtIso = row.occurred_at.toISOString();
              } else {
                const d = new Date(row.occurred_at);
                occurredAtIso = Number.isFinite(d.getTime())
                  ? d.toISOString()
                  : new Date(0).toISOString();
              }
            } catch {
              occurredAtIso = new Date(0).toISOString();
            }

            events.push({
              id: Number(row.id),
              event_type: row.event_type || "UNKNOWN",
              env: row.env || env,
              flag_key: row.flag_key,
              actor: row.actor || "unknown",
              occurred_at: occurredAtIso,
              payload,
            });
          }

          // Query flag_usage_daily
          let evalSql = `
            SELECT flag_key, variant, SUM(eval_count)::bigint AS eval_count
            FROM flag_usage_daily
            WHERE env = $1 AND usage_date >= $2
          `;
          const evalParams: unknown[] = [
            env,
            lookbackStart.toISOString().slice(0, 10),
          ];
          if (service) {
            evalParams.push(service);
            evalSql += ` AND service = $${evalParams.length}`;
          }
          evalSql += ` GROUP BY flag_key, variant ORDER BY flag_key ASC, variant ASC`;

          const evalRes = await client.query<{
            flag_key: string;
            variant: string;
            eval_count: string | number;
          }>(evalSql, evalParams);

          const evaluations: FlagEvaluationRecord[] = evalRes.rows.map((r) => ({
            flag_key: r.flag_key,
            variant: r.variant,
            eval_count: Number(r.eval_count),
          }));

          // Attribution heuristic using shared pure ranker
          const suspects = rankSuspects(
            events,
            evaluations,
            service,
            startsAtDate.getTime(),
          );

          if (suspects.length === 0) {
            return {
              attributed: false,
              reason: "No recent flag changes found within lookback window",
              startsAtDate,
              alertname,
              service: service || undefined,
              env,
            };
          }

          const topSuspect = suspects[0];
          const safeAlertName = alertname.replace(/[^a-zA-Z0-9_.-]/g, "_");
          const remediationReason = `Incident attribution: ${safeAlertName}`;

          // Centralized remediation command with POSIX shell quoting for all args (C1, I7)
          const remediationCommand = buildRemediationCommand({
            flagKey: topSuspect.flag_key,
            env,
            value: topSuspect.suggested_action.suggested_value,
            ttl: "30m",
            reason: remediationReason,
          });

          // Stage INCIDENT_ATTRIBUTION_EMITTED into audit_pending
          await client.query(
            `INSERT INTO audit_pending (actor, event_type, payload)
             VALUES ($1, 'INCIDENT_ATTRIBUTION_EMITTED', $2)`,
            [
              "alertmanager",
              JSON.stringify({
                alertname,
                service,
                env,
                suspected_flag: topSuspect.flag_key,
                score: topSuspect.score,
                remediation_command: remediationCommand,
                starts_at: startsAtDate.toISOString(),
              }),
            ],
          );

          return {
            attributed: true,
            suspected_flag: topSuspect.flag_key,
            score: topSuspect.score,
            remediation_command: remediationCommand,
            occurred_at: topSuspect.occurred_at,
            startsAtDate,
            alertname,
            service: service || undefined,
            env,
          };
        },
      );

      // Dispatch Grafana annotation (fail-open outside transaction)
      let annotationId: number | undefined;
      const grafanaClient = options.grafanaClient;
      if (
        alertAttributionResult.attributed &&
        grafanaClient &&
        alertAttributionResult.suspected_flag &&
        alertAttributionResult.remediation_command
      ) {
        try {
          const timeAgo = formatRelativeTime(
            alertAttributionResult.occurred_at || new Date().toISOString(),
            alertAttributionResult.startsAtDate.getTime(),
          );
          const annotationText = `[SynapseState Alert Correlation] Suspected flag: ${alertAttributionResult.suspected_flag} (Changed ${timeAgo}). Remediation: ${alertAttributionResult.remediation_command}`;
          const annotationTags = [
            "synapse",
            "incident",
            "suspected-flag",
            `env:${env}`,
            ...(service ? [`service:${service}`] : []),
          ];

          const grafanaRes = await grafanaClient.createAnnotation({
            time: alertAttributionResult.startsAtDate.getTime(),
            text: annotationText,
            tags: annotationTags,
          });
          annotationId = grafanaRes.id;
        } catch (grafanaErr) {
          req.log.warn(
            { err: grafanaErr },
            "[Webhook] Failed to dispatch Grafana annotation (fail-open)",
          );
        }
      }

      attributions.push({
        alertname: alertAttributionResult.alertname,
        service: alertAttributionResult.service,
        env: alertAttributionResult.env,
        attributed: alertAttributionResult.attributed,
        ...(alertAttributionResult.suspected_flag
          ? { suspected_flag: alertAttributionResult.suspected_flag }
          : {}),
        ...(alertAttributionResult.score !== undefined
          ? { score: alertAttributionResult.score }
          : {}),
        ...(alertAttributionResult.remediation_command
          ? { remediation_command: alertAttributionResult.remediation_command }
          : {}),
        ...(alertAttributionResult.reason
          ? { reason: alertAttributionResult.reason }
          : {}),
        ...(annotationId !== undefined
          ? { grafana_annotation_id: annotationId }
          : {}),
      });
    }

    return reply.code(200).send({
      status: "processed",
      alerts_count: firingAlerts.length,
      ...(isTruncated ? { truncated: true } : {}),
      attributions,
    });
  });
};

function formatRelativeTime(
  dateInput: Date | string,
  nowInput: Date | number = Date.now(),
): string {
  const time =
    dateInput instanceof Date ? dateInput.getTime() : new Date(dateInput).getTime();
  const now = typeof nowInput === "number" ? nowInput : nowInput.getTime();
  if (!Number.isFinite(time)) return "recently";

  const diffMs = Math.max(0, now - time);
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 1) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Constant-time comparison using fixed 32-byte SHA-256 digests.
 * Prevents string-length timing oracle leaks (I1).
 */
function isTimingSafeMatch(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export interface AlertmanagerAlert {
  status: "firing" | "resolved" | string;
  labels?: Record<string, string | undefined> & {
    alertname?: string;
    service?: string;
    app?: string;
    job?: string;
    repo?: string;
    env?: string;
    severity?: string;
  };
  annotations?: Record<string, string | undefined> & {
    summary?: string;
    description?: string;
  };
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

export interface AlertmanagerPayload {
  version?: string;
  groupKey?: string;
  status?: "firing" | "resolved" | string;
  receiver?: string;
  alerts?: AlertmanagerAlert[];
}

