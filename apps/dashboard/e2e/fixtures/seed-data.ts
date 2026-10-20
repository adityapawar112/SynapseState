import crypto from "node:crypto";
import {
  signLease,
  computeEventHash,
  GENESIS_PREV_HASH,
  type LeaseEnvelope,
  type LeasePayload,
} from "@synapsestate/lease";

// Deterministic or freshly generated operator Ed25519 key for seed signatures
export const operatorKeyPair = crypto.generateKeyPairSync("ed25519");

const now = new Date();

// 1. Active Lease for checkout-v2-optimization
export const activeLeasePayload: LeasePayload = {
  v: 1,
  lease_id: "01J9X57YTRPQ8A7F4E00112233",
  env: "prod",
  flag_key: "checkout-v2-optimization",
  value: "pipeline-b",
  reason: "Incident #4891: Database CPU spike mitigation",
  issued_at: new Date(now.getTime() - 120_000).toISOString(), // 2 minutes ago
  ttl_seconds: 1800, // 30 minutes total -> ~28m remaining
  kid: "ops-emergency-key",
  nonce: "seed-nonce-active-001",
};
export const activeLeaseEnvelope: LeaseEnvelope = signLease(
  activeLeasePayload,
  operatorKeyPair.privateKey
);

// 2. Near Expiry Lease for payment-gateway-timeout (< 300s remaining)
export const nearExpiryLeasePayload: LeasePayload = {
  v: 1,
  lease_id: "01J9X57YTRPQ8A7F4E00445566",
  env: "prod",
  flag_key: "payment-gateway-timeout",
  value: 5000,
  reason: "Network jitter compensation during provider outage",
  issued_at: new Date(now.getTime() - 240_000).toISOString(), // 4m ago of 5m ttl
  ttl_seconds: 300, // 60s remaining (< 5m threshold)
  kid: "ops-emergency-key",
  nonce: "seed-nonce-near-002",
};
export const nearExpiryLeaseEnvelope: LeaseEnvelope = signLease(
  nearExpiryLeasePayload,
  operatorKeyPair.privateKey
);

// 3. Expired Lease for legacy-inventory-sync
export const expiredLeasePayload: LeasePayload = {
  v: 1,
  lease_id: "01J9X57YTRPQ8A7F4E00778899",
  env: "prod",
  flag_key: "legacy-inventory-sync",
  value: false,
  reason: "Legacy inventory sync bypass during schema migration",
  issued_at: new Date(now.getTime() - 600_000).toISOString(), // 10 minutes ago
  ttl_seconds: 60, // Expired 9 minutes ago
  kid: "ops-emergency-key",
  nonce: "seed-nonce-exp-003",
};
export const expiredLeaseEnvelope: LeaseEnvelope = signLease(
  expiredLeasePayload,
  operatorKeyPair.privateKey
);

export const ALL_SEEDED_LEASES: LeaseEnvelope[] = [
  activeLeaseEnvelope,
  nearExpiryLeaseEnvelope,
  expiredLeaseEnvelope,
];

// Telemetry evaluations data for flags
export const SEEDED_FLAG_EVALUATIONS = [
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
  ts: new Date(now.getTime() - 900_000).toISOString(),
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
  ts: new Date(now.getTime() - 600_000).toISOString(),
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
  ts: new Date(now.getTime() - 300_000).toISOString(),
  actor: "platform-admin",
  event_type: "CHECKPOINT_SEALED",
  payload: {
    checkpointSeq: 1,
    sealedCount: 3,
  },
};
const hash3 = computeEventHash(hash2, auditEvent3);

export const SEEDED_AUDIT_EVENTS = [
  { ...auditEvent1, prev_hash: GENESIS_PREV_HASH, hash: hash1 },
  { ...auditEvent2, prev_hash: hash1, hash: hash2 },
  { ...auditEvent3, prev_hash: hash2, hash: hash3 },
];

export const SEEDED_CHECKPOINT = {
  checkpoint_seq: 1,
  checkpoint_hash: hash3,
  sealed_count: 3,
  timestamp: auditEvent3.ts,
};

