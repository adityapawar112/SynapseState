import type { Pool, PoolClient } from "pg";
import { register as defaultRegister, Registry, Gauge } from "prom-client";
import { withAuditSealerTransaction } from "../db/transaction.js";
import {
  GENESIS_PREV_HASH,
  computeEventHash,
  type AuditEventRecord,
} from "./chain.js";

export interface AuditSealerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface AuditSealerOptions {
  pool: Pool;
  batchSize?: number;
  intervalMs?: number;
  registry?: Registry;
  logger?: AuditSealerLogger;
}

export interface SealResult {
  acquired: boolean;
  sealedCount: number;
  lastSeq?: number;
  lastHash?: string;
  pendingAgeSeconds: number;
}

interface AuditPendingRow {
  id: string;
  created_at: Date | string;
  actor: string;
  event_type: string;
  payload: unknown;
}

/**
 * Retrieves or registers the synapse_audit_pending_age_seconds Prometheus gauge.
 */
function getOrCreatePendingAgeGauge(registry: Registry): Gauge<string> {
  const metricName = "synapse_audit_pending_age_seconds";
  const existing = registry.getSingleMetric(metricName);
  if (existing) {
    return existing as Gauge<string>;
  }
  return new Gauge({
    name: metricName,
    help: "Age in seconds of the oldest unsealed audit event in audit_pending",
    registers: [registry],
  });
}

/**
 * Asynchronous In-Process Audit Sealer.
 *
 * Implements ADR 0005 & ARCHITECTURE §8.2:
 * - Seals staged rows from audit_pending into an append-only, SHA-256 hash-chained ledger (audit_events).
 * - Uses transaction-level advisory locking (pg_try_advisory_xact_lock) for safe PgBouncer pooling.
 * - Enforces contiguous sequence numbering and RFC 8785 canonical hash chaining.
 * - Implements loop hygiene with recursive setTimeout and in-flight guard (never setInterval).
 * - Exports synapse_audit_pending_age_seconds metric to alert on stalled sealing.
 * - Provides graceful shutdown that awaits in-flight batch commit.
 */
export class AuditSealer {
  private readonly pool: Pool;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly logger: AuditSealerLogger;
  private readonly pendingAgeGauge: Gauge<string>;

  private isRunning = false;
  private isSealing = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlightPromise: Promise<SealResult> | null = null;

  constructor(options: AuditSealerOptions) {
    this.pool = options.pool;
    this.batchSize = options.batchSize ?? 100;
    this.intervalMs = options.intervalMs ?? 1000;
    const registry = options.registry ?? defaultRegister;
    this.pendingAgeGauge = getOrCreatePendingAgeGauge(registry);
    this.logger = options.logger ?? {
      info: console.log,
      warn: console.warn,
      error: console.error,
    };
  }

  /**
   * Returns the Prometheus gauge used for tracking pending event lag.
   */
  public getPendingAgeGauge(): Gauge<string> {
    return this.pendingAgeGauge;
  }

