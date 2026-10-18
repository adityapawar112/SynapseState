import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateUlid } from "@synapsestate/sdk";
import { buildServer } from "../app.js";
import { leasePool } from "../db/pool.js";
import { runMigrations } from "../db/migrator.js";

describe("GitHub Webhook Route (POST /v1/webhooks/github) - PR 18", () => {
  let app: FastifyInstance;
  const webhookSecret = "test-secret-1234567890abcdef";
  const env = "webhook-test-env";

  function createSignature(
    payload: string | object,
    secret: string = webhookSecret,
  ): string {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    const hmac = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    return `sha256=${hmac}`;
  }

  beforeAll(async () => {
    await runMigrations(leasePool);

    app = buildServer({
      leasePool,
      githubWebhookSecret: webhookSecret,
      fastifyOptions: { logger: false },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await leasePool.query("DELETE FROM change_events WHERE env = $1", [env]);
    await leasePool.query("DELETE FROM audit_pending");
    await leasePool.query("DELETE FROM leases WHERE env = $1", [env]);
  });

  it("rejects request missing x-hub-signature-256 with 401 Unauthorized", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "pull_request",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ action: "closed" }),
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe("MISSING_SIGNATURE");
  });

  it("rejects request with invalid HMAC signature with 401 Unauthorized", async () => {
    const payload = JSON.stringify({ action: "closed" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256":
          "sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb",
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe("INVALID_SIGNATURE");
  });

  it("fails closed with 500 when rawBody is unavailable", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=abcdef",
        "content-type": "text/plain",
      },
      payload: "plain text without json parser buffer capture",
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("RAW_BODY_UNAVAILABLE");
  });

  it("handles ping event with 200 OK { status: 'pong' }", async () => {
    const payload = JSON.stringify({ zen: "Design for failure." });
    const sig = createSignature(payload);

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "ping",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "pong" });
  });

  it("ignores non-pull_request events with 200 OK", async () => {
    const payload = JSON.stringify({ ref: "refs/heads/main" });
    const sig = createSignature(payload);

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ignored");
  });

  it("ignores pull_request events when action is not closed or merged is false", async () => {
    const payload = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 1,
        merged: false,
        head: { ref: "synapse/promote-lease-01J9X57YTRPQ8A7F4E12345678" },
      },
    });
    const sig = createSignature(payload);

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ignored");
  });

  it("reconciles merged PR for ACTIVE lease: transitions to PROMOTED, writes GIT_MERGE & LEASE_PROMOTED", async () => {
    const leaseId = generateUlid();
    const flagKey = "checkout-killswitch";

    // Insert active lease
    await leasePool.query(
      `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid, promote_pr_url)
       VALUES ($1, $2, $3, $4, 'test-sig', 'ACTIVE', NOW(), 1800, NOW() + INTERVAL '1800 seconds', 'sre-alice', 'https://github.com/org/repo/pull/55')`,
      [
        leaseId,
        flagKey,
        env,
        JSON.stringify({
          v: 1,
          lease_id: leaseId,
          env,
          flag_key: flagKey,
          value: false,
          reason: "Emergency killswitch override",
          issued_at: new Date().toISOString(),
          ttl_seconds: 1800,
          kid: "sre-alice",
        }),
      ],
    );

    const webhookPayload = JSON.stringify({
      action: "closed",
      number: 55,
      pull_request: {
        number: 55,
        html_url: "https://github.com/org/repo/pull/55",
        state: "closed",
        title: `feat(flags): promote override for ${flagKey}`,
        merged: true,
        merge_commit_sha: "merge-commit-sha-999",
        merged_at: new Date().toISOString(),
        merged_by: { login: "octocat-lead" },
        head: {
          ref: `synapse/promote-lease-${leaseId}`,
          sha: "head-sha-111",
        },
        base: { ref: "main" },
      },
    });
    const sig = createSignature(webhookPayload);

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      payload: webhookPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "reconciled", lease_id: leaseId });

    // Verify lease transitioned to PROMOTED
    const leaseCheck = await leasePool.query(
      "SELECT state FROM leases WHERE lease_id = $1",
      [leaseId],
    );
    expect(leaseCheck.rows[0].state).toBe("PROMOTED");

    // Verify change_events has GIT_MERGE and LEASE_PROMOTED
    const eventsRes = await leasePool.query(
      "SELECT event_type, actor, payload FROM change_events WHERE env = $1 ORDER BY id ASC",
      [env],
    );
    expect(eventsRes.rows.length).toBe(2);
    expect(eventsRes.rows[0].event_type).toBe("GIT_MERGE");
    expect(eventsRes.rows[0].actor).toBe("octocat-lead");
    expect(eventsRes.rows[0].payload.merge_commit_sha).toBe(
      "merge-commit-sha-999",
    );
    expect(eventsRes.rows[0].payload.lease_id).toBe(leaseId);

    expect(eventsRes.rows[1].event_type).toBe("LEASE_PROMOTED");
    expect(eventsRes.rows[1].actor).toBe("octocat-lead");
    expect(eventsRes.rows[1].payload.after_expiry).toBe(false);

    // Verify audit_pending has LEASE_PROMOTED staged
    const auditRes = await leasePool.query(
      "SELECT actor, event_type, payload FROM audit_pending",
    );
    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0].event_type).toBe("LEASE_PROMOTED");
    expect(auditRes.rows[0].payload.lease_id).toBe(leaseId);
  });

  it("reconciles merged PR for EXPIRED lease with after_expiry=true", async () => {
    const leaseId = generateUlid();
    const flagKey = "checkout-expired-flag";

    // Insert EXPIRED lease
    await leasePool.query(
      `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid, promote_pr_url)
       VALUES ($1, $2, $3, $4, 'test-sig', 'EXPIRED', NOW() - INTERVAL '3600 seconds', 1800, NOW() - INTERVAL '1800 seconds', 'sre-alice', 'https://github.com/org/repo/pull/77')`,
      [
        leaseId,
        flagKey,
        env,
        JSON.stringify({
          v: 1,
          lease_id: leaseId,
          env,
          flag_key: flagKey,
          value: false,
          reason: "Expired override",
          issued_at: new Date(Date.now() - 3600_000).toISOString(),
          ttl_seconds: 1800,
          kid: "sre-alice",
        }),
      ],
    );

    const webhookPayload = JSON.stringify({
      action: "closed",
      number: 77,
      pull_request: {
        number: 77,
        html_url: "https://github.com/org/repo/pull/77",
        state: "closed",
        title: `feat(flags): promote override for ${flagKey}`,
        merged: true,
        merge_commit_sha: "merge-commit-sha-late",
        merged_at: new Date().toISOString(),
        merged_by: { login: "late-reviewer" },
        head: {
          ref: `synapse/promote-lease-${leaseId}`,
          sha: "head-sha-222",
        },
        base: { ref: "main" },
      },
    });
    const sig = createSignature(webhookPayload);

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      payload: webhookPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "reconciled", lease_id: leaseId });

    // Verify lease transitioned to PROMOTED
    const leaseCheck = await leasePool.query(
      "SELECT state FROM leases WHERE lease_id = $1",
      [leaseId],
    );
    expect(leaseCheck.rows[0].state).toBe("PROMOTED");

    // Verify change_events has LEASE_PROMOTED with after_expiry = true
    const eventsRes = await leasePool.query(
      "SELECT event_type, payload FROM change_events WHERE env = $1 AND event_type = 'LEASE_PROMOTED'",
      [env],
    );
    expect(eventsRes.rows[0].payload.after_expiry).toBe(true);
    expect(eventsRes.rows[0].payload.previous_state).toBe("EXPIRED");
  });

  it("handles duplicate webhook delivery idempotently with already_promoted", async () => {
    const leaseId = generateUlid();
    const flagKey = "checkout-duplicate-flag";

    // Insert PROMOTED lease
    await leasePool.query(
      `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid, promote_pr_url)
       VALUES ($1, $2, $3, $4, 'test-sig', 'PROMOTED', NOW(), 1800, NOW() + INTERVAL '1800 seconds', 'sre-alice', 'https://github.com/org/repo/pull/88')`,
      [
        leaseId,
        flagKey,
        env,
        JSON.stringify({
          v: 1,
          lease_id: leaseId,
          env,
          flag_key: flagKey,
          value: false,
          reason: "Duplicate override",
          issued_at: new Date().toISOString(),
          ttl_seconds: 1800,
          kid: "sre-alice",
        }),
      ],
    );

    const webhookPayload = JSON.stringify({
      action: "closed",
      number: 88,
      pull_request: {
        number: 88,
        html_url: "https://github.com/org/repo/pull/88",
        state: "closed",
        title: `feat(flags): promote override for ${flagKey}`,
        merged: true,
        merge_commit_sha: "merge-commit-sha-888",
        head: {
          ref: `synapse/promote-lease-${leaseId}`,
        },
      },
    });
    const sig = createSignature(webhookPayload);

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      payload: webhookPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "already_promoted",
      lease_id: leaseId,
    });
  });

  it("ignores webhook and refuses to promote if lease is REVOKED (C1 blocker)", async () => {
    const leaseId = generateUlid();
    const flagKey = "revoked-guard-flag";

    // Insert REVOKED lease
    await leasePool.query(
      `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
       VALUES ($1, $2, $3, $4, 'test-sig', 'REVOKED', NOW(), 1800, NOW() + INTERVAL '1800 seconds', 'sre-alice')`,
      [
        leaseId,
        flagKey,
        env,
        JSON.stringify({
          v: 1,
          lease_id: leaseId,
          env,
          flag_key: flagKey,
          value: false,
          reason: "Revoked incident",
          issued_at: new Date().toISOString(),
          ttl_seconds: 1800,
          kid: "sre-alice",
        }),
      ],
    );

    const webhookPayload = JSON.stringify({
      action: "closed",
      number: 99,
      pull_request: {
        number: 99,
        html_url: "https://github.com/org/repo/pull/99",
        state: "closed",
        title: `feat(flags): promote override for ${flagKey}`,
        merged: true,
        merge_commit_sha: "merge-commit-sha-999",
        head: {
          ref: `synapse/promote-lease-${leaseId}`,
        },
      },
    });
    const sig = createSignature(webhookPayload);

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/github",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      payload: webhookPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ignored",
      reason: "Lease has been revoked and cannot be promoted",
    });

    // Verify lease remains REVOKED in database
    const leaseCheck = await leasePool.query(
      "SELECT state FROM leases WHERE lease_id = $1",
      [leaseId],
    );
    expect(leaseCheck.rows[0].state).toBe("REVOKED");

    // Verify zero GIT_MERGE or LEASE_PROMOTED events emitted
    const eventsCheck = await leasePool.query(
      "SELECT COUNT(*) FROM change_events WHERE env = $1",
      [env],
    );
    expect(Number(eventsCheck.rows[0].count)).toBe(0);
  });

  it("ignores webhook if repository owner or name does not match expected (C2 blocker)", async () => {
    const appWithRepoCheck = buildServer({
      leasePool,
      githubWebhookSecret: webhookSecret,
      githubOwner: "synapsestate-trusted",
      githubRepo: "flags-trusted",
      fastifyOptions: { logger: false },
    });
    await appWithRepoCheck.ready();

    try {
      const leaseId = generateUlid();
      const flagKey = "cross-repo-spoof-flag";

      const webhookPayload = JSON.stringify({
        action: "closed",
        number: 101,
        repository: {
          name: "attacker-repo",
          owner: {
            login: "attacker",
          },
        },
        pull_request: {
          number: 101,
          html_url: "https://github.com/attacker/attacker-repo/pull/101",
          state: "closed",
          title: `feat(flags): promote override for ${flagKey}`,
          merged: true,
          merge_commit_sha: "merge-commit-sha-attacker",
          head: {
            ref: `synapse/promote-lease-${leaseId}`,
          },
        },
      });
      const sig = createSignature(webhookPayload);

      const res = await appWithRepoCheck.inject({
        method: "POST",
        url: "/v1/webhooks/github",
        headers: {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sig,
          "content-type": "application/json",
        },
        payload: webhookPayload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: "ignored",
        reason: "Repository owner mismatch",
      });

      // Test missing repository payload when expectations are set
      const webhookPayloadMissingRepo = JSON.stringify({
        action: "closed",
        number: 102,
        pull_request: {
          number: 102,
          html_url: "https://github.com/attacker/attacker-repo/pull/102",
          state: "closed",
          title: `feat(flags): promote override for ${flagKey}`,
          merged: true,
          merge_commit_sha: "merge-commit-sha-attacker",
          head: {
            ref: `synapse/promote-lease-${leaseId}`,
          },
        },
      });
      const sigMissingRepo = createSignature(webhookPayloadMissingRepo);

      const resMissingRepo = await appWithRepoCheck.inject({
        method: "POST",
        url: "/v1/webhooks/github",
        headers: {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sigMissingRepo,
          "content-type": "application/json",
        },
        payload: webhookPayloadMissingRepo,
      });

      expect(resMissingRepo.statusCode).toBe(200);
      expect(resMissingRepo.json()).toEqual({
        status: "ignored",
        reason: "Missing repository owner in webhook payload",
      });
    } finally {
      await appWithRepoCheck.close();
    }
  });

  it("authenticates webhook using SYNAPSE_WEBHOOK_SECRET fallback (Issue 9)", async () => {
    const originalGithubSecret = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const fallbackSecret = "synapse-fallback-secret-987654";
    process.env.SYNAPSE_WEBHOOK_SECRET = fallbackSecret;

    const appFallback = buildServer({
      leasePool,
      fastifyOptions: { logger: false },
    });
    await appFallback.ready();

    try {
      const webhookPayload = JSON.stringify({ action: "ping" });
      const hmac = crypto
        .createHmac("sha256", fallbackSecret)
        .update(webhookPayload)
        .digest("hex");
      const sig = `sha256=${hmac}`;

      const res = await appFallback.inject({
        method: "POST",
        url: "/v1/webhooks/github",
        headers: {
          "x-github-event": "ping",
          "x-hub-signature-256": sig,
          "content-type": "application/json",
        },
        payload: webhookPayload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "pong" });
    } finally {
      delete process.env.SYNAPSE_WEBHOOK_SECRET;
      if (originalGithubSecret !== undefined) {
        process.env.GITHUB_WEBHOOK_SECRET = originalGithubSecret;
      }
      await appFallback.close();
    }
  });
});

