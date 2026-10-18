import { describe, it, expect } from "vitest";
import { leasePool } from "./pool.js";
import { runMigrations, getMigrationFiles } from "./migrator.js";

describe("Database Migrations & Schema Invariants", () => {
  it("discovers all 7 sequential migration files", () => {
    const files = getMigrationFiles();
    expect(files.map((f) => f.name)).toEqual([
      "001_create_leases.sql",
      "002_create_revocations.sql",
      "003_create_audit_ledger.sql",
      "004_create_change_events.sql",
      "005_create_telemetry_and_services.sql",
      "006_create_api_tokens.sql",
      "007_flag_usage_daily_lookup_idx.sql",
    ]);
  });

  it("applies all migrations idempotently", async () => {
    // First run applies pending migrations
    const appliedFirst = await runMigrations(leasePool);
    expect(Array.isArray(appliedFirst)).toBe(true);

    // Second run is a no-op and returns empty applied list
    const appliedSecond = await runMigrations(leasePool);
    expect(appliedSecond).toEqual([]);

    // Check schema_migrations has all 7 recorded
    const migRows = await leasePool.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name ASC"
    );
    expect(migRows.rows.map((r: { name: string }) => r.name)).toEqual([
      "001_create_leases.sql",
      "002_create_revocations.sql",
      "003_create_audit_ledger.sql",
      "004_create_change_events.sql",
      "005_create_telemetry_and_services.sql",
      "006_create_api_tokens.sql",
      "007_flag_usage_daily_lookup_idx.sql",
    ]);
  });

  it("enforces partial unique index on active leases (only ONE active lease per flag per env)", async () => {
    const flagKey = `flag_test_${Date.now()}`;
    const env = "production";

    // Insert first ACTIVE lease -> succeeds
    await leasePool.query(
      `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW(), 1800, NOW() + INTERVAL '30 minutes', 'kid_test_1')`,
      [`01HQ001_${Date.now()}`, flagKey, env, JSON.stringify({ variant: "on" }), "sig_1"]
    );

    // Insert second ACTIVE lease for same (flag_key, env) -> MUST fail unique constraint
    await expect(
      leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW(), 1800, NOW() + INTERVAL '30 minutes', 'kid_test_2')`,
        [`01HQ002_${Date.now()}`, flagKey, env, JSON.stringify({ variant: "off" }), "sig_2"]
      )
    ).rejects.toThrow(/idx_active_lease_per_flag_env/);

    // But inserting a non-ACTIVE (e.g. SUPERSEDED or EXPIRED) lease for same (flag_key, env) succeeds
    await leasePool.query(
      `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
       VALUES ($1, $2, $3, $4, $5, 'EXPIRED', NOW(), 1800, NOW(), 'kid_test_3')`,
      [`01HQ003_${Date.now()}`, flagKey, env, JSON.stringify({ variant: "off" }), "sig_3"]
    );
  });

  it("verifies fillfactor = 70 on flag_usage_daily for HOT optimization", async () => {
    const res = await leasePool.query<{ reloptions: string[] | null }>(
      `SELECT reloptions FROM pg_class WHERE relname = 'flag_usage_daily'`
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.reloptions).toContain("fillfactor=70");
  });

  it("verifies all expected tables and compound indexes exist", async () => {
    const tablesRes = await leasePool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tableNames = tablesRes.rows.map((r: { table_name: string }) => r.table_name);

    expect(tableNames).toContain("flags");
    expect(tableNames).toContain("leases");
    expect(tableNames).toContain("revocations");
    expect(tableNames).toContain("key_revocations");
    expect(tableNames).toContain("services");
    expect(tableNames).toContain("flag_usage_daily");
    expect(tableNames).toContain("audit_pending");
    expect(tableNames).toContain("audit_events");
    expect(tableNames).toContain("change_events");
    expect(tableNames).toContain("api_tokens");

    // Indexes
    const indexesRes = await leasePool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    );
    const indexNames = indexesRes.rows.map((r: { indexname: string }) => r.indexname);

    expect(indexNames).toContain("idx_active_lease_per_flag_env");
    expect(indexNames).toContain("idx_leases_expires_at");
    expect(indexNames).toContain("idx_revocations_expires_at");
    expect(indexNames).toContain("idx_change_events_lookup");
    expect(indexNames).toContain("idx_change_events_flag");
  });

  it("enforces ttl_seconds check constraint (0 < ttl <= 86400)", async () => {
    const flagKey = `flag_ttl_${Date.now()}`;

    // ttl_seconds = 0 -> fails check constraint
    await expect(
      leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
         VALUES ($1, $2, 'dev', '{}', 'sig', 'EXPIRED', NOW(), 0, NOW(), 'kid')`,
        [`01HQ_TTL0_${Date.now()}`, flagKey]
      )
    ).rejects.toThrow(/check constraint|leases_ttl_seconds_check/i);

    // ttl_seconds = 86401 (exceeds 24 hours max) -> fails check constraint
    await expect(
      leasePool.query(
        `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
         VALUES ($1, $2, 'dev', '{}', 'sig', 'EXPIRED', NOW(), 86401, NOW(), 'kid')`,
        [`01HQ_TTL86401_${Date.now()}`, flagKey]
      )
    ).rejects.toThrow(/check constraint|leases_ttl_seconds_check/i);
  });

  it("enforces change_events event_type whitelist", async () => {
    // Valid event type -> succeeds
    const valid = await leasePool.query(
      `INSERT INTO change_events (event_type, env, flag_key, actor, payload)
       VALUES ('LEASE_CREATED', 'production', 'flag_alpha', 'operator_1', '{"variant":"b"}')
       RETURNING id, event_type`
    );
    expect(valid.rows[0]?.event_type).toBe("LEASE_CREATED");

    // Invalid event type -> fails check constraint
    await expect(
      leasePool.query(
        `INSERT INTO change_events (event_type, env, flag_key, actor, payload)
         VALUES ('RANDOM_EVENT', 'production', 'flag_alpha', 'operator_1', '{}')`
      )
    ).rejects.toThrow(/check constraint|change_events_event_type_check/i);
  });

  it("verifies audit_pending staging and audit_events ledger schema", async () => {
    // Stage pending audit event
    const pending = await leasePool.query(
      `INSERT INTO audit_pending (actor, event_type, payload)
       VALUES ('sre_oncall', 'EMERGENCY_OVERRIDE_CREATED', '{"lease_id":"test_1"}')
       RETURNING id, actor, event_type, payload`
    );
    expect(pending.rows[0]?.actor).toBe("sre_oncall");
    expect(pending.rows[0]?.event_type).toBe("EMERGENCY_OVERRIDE_CREATED");

    // Seal ledger event
    const sealed = await leasePool.query(
      `INSERT INTO audit_events (ts, actor, event_type, payload, prev_hash, hash)
       VALUES (NOW(), 'sealer', 'EMERGENCY_OVERRIDE_CREATED', '{"lease_id":"test_1"}', 'GENESIS_0', 'HASH_1')
       RETURNING seq, prev_hash, hash`
    );
    expect(sealed.rows[0]?.prev_hash).toBe("GENESIS_0");
    expect(sealed.rows[0]?.hash).toBe("HASH_1");
  });

  it("verifies api_tokens stores SHA-256 token hash and roles array", async () => {
    const tokenId = `tok_${Date.now()}`;
    const tokenHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    const token = await leasePool.query<{ token_id: string; roles: string[] }>(
      `INSERT INTO api_tokens (token_id, token_hash, service_name, env, roles)
       VALUES ($1, $2, 'checkout-service', 'production', ARRAY['read:state', 'write:telemetry'])
       RETURNING token_id, roles`,
      [tokenId, tokenHash]
    );

    expect(token.rows[0]?.token_id).toBe(tokenId);
    expect(token.rows[0]?.roles).toEqual(["read:state", "write:telemetry"]);
  });
});
