import "dotenv/config";
import pg, { type Pool as PgPool, type PoolConfig } from "pg";

const { Pool } = pg;

const DEFAULT_DB_URL =
  "postgresql://postgres:postgres@localhost:5432/synapsestate";

export type PoolType = "lease" | "telemetry";

export function getPoolOptions(type: PoolType): PoolConfig {
  if (type === "lease") {
    const rawMax = process.env.LEASE_POOL_MAX
      ? parseInt(process.env.LEASE_POOL_MAX, 10)
      : 20;
    const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 20;
    return {
      connectionString:
        process.env.LEASE_DATABASE_URL ||
        process.env.DATABASE_URL ||
        DEFAULT_DB_URL,
      max,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }

  const rawMax = process.env.TELEMETRY_POOL_MAX
    ? parseInt(process.env.TELEMETRY_POOL_MAX, 10)
    : 5;
  const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 5;
  return {
    connectionString:
      process.env.TELEMETRY_DATABASE_URL ||
      process.env.DATABASE_URL ||
      DEFAULT_DB_URL,
    max,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 2000,
  };
}

/**
 * Creates an isolated connection pool of the specified type.
 */
export function createPool(
  type: PoolType,
  overrides?: Partial<PoolConfig>,
): PgPool {
  const options = { ...getPoolOptions(type), ...overrides };
  const pool = new Pool(options);
  pool.on("error", (err) => {
    console.error(`Unexpected error on idle client in ${type}Pool`, err);
  });
  return pool;
}

/**
 * Dedicated, high-priority connection pool for emergency break-glass lease CRUD
 * and critical state delivery synchronization.
 */
export const leasePool = createPool("lease");

/**
 * Bounded, low-priority connection pool for bulk telemetry batch ingestion.
 * Capped pool size ensures telemetry traffic cannot starve lease operations.
 */
export const telemetryPool = createPool("telemetry");

/**
 * Gracefully closes all active database connection pools.
 */
export async function closePools(): Promise<void> {
  const results = await Promise.allSettled([
    leasePool.end(),
    telemetryPool.end(),
  ]);
  for (const res of results) {
    if (res.status === "rejected") {
      console.error(
        "Failed closing connection pool during shutdown",
        res.reason,
      );
    }
  }
}
