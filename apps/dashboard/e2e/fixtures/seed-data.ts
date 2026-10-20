import crypto from "node:crypto";
import {
  signLease,
  computeEventHash,
  GENESIS_PREV_HASH,
  type LeaseEnvelope,
  type LeasePayload,
} from "@synapsestate/lease";

// Deterministic PKCS#8 Ed25519 key for reproducible E2E test runs
const FIXED_ED25519_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIO9uJSxND55Q+Seb6cdQZYTmYF8qsj/YtTy8AhK1kTFE
-----END PRIVATE KEY-----`;

export const operatorPrivateKey = crypto.createPrivateKey(FIXED_ED25519_PRIVATE_KEY_PEM);
export const operatorPublicKey = crypto.createPublicKey(operatorPrivateKey);

export interface SeedDataResult {
  activeLeasePayload: LeasePayload;
  activeLeaseEnvelope: LeaseEnvelope;
  nearExpiryLeasePayload: LeasePayload;
  nearExpiryLeaseEnvelope: LeaseEnvelope;
  expiredLeasePayload: LeasePayload;
  expiredLeaseEnvelope: LeaseEnvelope;
  allLeases: LeaseEnvelope[];
  flagEvaluations: Array<{ flag_key: string; variant: string; eval_count: number }>;
  auditEvents: Array<{
    seq: number;
    ts: string;
    actor: string;
    event_type: string;
    payload: Record<string, unknown>;
    prev_hash: string;
    hash: string;
  }>;
  checkpoint: {
    checkpoint_seq: number;
    checkpoint_hash: string;
    sealed_count: number;
    timestamp: string;
  };
}

/**
 * Builds fresh, contract-compliant seed data relative to an execution timestamp.
 * Guarantees near-expiry lease has >= 4m margin so it never expires during test execution.
 */
export function buildSeedData(baseTime = new Date()): SeedDataResult {
  // 1. Active Lease for checkout-v2-optimization (issued 2m ago, ttl 30m -> ~28m remaining)
  const activeLeasePayload: LeasePayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E00112233",
    env: "prod",
    flag_key: "checkout-v2-optimization",
    value: "pipeline-b",
    reason: "Incident #4891: Database CPU spike mitigation",
    issued_at: new Date(baseTime.getTime() - 120_000).toISOString(),
    ttl_seconds: 1800,
    kid: "ops-emergency-key",
    nonce: "seed-nonce-active-001",
  };
  const activeLeaseEnvelope = signLease(activeLeasePayload, operatorPrivateKey);

  // 2. Near Expiry Lease for payment-gateway-timeout (ttl 10m, issued 6m ago -> 4m / 240s remaining <= 300s)
  const nearExpiryLeasePayload: LeasePayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E00445566",
    env: "prod",
    flag_key: "payment-gateway-timeout",
    value: 5000,
    reason: "Network jitter compensation during provider outage",
    issued_at: new Date(baseTime.getTime() - 360_000).toISOString(),
    ttl_seconds: 600, // 240s remaining (strictly <= 300s threshold, with 4 min buffer)
    kid: "ops-emergency-key",
    nonce: "seed-nonce-near-002",
  };
  const nearExpiryLeaseEnvelope = signLease(nearExpiryLeasePayload, operatorPrivateKey);

  // 3. Expired Lease for legacy-inventory-sync (issued 10m ago, ttl 60s -> expired 9m ago)
  const expiredLeasePayload: LeasePayload = {
    v: 1,
    lease_id: "01J9X57YTRPQ8A7F4E00778899",
    env: "prod",
    flag_key: "legacy-inventory-sync",
    value: false,
    reason: "Legacy inventory sync bypass during schema migration",
    issued_at: new Date(baseTime.getTime() - 600_000).toISOString(),
    ttl_seconds: 60,
    kid: "ops-emergency-key",
    nonce: "seed-nonce-exp-003",
  };
  const expiredLeaseEnvelope = signLease(expiredLeasePayload, operatorPrivateKey);

  const allLeases: LeaseEnvelope[] = [
    activeLeaseEnvelope,
    nearExpiryLeaseEnvelope,
    expiredLeaseEnvelope,
  ];

  // Telemetry evaluations data for flags
  const flagEvaluations = [
    // Quiescent candidate flag (>99% on variant "v2", >= 100 evaluations)
    { flag_key: "recommendations-model-v2", variant: "v2", eval_count: 5000 },
    { flag_key: "recommendations-model-v2", variant: "control", eval_count: 5 },
    // Non-quiescent active split flag
    { flag_key: "search-ranker-algo", variant: "bm25", eval_count: 1200 },
    { flag_key: "search-ranker-algo", variant: "vector", eval_count: 1150 },
    // Active lease flag
    { flag_key: "checkout-v2-optimization", variant: "pipeline-b", eval_count: 3500 },
  ];

  // Audit ledger chained events
  const auditEvent1 = {
    seq: 1,
    ts: new Date(baseTime.getTime() - 900_000).toISOString(),
    actor: "ops-sre-lead",
    event_type: "LEASE_INGESTED",
    payload: {
      leaseId: activeLeasePayload.lease_id,
      flagKey: activeLeasePayload.flag_key,
      env: "prod",
      ttl: activeLeasePayload.ttl_seconds,
    },
  };
  const hash1 = computeEventHash(GENESIS_PREV_HASH, auditEvent1);

  const auditEvent2 = {
    seq: 2,
    ts: new Date(baseTime.getTime() - 600_000).toISOString(),
    actor: "ops-sre-lead",
    event_type: "LEASE_REVOKE_REQUESTED",
    payload: {
      leaseId: nearExpiryLeasePayload.lease_id,
      flagKey: nearExpiryLeasePayload.flag_key,
      env: "prod",
      reason: "Mitigation rolled back",
    },
  };
  const hash2 = computeEventHash(hash1, auditEvent2);

  const auditEvent3 = {
    seq: 3,
    ts: new Date(baseTime.getTime() - 300_000).toISOString(),
    actor: "platform-admin",
    event_type: "CHECKPOINT_SEALED",
    payload: {
      checkpointSeq: 1,
      sealedCount: 3,
    },
  };
  const hash3 = computeEventHash(hash2, auditEvent3);

  const auditEvents = [
    { ...auditEvent1, prev_hash: GENESIS_PREV_HASH, hash: hash1 },
    { ...auditEvent2, prev_hash: hash1, hash: hash2 },
    { ...auditEvent3, prev_hash: hash2, hash: hash3 },
  ];

  const checkpoint = {
    checkpoint_seq: 1,
    checkpoint_hash: hash3,
    sealed_count: 3,
    timestamp: auditEvent3.ts,
  };

  return {
    activeLeasePayload,
    activeLeaseEnvelope,
    nearExpiryLeasePayload,
    nearExpiryLeaseEnvelope,
    expiredLeasePayload,
    expiredLeaseEnvelope,
    allLeases,
    flagEvaluations,
    auditEvents,
    checkpoint,
  };
}

let currentSeed = buildSeedData();

export function refreshSeedData(): SeedDataResult {
  currentSeed = buildSeedData(new Date());
  return currentSeed;
}

export function getCurrentSeed(): SeedDataResult {
  return currentSeed;
}

export const activeLeasePayload = currentSeed.activeLeasePayload;
export const activeLeaseEnvelope = currentSeed.activeLeaseEnvelope;
export const nearExpiryLeasePayload = currentSeed.nearExpiryLeasePayload;
export const nearExpiryLeaseEnvelope = currentSeed.nearExpiryLeaseEnvelope;
export const expiredLeasePayload = currentSeed.expiredLeasePayload;
export const expiredLeaseEnvelope = currentSeed.expiredLeaseEnvelope;
export const ALL_SEEDED_LEASES = currentSeed.allLeases;
export const SEEDED_FLAG_EVALUATIONS = currentSeed.flagEvaluations;
export const SEEDED_AUDIT_EVENTS = currentSeed.auditEvents;
export const SEEDED_CHECKPOINT = currentSeed.checkpoint;

/**
 * Seeds PostgreSQL database if connection pool is available.
 */
export async function seedPostgresDatabase(clientOrPool: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  const seed = buildSeedData(new Date());

  // 1. Seed Flags
  const flags = [
    { key: "checkout-v2-optimization", env: "prod", class: "release", owner: "checkout-team" },
    { key: "payment-gateway-timeout", env: "prod", class: "killswitch", owner: "payments-team" },
    { key: "legacy-inventory-sync", env: "prod", class: "permanent", owner: "logistics-team" },
    { key: "recommendations-model-v2", env: "prod", class: "release", owner: "ai-team" },
    { key: "search-ranker-algo", env: "prod", class: "release", owner: "search-team" },
    { key: "staging-experimental-feature", env: "staging", class: "release", owner: "platform-team" },
  ];

  for (const f of flags) {
    await clientOrPool.query(
      `INSERT INTO flags (key, env, class, owner, description, registry_version)
       VALUES ($1, $2, $3, $4, 'E2E Seed Flag', 1)
       ON CONFLICT (key, env) DO NOTHING`,
      [f.key, f.env, f.class, f.owner]
    );
  }

  // 2. Seed Leases
  await clientOrPool.query(
    `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'ACTIVE', $6, $7, $8, $9)
     ON CONFLICT (lease_id) DO UPDATE SET state = 'ACTIVE', expires_at = $8`,
    [
      seed.activeLeasePayload.lease_id,
      seed.activeLeasePayload.flag_key,
      seed.activeLeasePayload.env,
      JSON.stringify(seed.activeLeasePayload),
      seed.activeLeaseEnvelope.sig,
      seed.activeLeasePayload.issued_at,
      seed.activeLeasePayload.ttl_seconds,
      new Date(new Date(seed.activeLeasePayload.issued_at).getTime() + seed.activeLeasePayload.ttl_seconds * 1000),
      seed.activeLeasePayload.kid,
    ]
  );

  await clientOrPool.query(
    `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'ACTIVE', $6, $7, $8, $9)
     ON CONFLICT (lease_id) DO UPDATE SET state = 'ACTIVE', expires_at = $8`,
    [
      seed.nearExpiryLeasePayload.lease_id,
      seed.nearExpiryLeasePayload.flag_key,
      seed.nearExpiryLeasePayload.env,
      JSON.stringify(seed.nearExpiryLeasePayload),
      seed.nearExpiryLeaseEnvelope.sig,
      seed.nearExpiryLeasePayload.issued_at,
      seed.nearExpiryLeasePayload.ttl_seconds,
      new Date(new Date(seed.nearExpiryLeasePayload.issued_at).getTime() + seed.nearExpiryLeasePayload.ttl_seconds * 1000),
      seed.nearExpiryLeasePayload.kid,
    ]
  );

  await clientOrPool.query(
    `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'EXPIRED', $6, $7, $8, $9)
     ON CONFLICT (lease_id) DO UPDATE SET state = 'EXPIRED'`,
    [
      seed.expiredLeasePayload.lease_id,
      seed.expiredLeasePayload.flag_key,
      seed.expiredLeasePayload.env,
      JSON.stringify(seed.expiredLeasePayload),
      seed.expiredLeaseEnvelope.sig,
      seed.expiredLeasePayload.issued_at,
      seed.expiredLeasePayload.ttl_seconds,
      new Date(new Date(seed.expiredLeasePayload.issued_at).getTime() + seed.expiredLeasePayload.ttl_seconds * 1000),
      seed.expiredLeasePayload.kid,
    ]
  );

  // 3. Seed Flag Usage Daily
  const today = new Date().toISOString().slice(0, 10);
  for (const evalItem of seed.flagEvaluations) {
    await clientOrPool.query(
      `INSERT INTO flag_usage_daily (flag_key, env, service, variant, usage_date, eval_count, first_seen, last_seen)
       VALUES ($1, 'prod', 'demo-shop', $2, $3, $4, NOW() - INTERVAL '1 day', NOW())
       ON CONFLICT (flag_key, env, service, variant, usage_date)
       DO UPDATE SET eval_count = $4, last_seen = NOW()`,
      [evalItem.flag_key, evalItem.variant, today, evalItem.eval_count]
    );
  }

  // 4. Seed Audit Events
  for (const ev of seed.auditEvents) {
    await clientOrPool.query(
      `INSERT INTO audit_events (seq, ts, actor, event_type, payload, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (seq) DO NOTHING`,
      [ev.seq, ev.ts, ev.actor, ev.event_type, JSON.stringify(ev.payload), ev.prev_hash, ev.hash]
    );
  }
}
