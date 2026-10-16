import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { withTransaction } from "../db/transaction.js";
import type { StateManager } from "../services/state-manager.js";
import type { SynapseMetrics } from "../metrics/index.js";
import type { GitHubWebhookPullRequestPayload } from "../github/types.js";

export interface WebhookRoutesOptions {
  leasePool: Pool;
  stateManager: StateManager;
  metrics?: SynapseMetrics;
  webhookSecret?: string;
  expectedOwner?: string;
  expectedRepo?: string;
  expectedBaseBranch?: string;
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

    const rawPayload =
      (req as unknown as { rawBody?: Buffer | string }).rawBody ??
      (typeof req.body === "string" ? req.body : JSON.stringify(req.body));

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
};
