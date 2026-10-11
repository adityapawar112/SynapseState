import type { Pool, PoolClient } from "pg";

/**
 * Standard lock name for the single-writer in-process audit sealer per ADR 0005.
 */
export const AUDIT_SEALER_LOCK_NAME = "synapse_audit_sealer";

/**
 * Executes a callback within a managed database transaction.
 * Automatically issues BEGIN, commits on success, and rolls back on any error.
 * Ensures the acquired client is always released back to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Failed to rollback transaction", rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Attempts to acquire a transaction-level advisory lock using PostgreSQL's hashtext.
 *
 * Per ADR 0005, transaction-level advisory locks (pg_try_advisory_xact_lock) are automatically
 * released at the end of the transaction (COMMIT or ROLLBACK) and are completely safe with
 * connection poolers like PgBouncer operating in transaction pooling mode.
 *
 * @returns true if lock was acquired, false if held by another concurrent transaction.
 */
export async function tryAdvisoryXactLock(
  client: PoolClient,
  lockName: string
): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
    [lockName]
  );
  return result.rows[0]?.locked === true;
}

/**
 * Attempts to acquire the audit sealer advisory lock within the current transaction.
 *
 * @returns true if the in-process sealer lock was acquired, false otherwise.
 */
export async function tryAuditSealerLock(client: PoolClient): Promise<boolean> {
  return tryAdvisoryXactLock(client, AUDIT_SEALER_LOCK_NAME);
}

export type AuditSealerTransactionResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; result: null };

/**
 * Executes a callback within a transaction only if the audit sealer advisory lock
 * can be immediately acquired. If another replica holds the lock, returns immediately
 * with { acquired: false, result: null } without blocking.
 */
export async function withAuditSealerTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>
): Promise<AuditSealerTransactionResult<T>> {
  return withTransaction(pool, async (client) => {
    const locked = await tryAuditSealerLock(client);
    if (!locked) {
      return { acquired: false, result: null };
    }
    const result = await callback(client);
    return { acquired: true, result };
  });
}
