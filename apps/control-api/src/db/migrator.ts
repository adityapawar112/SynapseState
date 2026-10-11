import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { leasePool } from "./pool.js";

export interface MigrationFile {
  name: string;
  path: string;
  sql: string;
}

const SCHEMA_MIGRATIONS_LOCK_KEY = "synapse_schema_migrations";

/**
 * Resolves the directory containing SQL migration files.
 */
export function resolveMigrationsDir(explicitDir?: string): string {
  if (explicitDir && fs.existsSync(explicitDir)) {
    return explicitDir;
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "migrations"),
    path.resolve(currentDir, "../src/db/migrations"),
    path.resolve(process.cwd(), "src/db/migrations"),
    path.resolve(process.cwd(), "apps/control-api/src/db/migrations"),
    path.resolve(process.cwd(), "dist/db/migrations"),
    path.resolve(process.cwd(), "apps/control-api/dist/db/migrations"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(`Could not locate migrations directory among candidates: ${candidates.join(", ")}`);
}

/**
 * Discovers and reads all SQL migration files sorted in alphabetical order.
 */
export function getMigrationFiles(migrationsDir?: string): MigrationFile[] {
  const dir = resolveMigrationsDir(migrationsDir);
  const entries = fs.readdirSync(dir);

  return entries
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const fullPath = path.join(dir, file);
      return {
        name: file,
        path: fullPath,
        sql: fs.readFileSync(fullPath, "utf-8"),
      };
    });
}

/**
 * Programmatically runs database migrations sequentially and idempotently.
 *
 * @param pool Target PostgreSQL connection pool (defaults to leasePool)
 * @param migrationsDir Optional custom path to migrations directory
 * @returns Array of applied migration names during this invocation
 */
export async function runMigrations(
  pool: Pool = leasePool,
  migrationsDir?: string
): Promise<string[]> {
  const client = await pool.connect();

  try {
    // Session-level advisory lock prevents concurrent migration runners colliding.
    // NOTE: Migrations must run via direct database connection or session-mode pooling,
    // not PgBouncer transaction-mode pooling, because the lock spans multiple migration transactions.
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [SCHEMA_MIGRATIONS_LOCK_KEY]);

    // Ensure the tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Fetch already applied migrations
    const appliedRows = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations"
    );
    const appliedSet = new Set(appliedRows.rows.map((r) => r.name));

    const migrationFiles = getMigrationFiles(migrationsDir);
    const appliedThisRun: string[] = [];

    for (const migration of migrationFiles) {
      if (appliedSet.has(migration.name)) {
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
        await client.query("COMMIT");
        appliedThisRun.push(migration.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(
          `Failed executing migration ${migration.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return appliedThisRun;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [SCHEMA_MIGRATIONS_LOCK_KEY]);
    } catch (unlockErr) {
      console.error("Failed to release migration advisory lock", unlockErr);
    }
    client.release();
  }
}