describe("Alertmanager Incident Webhook Route (POST /v1/webhooks/alertmanager) - PR 26", () => {
  let app: FastifyInstance;
  const alertmanagerSecret = "test-alertmanager-secret-xyz123";
  const env = "alertmanager-test-env";

  beforeAll(async () => {
    await runMigrations(leasePool);

    app = buildServer({
      leasePool,
      alertmanagerWebhookSecret: alertmanagerSecret,
      fastifyOptions: { logger: false },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await leasePool.query("DELETE FROM change_events WHERE env = $1", [env]);
    await leasePool.query("DELETE FROM flag_usage_daily WHERE env = $1", [env]);
    await leasePool.query("DELETE FROM audit_pending");
  });

  it("rejects Alertmanager webhook missing secret with 401 Unauthorized", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/alertmanager",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        version: "4",
        status: "firing",
        alerts: [{ status: "firing", labels: { alertname: "HighHttp5xxRate" } }],
      }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("UNAUTHORIZED");
  });

  it("rejects Alertmanager webhook with invalid secret with 401 Unauthorized", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/alertmanager",
      headers: {
        "content-type": "application/json",
        "x-alertmanager-secret": "wrong-secret",
      },
      payload: JSON.stringify({
        version: "4",
        status: "firing",
        alerts: [{ status: "firing", labels: { alertname: "HighHttp5xxRate" } }],
      }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("UNAUTHORIZED");
  });

  it("authenticates Alertmanager webhook with Authorization: Bearer <secret> header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/alertmanager",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alertmanagerSecret}`,
      },
      payload: JSON.stringify({
        version: "4",
        status: "firing",
        alerts: [{ status: "firing", labels: { alertname: "HighHttp5xxRate", env } }],
      }),
    });

    expect(res.statusCode).toBe(200);
  });

  it("authenticates Alertmanager webhook with X-Alertmanager-Secret header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/alertmanager",
      headers: {
        "content-type": "application/json",
        "x-alertmanager-secret": alertmanagerSecret,
      },
      payload: JSON.stringify({
        version: "4",
        status: "firing",
        alerts: [{ status: "firing", labels: { alertname: "HighHttp5xxRate", env } }],
      }),
    });

    expect(res.statusCode).toBe(200);
  });

  it("rejects malformed payload missing alerts array with 400 Bad Request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/alertmanager",
      headers: {
        "content-type": "application/json",
        "x-alertmanager-secret": alertmanagerSecret,
      },
      payload: JSON.stringify({
        version: "4",
        status: "firing",
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_PAYLOAD");
  });

  it("ignores payload with no firing alerts with 200 OK and status: 'ignored'", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/alertmanager",
      headers: {
        "content-type": "application/json",
        "x-alertmanager-secret": alertmanagerSecret,
      },
      payload: JSON.stringify({
        version: "4",
        status: "resolved",
        alerts: [{ status: "resolved", labels: { alertname: "HighHttp5xxRate", env } }],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ignored");
  });

  it("processes firing alert with no recent changes: returns attributed: false, stages INCIDENT_ALERT_RECEIVED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/alertmanager",
      headers: {
        "content-type": "application/json",
        "x-alertmanager-secret": alertmanagerSecret,
      },
      payload: JSON.stringify({
        version: "4",
        status: "firing",
        receiver: "synapse-webhook",
        alerts: [
          {
            status: "firing",
            labels: {
              alertname: "HighHttp5xxRate",
              service: "checkout",
              env,
              severity: "critical",
            },
            annotations: {
              summary: "High 5xx rate on checkout service",
            },
            startsAt: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("processed");
    expect(body.alerts_count).toBe(1);
    expect(body.attributions[0].attributed).toBe(false);
    expect(body.attributions[0].alertname).toBe("HighHttp5xxRate");
    expect(body.attributions[0].service).toBe("checkout");

    // Verify INCIDENT_ALERT_RECEIVED staged in audit_pending
    const auditRes = await leasePool.query<{
      actor: string;
      event_type: string;
      payload: { alertname: string; service: string; env: string };
    }>("SELECT actor, event_type, payload FROM audit_pending WHERE event_type = 'INCIDENT_ALERT_RECEIVED'");

    expect(auditRes.rows.length).toBe(1);
    expect(auditRes.rows[0].event_type).toBe("INCIDENT_ALERT_RECEIVED");
    expect(auditRes.rows[0].payload.alertname).toBe("HighHttp5xxRate");
    expect(auditRes.rows[0].payload.service).toBe("checkout");
    expect(auditRes.rows[0].payload.env).toBe(env);

    // Verify zero INCIDENT_ATTRIBUTION_EMITTED
    const emitRes = await leasePool.query(
      "SELECT COUNT(*) FROM audit_pending WHERE event_type = 'INCIDENT_ATTRIBUTION_EMITTED'",
    );
    expect(Number(emitRes.rows[0].count)).toBe(0);
  });

  it("processes firing alert attributing recent change: returns attributed: true, suspected flag, remediation command, stages both audit events", async () => {
    const flagKey = "checkout-v2";
    const service = "checkout";
    const now = new Date();

    // Insert recent change event (10 minutes ago)
    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES ('LEASE_CREATED', $1, $2, 'sre-bob', $3, $4)`,
      [
        env,
        flagKey,
        new Date(now.getTime() - 10 * 60 * 1000),
        JSON.stringify({ value: true, reason: "Canary rollout" }),
      ],
    );

    // Insert usage telemetry for service
    await leasePool.query(
      `INSERT INTO flag_usage_daily (flag_key, env, service, variant, usage_date, eval_count, first_seen, last_seen)
       VALUES ($1, $2, $3, 'true', CURRENT_DATE, 5000, NOW(), NOW())`,
      [flagKey, env, service],
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/alertmanager",
      headers: {
        "content-type": "application/json",
        "x-alertmanager-secret": alertmanagerSecret,
      },
      payload: JSON.stringify({
        version: "4",
        status: "firing",
        receiver: "synapse-webhook",
        alerts: [
          {
            status: "firing",
            labels: {
              alertname: "HighHttp5xxRate",
              service,
              env,
              severity: "critical",
            },
            annotations: {
              summary: "High 5xx rate on checkout service",
            },
            startsAt: now.toISOString(),
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("processed");
    expect(body.attributions[0].attributed).toBe(true);
    expect(body.attributions[0].suspected_flag).toBe(flagKey);
    expect(body.attributions[0].score).toBeGreaterThan(0);
    expect(body.attributions[0].remediation_command).toContain(
      `synapse lease create --flag ${flagKey}`,
    );
    expect(body.attributions[0].remediation_command).toContain(
      `--env ${env}`,
    );

    // Verify both INCIDENT_ALERT_RECEIVED and INCIDENT_ATTRIBUTION_EMITTED in audit_pending
    const auditRes = await leasePool.query<{
      event_type: string;
      payload: { suspected_flag?: string; remediation_command?: string };
    }>("SELECT event_type, payload FROM audit_pending ORDER BY id ASC");

    const eventTypes = auditRes.rows.map((r) => r.event_type);
    expect(eventTypes).toContain("INCIDENT_ALERT_RECEIVED");
    expect(eventTypes).toContain("INCIDENT_ATTRIBUTION_EMITTED");

    const emitted = auditRes.rows.find(
      (r) => r.event_type === "INCIDENT_ATTRIBUTION_EMITTED",
    );
    expect(emitted?.payload.suspected_flag).toBe(flagKey);
    expect(emitted?.payload.remediation_command).toContain(flagKey);
  });

  it("dispatches Grafana annotation when grafanaClient is configured", async () => {
    const flagKey = "checkout-v2";
    const service = "checkout";
    const now = new Date();

    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES ('LEASE_CREATED', $1, $2, 'sre-bob', $3, $4)`,
      [
        env,
        flagKey,
        new Date(now.getTime() - 5 * 60 * 1000),
        JSON.stringify({ value: true, reason: "Canary rollout" }),
      ],
    );

    const mockCreateAnnotation = vi.fn().mockResolvedValue({ id: 42, message: "Annotation added" });
    const mockGrafanaClient = { createAnnotation: mockCreateAnnotation };

    const appWithGrafana = buildServer({
      leasePool,
      alertmanagerWebhookSecret: alertmanagerSecret,
      grafanaClient: mockGrafanaClient,
      fastifyOptions: { logger: false },
    });
    await appWithGrafana.ready();

    try {
      const res = await appWithGrafana.inject({
        method: "POST",
        url: "/v1/webhooks/alertmanager",
        headers: {
          "content-type": "application/json",
          "x-alertmanager-secret": alertmanagerSecret,
        },
        payload: JSON.stringify({
          version: "4",
          status: "firing",
          alerts: [
            {
              status: "firing",
              labels: {
                alertname: "HighHttp5xxRate",
                service,
                env,
                severity: "critical",
              },
              startsAt: now.toISOString(),
            },
          ],
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockCreateAnnotation).toHaveBeenCalledTimes(1);
      const callArg = mockCreateAnnotation.mock.calls[0][0];
      expect(callArg.tags).toContain("synapse");
      expect(callArg.tags).toContain("incident");
      expect(callArg.tags).toContain("suspected-flag");
      expect(callArg.tags).toContain(`env:${env}`);
      expect(callArg.tags).toContain(`service:${service}`);
      expect(callArg.text).toContain(`[SynapseState Alert Correlation] Suspected flag: ${flagKey}`);
      expect(callArg.text).toContain("Remediation: synapse lease create");
    } finally {
      await appWithGrafana.close();
    }
  });

  it("handles Grafana API failure / timeout gracefully without failing webhook response (fail-open)", async () => {
    const flagKey = "checkout-v2";
    const service = "checkout";
    const now = new Date();

    await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, occurred_at, payload)
       VALUES ('LEASE_CREATED', $1, $2, 'sre-bob', $3, $4)`,
      [
        env,
        flagKey,
        new Date(now.getTime() - 5 * 60 * 1000),
        JSON.stringify({ value: true, reason: "Canary rollout" }),
      ],
    );

    const mockCreateAnnotation = vi.fn().mockRejectedValue(new Error("ETIMEDOUT: Grafana unreachable"));
    const mockGrafanaClient = { createAnnotation: mockCreateAnnotation };

    const appWithGrafanaFail = buildServer({
      leasePool,
      alertmanagerWebhookSecret: alertmanagerSecret,
      grafanaClient: mockGrafanaClient,
      fastifyOptions: { logger: false },
    });
    await appWithGrafanaFail.ready();

    try {
      const res = await appWithGrafanaFail.inject({
        method: "POST",
        url: "/v1/webhooks/alertmanager",
        headers: {
          "content-type": "application/json",
          "x-alertmanager-secret": alertmanagerSecret,
        },
        payload: JSON.stringify({
          version: "4",
          status: "firing",
          alerts: [
            {
              status: "firing",
              labels: {
                alertname: "HighHttp5xxRate",
                service,
                env,
                severity: "critical",
              },
              startsAt: now.toISOString(),
            },
          ],
        }),
      });

      // Crucial: Webhook returns 200 OK despite Grafana error (fail-open invariant)
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("processed");
      expect(body.attributions[0].attributed).toBe(true);
      expect(mockCreateAnnotation).toHaveBeenCalledTimes(1);
    } finally {
      await appWithGrafanaFail.close();
    }
  });
});
