import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { leasePool } from "./pool.js";
import {
  withTransaction,
  tryAdvisoryXactLock,
  tryAuditSealerLock,
  withAuditSealerTransaction,
  AUDIT_SEALER_LOCK_NAME,
} from "./transaction.js";

describe("Transaction & Advisory Lock Helpers", () => {
  it("defines standard audit sealer lock name", () => {
    expect(AUDIT_SEALER_LOCK_NAME).toBe("synapse_audit_sealer");
  });

  beforeAll(async () => {
    await leasePool.query(`
      CREATE TABLE IF NOT EXISTS test_transaction_items (
        id SERIAL PRIMARY KEY,
        val TEXT NOT NULL
      );
    `);
  });

  afterAll(async () => {
    await leasePool.query("DROP TABLE IF EXISTS test_transaction_items;");
  });

  it("commits database operations when transaction callback succeeds", async () => {
    const insertedVal = `committed_${Date.now()}`;

    const res = await withTransaction(leasePool, async (client) => {
      const insert = await client.query(
        "INSERT INTO test_transaction_items (val) VALUES ($1) RETURNING *",
        [insertedVal]
      );
      return insert.rows[0];
    });

    expect(res.val).toBe(insertedVal);

    const check = await leasePool.query(
      "SELECT * FROM test_transaction_items WHERE val = $1",
      [insertedVal]
    );
    expect(check.rows.length).toBe(1);
  });

  it("rolls back all operations when transaction callback throws an error", async () => {
    const rolledBackVal = `rolled_back_${Date.now()}`;

    await expect(
      withTransaction(leasePool, async (client) => {
        await client.query(
          "INSERT INTO test_transaction_items (val) VALUES ($1)",
          [rolledBackVal]
        );
        throw new Error("Simulated failure inside transaction");
      })
    ).rejects.toThrow("Simulated failure inside transaction");

    const check = await leasePool.query(
      "SELECT * FROM test_transaction_items WHERE val = $1",
      [rolledBackVal]
    );
    expect(check.rows.length).toBe(0);
  });

  it("acquires advisory transaction lock and prevents concurrent acquisition", async () => {
    const client1 = await leasePool.connect();
    const client2 = await leasePool.connect();

    try {
      await client1.query("BEGIN");
      await client2.query("BEGIN");

      // client1 acquires audit sealer lock
      const locked1 = await tryAuditSealerLock(client1);
      expect(locked1).toBe(true);

      // client2 tries to acquire same lock concurrently -> returns false
      const locked2 = await tryAuditSealerLock(client2);
      expect(locked2).toBe(false);

      // client1 commits, ending transaction and releasing advisory xact lock
      await client1.query("COMMIT");

      // Now client2 can acquire the lock
      const locked2After = await tryAuditSealerLock(client2);
      expect(locked2After).toBe(true);

      await client2.query("COMMIT");
    } finally {
      client1.release();
      client2.release();
    }
  });

  it("supports generic lock names via tryAdvisoryXactLock", async () => {
    const client = await leasePool.connect();
    try {
      await client.query("BEGIN");
      const locked = await tryAdvisoryXactLock(client, "custom_resource_lock");
      expect(locked).toBe(true);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("executes withAuditSealerTransaction cleanly", async () => {
    const res = await withAuditSealerTransaction(leasePool, async (client) => {
      const q = await client.query("SELECT 'sealed' AS status");
      return q.rows[0]?.status;
    });

    expect(res).toEqual({
      acquired: true,
      result: "sealed",
    });
  });
});