  /**
   * Returns whether the background sealing loop is active.
   */
  public isSealerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Starts the self-rescheduling background sealing loop.
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.scheduleTick();
  }

  /**
   * Stops the background sealing loop gracefully, awaiting any in-flight batch to commit.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlightPromise) {
      try {
        await this.inFlightPromise;
      } catch {
        // Exception already logged by error containment wrapper
      }
    }
  }

  /**
   * Manually executes a single sealing cycle within a transaction-level advisory lock.
   */
  public async sealOnce(): Promise<SealResult> {
    const lockResult = await withAuditSealerTransaction(this.pool, async (client) => {
      return this.processBatch(client);
    });

    if (!lockResult.acquired) {
      // Lock-free lag query so standby replicas export accurate pending age to Prometheus
      const pendingAgeSeconds = await this.updatePendingAgeMetric();
      return {
        acquired: false,
        sealedCount: 0,
        pendingAgeSeconds,
      };
    }

    return lockResult.result;
  }

  /**
   * Updates the synapse_audit_pending_age_seconds metric based on the oldest event in audit_pending.
   */
  public async updatePendingAgeMetric(client?: PoolClient): Promise<number> {
    const queryRunner = client ?? this.pool;
    const res = await queryRunner.query<{ created_at: Date | string }>(
      "SELECT created_at FROM audit_pending ORDER BY created_at ASC LIMIT 1;"
    );

    if (res.rows.length === 0) {
      this.pendingAgeGauge.set(0);
      return 0;
    }

    const oldestCreatedAt = new Date(res.rows[0]!.created_at).getTime();
    const ageSeconds = Math.max(0, (Date.now() - oldestCreatedAt) / 1000);
    this.pendingAgeGauge.set(ageSeconds);
    return ageSeconds;
  }

  /**
   * Processes a single batch of events from audit_pending inside an active advisory-locked transaction.
   */
  protected async processBatch(client: PoolClient): Promise<SealResult> {
    // 1. Fetch current tip of the audit ledger
    const tipRes = await client.query<{ seq: string | number; hash: string }>(
      "SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1;"
    );

    let lastSeq = 0;
    let lastHash = GENESIS_PREV_HASH;

    if (tipRes.rows.length > 0) {
      lastSeq = Number(tipRes.rows[0]!.seq);
      lastHash = tipRes.rows[0]!.hash;
    }

    // 2. Read up to batchSize unsealed events ordered by created_at ASC, id ASC
    const pendingRes = await client.query<AuditPendingRow>(
      `SELECT id, created_at, actor, event_type, payload
       FROM audit_pending
       ORDER BY created_at ASC, id ASC
       LIMIT $1
       FOR UPDATE;`,
      [this.batchSize]
    );

    if (pendingRes.rows.length === 0) {
      this.pendingAgeGauge.set(0);
      return {
        acquired: true,
        sealedCount: 0,
        lastSeq,
        lastHash,
        pendingAgeSeconds: 0,
      };
    }

    // 3. Deterministically compute sequence numbers and SHA-256 hashes
    let currentSeq = lastSeq;
    let currentPrevHash = lastHash;
    const sealedEvents: AuditEventRecord[] = [];
    const pendingIdsToDelete: string[] = [];

    for (const row of pendingRes.rows) {
      currentSeq += 1;
      const ts =
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString();

      const eventData = {
        seq: currentSeq,
        ts,
        actor: row.actor,
        event_type: row.event_type,
        payload: row.payload,
      };

      const hash = computeEventHash(currentPrevHash, eventData);

      sealedEvents.push({
        ...eventData,
        prev_hash: currentPrevHash,
        hash,
      });

      pendingIdsToDelete.push(row.id);
      currentPrevHash = hash;
    }

    // 4. Batch insert sealed events into audit_events
    const valuePlaceholders: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const event of sealedEvents) {
      valuePlaceholders.push(
        `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6})`
      );
      params.push(
        event.seq,
        event.ts,
        event.actor,
        event.event_type,
        JSON.stringify(event.payload),
        event.prev_hash,
        event.hash
      );
      paramIdx += 7;
    }

    await client.query(
      `INSERT INTO audit_events (seq, ts, actor, event_type, payload, prev_hash, hash)
       VALUES ${valuePlaceholders.join(", ")};`,
      params
    );

    // Synchronize underlying sequence with assigned seq to prevent future default collisions
    await client.query(
      "SELECT setval(pg_get_serial_sequence('audit_events', 'seq'), $1, true);",
      [currentSeq]
    );

    // 5. Delete processed events from audit_pending within the EXACT same transaction
    await client.query("DELETE FROM audit_pending WHERE id = ANY($1::bigint[]);", [
      pendingIdsToDelete,
    ]);

    // 6. Update lag metric for remaining pending events
    const remainingPendingRes = await client.query<{ created_at: Date | string }>(
      "SELECT created_at FROM audit_pending ORDER BY created_at ASC LIMIT 1;"
    );

    let pendingAgeSeconds = 0;
    if (remainingPendingRes.rows.length > 0) {
      const oldestCreatedAt = new Date(remainingPendingRes.rows[0]!.created_at).getTime();
      pendingAgeSeconds = Math.max(0, (Date.now() - oldestCreatedAt) / 1000);
      this.pendingAgeGauge.set(pendingAgeSeconds);
    } else {
      this.pendingAgeGauge.set(0);
    }

    return {
      acquired: true,
      sealedCount: sealedEvents.length,
      lastSeq: currentSeq,
      lastHash: currentPrevHash,
      pendingAgeSeconds,
    };
  }

  /**
   * Schedules the next sealing tick using recursive setTimeout.
   */
  private scheduleTick(): void {
    if (!this.isRunning) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);

    // Prevent background timer from blocking process exit if called as a daemon
    if (typeof this.timer?.unref === "function") {
      this.timer.unref();
    }
  }

  /**
   * Executes a single tick of the sealing loop with top-level error containment and in-flight guard.
   */
  private async tick(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    if (this.isSealing) {
      // Defensively re-arm timer if a tick was triggered while sealing
      this.scheduleTick();
      return;
    }
    this.isSealing = true;
    try {
      this.inFlightPromise = this.sealOnce();
      await this.inFlightPromise;
    } catch (err) {
      // Top-level error containment: log without crashing runtime
      this.logger.error("Error during audit sealing tick:", err);
    } finally {
      this.isSealing = false;
      this.inFlightPromise = null;
      if (this.isRunning) {
        this.scheduleTick();
      }
    }
  }
}