/**
 * Seeds PostgreSQL database if connection pool is available.
 */
export async function seedPostgresDatabase(clientOrPool: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  // 1. Seed Flags
  const flags = [
    { key: "checkout-v2-optimization", env: "prod", class: "release", owner: "checkout-team" },
    { key: "payment-gateway-timeout", env: "prod", class: "killswitch", owner: "payments-team" },
    { key: "legacy-inventory-sync", env: "prod", class: "permanent", owner: "logistics-team" },
    { key: "recommendations-model-v2", env: "prod", class: "release", owner: "ai-team" },
    { key: "search-ranker-algo", env: "prod", class: "release", owner: "search-team" },
    // Also add one for staging to verify env selector
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
      activeLeasePayload.lease_id,
      activeLeasePayload.flag_key,
      activeLeasePayload.env,
      JSON.stringify(activeLeasePayload),
      activeLeaseEnvelope.sig,
      activeLeasePayload.issued_at,
      activeLeasePayload.ttl_seconds,
      new Date(new Date(activeLeasePayload.issued_at).getTime() + activeLeasePayload.ttl_seconds * 1000),
      activeLeasePayload.kid,
    ]
  );

  await clientOrPool.query(
    `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'ACTIVE', $6, $7, $8, $9)
     ON CONFLICT (lease_id) DO UPDATE SET state = 'ACTIVE', expires_at = $8`,
    [
      nearExpiryLeasePayload.lease_id,
      nearExpiryLeasePayload.flag_key,
      nearExpiryLeasePayload.env,
      JSON.stringify(nearExpiryLeasePayload),
      nearExpiryLeaseEnvelope.sig,
      nearExpiryLeasePayload.issued_at,
      nearExpiryLeasePayload.ttl_seconds,
      new Date(new Date(nearExpiryLeasePayload.issued_at).getTime() + nearExpiryLeasePayload.ttl_seconds * 1000),
      nearExpiryLeasePayload.kid,
    ]
  );

  await clientOrPool.query(
    `INSERT INTO leases (lease_id, flag_key, env, payload, sig, state, issued_at, ttl_seconds, expires_at, created_by_kid)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'EXPIRED', $6, $7, $8, $9)
     ON CONFLICT (lease_id) DO UPDATE SET state = 'EXPIRED'`,
    [
      expiredLeasePayload.lease_id,
      expiredLeasePayload.flag_key,
      expiredLeasePayload.env,
      JSON.stringify(expiredLeasePayload),
      expiredLeaseEnvelope.sig,
      expiredLeasePayload.issued_at,
      expiredLeasePayload.ttl_seconds,
      new Date(new Date(expiredLeasePayload.issued_at).getTime() + expiredLeasePayload.ttl_seconds * 1000),
      expiredLeasePayload.kid,
    ]
  );

  // 3. Seed Flag Usage Daily
  const today = now.toISOString().slice(0, 10);
  for (const evalItem of SEEDED_FLAG_EVALUATIONS) {
    await clientOrPool.query(
      `INSERT INTO flag_usage_daily (flag_key, env, service, variant, usage_date, eval_count, first_seen, last_seen)
       VALUES ($1, 'prod', 'demo-shop', $2, $3, $4, NOW() - INTERVAL '1 day', NOW())
       ON CONFLICT (flag_key, env, service, variant, usage_date)
       DO UPDATE SET eval_count = $4, last_seen = NOW()`,
      [evalItem.flag_key, evalItem.variant, today, evalItem.eval_count]
    );
  }

  // 4. Seed Audit Events
  for (const ev of SEEDED_AUDIT_EVENTS) {
    await clientOrPool.query(
      `INSERT INTO audit_events (seq, ts, actor, event_type, payload, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (seq) DO NOTHING`,
      [ev.seq, ev.ts, ev.actor, ev.event_type, JSON.stringify(ev.payload), ev.prev_hash, ev.hash]
    );
  }
}
