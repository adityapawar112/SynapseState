import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { Registry } from "prom-client";
import { leasePool } from "../db/pool.js";
import { tryAuditSealerLock } from "../db/transaction.js";
import { AuditSealer } from "./sealer.js";
import { verifyAuditChain, GENESIS_PREV_HASH, type AuditEventRecord } from "./chain.js";

describe("In-Process Audit Sealer (sealer.ts)", () => {
  let customRegistry: Registry;

  beforeEach(async () => {
    customRegistry = new Registry();
    // Clean tables before each test
    await leasePool.query("DELETE FROM audit_pending;");
    await leasePool.query("DELETE FROM audit_events;");
  });

  afterEach(async () => {
    await leasePool.query("DELETE FROM audit_pending;");
    await leasePool.query("DELETE FROM audit_events;");
  });

  afterAll(async () => {
    // Keep connection pool clean
  });

  it("seals pending events into audit_events and deletes them from audit_pending atomically", async () => {
    // Insert 3 pending audit events
    await leasePool.query(`
      INSERT INTO audit_pending (actor, event_type, payload)
      VALUES 
        ('sre-alice', 'LEASE_CREATED', '{"lease_id":"lease-001"}'),
        ('sre-bob', 'LEASE_SUPERSEDED', '{"lease_id":"lease-002"}'),
        ('sre-charlie', 'LEASE_REVOKED', '{"lease_id":"lease-003"}');
    `);

    const sealer = new AuditSealer({
      pool: leasePool,
      registry: customRegistry,
    });

    const result = await sealer.sealOnce();

    expect(result.acquired).toBe(true);
    expect(result.sealedCount).toBe(3);
    expect(result.lastSeq).toBe(3);
    expect(result.lastHash).toBeDefined();

    // Verify audit_pending is completely empty
    const pendingCheck = await leasePool.query("SELECT COUNT(*)::int AS count FROM audit_pending;");
    expect(pendingCheck.rows[0]?.count).toBe(0);

    // Verify audit_events contains 3 sealed records
    const sealedEvents = await leasePool.query<AuditEventRecord>(
      "SELECT seq, ts, actor, event_type, payload, prev_hash, hash FROM audit_events ORDER BY seq ASC;"
    );
    expect(sealedEvents.rows.length).toBe(3);

    // Verify chain integrity
    expect(Number(sealedEvents.rows[0]?.seq)).toBe(1);
    expect(sealedEvents.rows[0]?.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(sealedEvents.rows[1]?.prev_hash).toBe(sealedEvents.rows[0]?.hash);
    expect(sealedEvents.rows[2]?.prev_hash).toBe(sealedEvents.rows[1]?.hash);

    const verification = verifyAuditChain(sealedEvents.rows);
    expect(verification.valid).toBe(true);
  });

  it("respects batch size limit and continues chain across successive batches", async () => {
    // Insert 5 pending events
    for (let i = 1; i <= 5; i++) {
      await leasePool.query(
        "INSERT INTO audit_pending (actor, event_type, payload) VALUES ($1, $2, $3)",
        [`actor-${i}`, "LEASE_CREATED", JSON.stringify({ item: i })]
      );
    }

    const sealer = new AuditSealer({
      pool: leasePool,
      batchSize: 2,
      registry: customRegistry,
    });

    // Batch 1 (seals 2, leaves 3)
    const batch1 = await sealer.sealOnce();
    expect(batch1.sealedCount).toBe(2);
    expect(batch1.lastSeq).toBe(2);

    let pendingCount = await leasePool.query("SELECT COUNT(*)::int AS count FROM audit_pending;");
    expect(pendingCount.rows[0]?.count).toBe(3);

    // Batch 2 (seals 2, leaves 1)
    const batch2 = await sealer.sealOnce();
    expect(batch2.sealedCount).toBe(2);
    expect(batch2.lastSeq).toBe(4);

    pendingCount = await leasePool.query("SELECT COUNT(*)::int AS count FROM audit_pending;");
    expect(pendingCount.rows[0]?.count).toBe(1);

    // Batch 3 (seals 1, leaves 0)
    const batch3 = await sealer.sealOnce();
    expect(batch3.sealedCount).toBe(1);
    expect(batch3.lastSeq).toBe(5);

    pendingCount = await leasePool.query("SELECT COUNT(*)::int AS count FROM audit_pending;");
    expect(pendingCount.rows[0]?.count).toBe(0);

    // Entire chain of 5 events should verify from genesis
    const allSealed = await leasePool.query<AuditEventRecord>(
      "SELECT seq, ts, actor, event_type, payload, prev_hash, hash FROM audit_events ORDER BY seq ASC;"
    );
    expect(allSealed.rows.length).toBe(5);

    const verification = verifyAuditChain(allSealed.rows);
    expect(verification.valid).toBe(true);
  });

  it("skips execution cleanly without error when concurrent sealer holds advisory lock", async () => {
    const client = await leasePool.connect();
    try {
      await client.query("BEGIN;");
      const locked = await tryAuditSealerLock(client);
      expect(locked).toBe(true);

      const sealer = new AuditSealer({
        pool: leasePool,
        registry: customRegistry,
      });

      // While client holds lock in transaction, sealer tries to seal
      const result = await sealer.sealOnce();

      expect(result.acquired).toBe(false);
      expect(result.sealedCount).toBe(0);

      // Release client transaction
      await client.query("COMMIT;");

      // Now sealer can acquire and seal
      const retryResult = await sealer.sealOnce();
      expect(retryResult.acquired).toBe(true);
    } finally {
      client.release();
    }
  });

  it("rolls back cleanly leaving audit_pending untouched if transaction callback fails", async () => {
    await leasePool.query(`
      INSERT INTO audit_pending (actor, event_type, payload)
      VALUES ('sre-alice', 'LEASE_CREATED', '{"lease_id":"lease-rollback"}');
    `);

    // Subclass or simulate failure during seal execution
    const failingSealer = new (class extends AuditSealer {
      protected override async processBatch(): Promise<never> {
        throw new Error("Simulated failure during batch insertion");
      }
    })({
      pool: leasePool,
      registry: customRegistry,
    });

    await expect(failingSealer.sealOnce()).rejects.toThrow("Simulated failure during batch insertion");

    // Verify audit_pending still contains the unsealed record
    const pendingCheck = await leasePool.query("SELECT COUNT(*)::int AS count FROM audit_pending;");
    expect(pendingCheck.rows[0]?.count).toBe(1);

    // Verify audit_events has 0 records
    const eventsCheck = await leasePool.query("SELECT COUNT(*)::int AS count FROM audit_events;");
    expect(eventsCheck.rows[0]?.count).toBe(0);
  });

  it("tracks synapse_audit_pending_age_seconds lag accurately and resets to 0 when clear", async () => {
    const sealer = new AuditSealer({
      pool: leasePool,
      registry: customRegistry,
    });

    // When empty, lag should be 0
    await sealer.sealOnce();
    const gauge = sealer.getPendingAgeGauge();
    expect(typeof gauge.set).toBe("function");
    let metricValue = (await customRegistry.getMetricsAsJSON()).find(
      (m) => m.name === "synapse_audit_pending_age_seconds"
    );
    expect(metricValue?.values[0]?.value).toBe(0);

    // Insert an event with created_at set to 15 seconds in the past
    await leasePool.query(`
      INSERT INTO audit_pending (actor, event_type, payload, created_at)
      VALUES ('sre-oncall', 'LEASE_CREATED', '{"lease_id":"stalled"}', NOW() - INTERVAL '15 seconds');
    `);

    // Update gauge without sealing
    await sealer.updatePendingAgeMetric();
    metricValue = (await customRegistry.getMetricsAsJSON()).find(
      (m) => m.name === "synapse_audit_pending_age_seconds"
    );
    const recordedLag = metricValue?.values[0]?.value ?? 0;
    expect(recordedLag).toBeGreaterThanOrEqual(14);

    // Seal the event and check that lag resets to 0
    await sealer.sealOnce();
    metricValue = (await customRegistry.getMetricsAsJSON()).find(
      (m) => m.name === "synapse_audit_pending_age_seconds"
    );
    expect(metricValue?.values[0]?.value).toBe(0);
  });

  it("handles start and stop lifecycle, awaiting in-flight sealing batch on shutdown", async () => {
    await leasePool.query(`
      INSERT INTO audit_pending (actor, event_type, payload)
      VALUES ('sre-loop', 'LEASE_CREATED', '{"loop":"test"}');
    `);

    const sealer = new AuditSealer({
      pool: leasePool,
      intervalMs: 50,
      registry: customRegistry,
    });

    expect(sealer.isSealerRunning()).toBe(false);

    sealer.start();
    expect(sealer.isSealerRunning()).toBe(true);

    // Calling start again when already running is idempotent
    sealer.start();
    expect(sealer.isSealerRunning()).toBe(true);

    // Wait for the background tick to seal the row
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Stop gracefully
    await sealer.stop();
    expect(sealer.isSealerRunning()).toBe(false);

    // Verify row was sealed
    const pendingCheck = await leasePool.query("SELECT COUNT(*)::int AS count FROM audit_pending;");
    expect(pendingCheck.rows[0]?.count).toBe(0);

    const sealedCheck = await leasePool.query("SELECT COUNT(*)::int AS count FROM audit_events;");
    expect(sealedCheck.rows[0]?.count).toBe(1);
  });
});
