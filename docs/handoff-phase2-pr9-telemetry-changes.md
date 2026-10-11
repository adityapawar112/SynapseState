# SynapseState Handoff: Phase 2 — Bulkhead Telemetry Ingestion & Change Event Feed (`apps/control-api`)

> **Target Session:** Implement PR 9 (`feat/control-api-telemetry-changes`)  
> **Repository:** `synapsestate/synapsestate`  
> **Target Branch:** `feat/control-api-telemetry-changes` (branch from `main` after merging PR 8, or from commit `d9762c0`)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Invariant 5 Zero-Context Telemetry)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§4.4 Telemetry Collection & Bulkhead Pipeline, §7 Relational Data Model, §11.3 Incident Attribution Engine)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 2.1 & Phase 2.2)  
> - SDK Telemetry Reference: [packages/sdk/src/telemetry-hook.ts](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk/src/telemetry-hook.ts)  

---

## 1. Executive Summary & Monorepo State

PR 8 (`feat/control-api-audit-sealer`) has been implemented, verified, committed ([`d9762c0`](https://github.com/adityapawar112/SynapseState/commit/d9762c0)), and submitted as [PR #8](https://github.com/adityapawar112/SynapseState/pull/8).

### Current Status:
- **Monorepo Health:** 100% green across all packages (Lint, Build, Typecheck, Test).
- **Test Suite:** 31 test files, 239 tests passing locally.
- **Database Tables Initialized:**
  - `change_events` (migration `004_create_change_events.sql`)
  - `services` and `flag_usage_daily` (migration `005_create_telemetry_and_services.sql`)
  - `api_tokens` (migration `006_create_api_tokens.sql`)
- **Connection Pools Ready:**
  `apps/control-api/src/db/pool.ts` provides:
  - `leasePool`: Primary high-priority pool (`max = 20`) for leases, audit sealer, and state delivery.
  - `telemetryPool`: Isolated bulkhead pool (`max = 5`, `connectionTimeoutMillis: 2000`) for low-priority telemetry ingestion.

---

## 2. Invariants & Architectural Requirements for PR 9

All code for PR 9 must strictly satisfy the following requirements:

1. **Zero-Context Telemetry (Invariant 5, ARCH §4.4):**
   - Telemetry ingestion must **never** accept, process, log, or persist user IDs, session tokens, or targeting attributes.
   - Accept strictly `(flag_key, variant, reason, count)` tuples.

2. **Bulkhead Pool Isolation & Load Shedding (ARCH §4.4 Step 4):**
   - `POST /v1/telemetry/batches` must run strictly against `telemetryPool`.
   - Under heavy load, slow queries, or pool exhaustion, the endpoint must rapidly fail open / shed load by returning `429 Too Many Requests` or `503 Service Unavailable`.
   - **Critical Invariant:** Heavy telemetry traffic must NEVER starve, block, or delay emergency lease operations (`leasePool`).

3. **Deterministic Row-Lock Deadlock Prevention (ARCH §4.4 Step 3):**
   - Ingested metrics in `POST /v1/telemetry/batches` must be sorted by `(flag_key ASC, variant ASC, reason ASC)` before database upsert, preventing PostgreSQL row-lock deadlocks during concurrent multi-row batch writes.

4. **Idempotent Batch Upsert & Heartbeat (ARCH §4.4, §7):**
   - **`flag_usage_daily` upsert:**
     ```sql
     INSERT INTO flag_usage_daily (flag_key, env, service, variant, usage_date, eval_count, first_seen, last_seen)
     VALUES (...)
     ON CONFLICT (flag_key, env, service, variant, usage_date)
     DO UPDATE SET 
       eval_count = flag_usage_daily.eval_count + EXCLUDED.eval_count,
       last_seen = GREATEST(flag_usage_daily.last_seen, EXCLUDED.last_seen);
     ```
   - **`services` heartbeat:**
     Updates `last_seen = NOW()`, `status = 'ACTIVE'`, and records `sdk_version`.

5. **Incident Attribution Change Feed (ARCH §11.3):**
   - `GET /v1/changes`: supports querying change history from `change_events` (`occurred_at DESC, id DESC`).
   - Query filters: `env` (required), `since` (supports duration like `30m`, `1h`, `24h` or ISO timestamp), `flag_key` (optional), `limit` (optional, default 50, capped at 200).
   - Powers the CLI `synapse log` incident investigation command.

---

## 3. Scope of Deliverables for PR 9

### Deliverables to Create in `apps/control-api/`:

```
apps/control-api/src/routes/
├── telemetry.ts         # Fastify route plugin for POST /v1/telemetry/batches (bulkhead pool & load shedding)
├── telemetry.test.ts    # Integration tests: batch upserts, deadlock prevention, 429/503 load shedding
├── changes.ts           # Fastify route plugin for GET /v1/changes (incident change-event feed)
└── changes.test.ts      # Integration tests: time filtering, env scoping, pagination limits
```

### Server Wiring:
- In `apps/control-api/src/app.ts`:
  - Register `telemetryRoutes` passing `{ telemetryPool }`.
  - Register `changeRoutes` passing `{ leasePool }`.
- In `apps/control-api/src/index.ts`:
  - Export `telemetryRoutes` and `changeRoutes`.

---

## 4. Verification & Quality Gates

The implementation must pass all checks before PR creation:
```bash
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm run test:coverage
```

### Required Test Scenarios:
1. **Telemetry Ingestion (`telemetry.test.ts`):**
   - Ingests batch payload conforming to `TelemetryBatchPayload` from `@synapsestate/sdk`.
   - Correctly aggregates `eval_count` into `flag_usage_daily` across multiple batches on the same day.
   - Updates heartbeat in `services` table (`last_seen`, `status = 'ACTIVE'`).
   - Rejects batches containing unexpected context attributes.
   - Gracefully sheds load with HTTP 429/503 when pool connection times out.
2. **Change Events Feed (`changes.test.ts`):**
   - Returns change events filtered by `env` and `since` window.
   - Supports relative duration strings (`30m`, `2h`, `1d`) and ISO timestamps.
   - Orders events deterministically by `occurred_at DESC, id DESC`.
   - Enforces limit constraints (default 50, maximum 200).

---

## 5. Suggested Skills to Invoke

When picking up this handoff, activate the following skills:
- `test-driven-development`: Write failing tests for telemetry batch ingestion and change-event queries before writing the routes.
- `verification-before-completion`: Run full lint, build, typecheck, and test coverage before submitting the PR.
- `requesting-code-review`: Generate structured review context with commit SHAs upon completion.
- `codebase-design`: Keep route handlers focused and encapsulate database queries cleanly.
