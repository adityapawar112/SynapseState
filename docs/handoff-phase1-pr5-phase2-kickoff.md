# SynapseState Handoff: Phase 1 Complete & Phase 2 Kickoff

> **Target Session:** Phase 1 Wrap-up & Phase 2 Kickoff (PR 6: `feat/control-api-scaffolding`)
> **Repository:** `synapsestate/synapsestate`
> **Base Branch:** `main` (after merging `perf/sdk-microbenchmarks`)
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: `AGENTS.md` (Sections 1, 2, 5, 7)
> - Authoritative Architecture: `docs/ARCHITECTURE.md` (Sections 4.1–4.4, 7, 8)
> - Technical Specification: `docs/SpecDoc.md` (Sections 2.1–2.4, 5.1)
> - Delivery Roadmap: `docs/ROADMAP.md` (Phase 2, PR 6)
> - Limitations & Boundaries: `docs/limitations.md`
> - Hot-Path Evaluation Benchmarks: `docs/benchmarks/sdk-overhead.md`

---

## 1. Executive Summary: Phase 1 100% Complete

Phase 1 delivered the complete cryptographic foundation, golden conformance suite, high-performance in-process SDK, and continuous hot-path microbenchmarks:

### 1.1 PR 1 (`feat/lease-crypto-schemas`): Cryptographic Core (`packages/lease`)

- **Delivered:** RFC 8785 canonicalization (`canonicalizeJson`), Ed25519 signing & verification with domain separation (`synapsestate/lease/v1\n`, `synapsestate/revocation/v1\n`, `synapsestate/keyrevocation/v1\n`), Zod schemas, dual-clock expiry validator (`evaluateLeaseExpiry`, `isLeaseActive`), and Git-pinned keyset parser.
- **Tests:** 91 passing tests in `packages/lease`.

### 1.2 PR 2 (`feat/conformance-golden-vectors`): Golden Conformance Suite (`packages/conformance`)

- **Delivered:** 14 deterministic JSON fixtures (55 vectors), fixture generator script, pure TypeScript runner enforcing keyset-policy seams, canonical failure codes, base64url malleability rejection, and single-byte mutation rejection.
- **Tests:** 22 passing tests in `packages/conformance`.

### 1.3 PR 3 (`feat/sdk-override-provider`): In-Process OverrideProvider (`packages/sdk`)

- **Delivered:** `OverrideProvider`, `LeaseStore` (in-memory verified lease map with thread-safe pointer references, dual-clock expiry, conflict resolution, anti-monotonic protection), `KeysetWatcher` (10s file-hash polling on `/etc/synapse/keyset/keyset.json`), and `EmergencyScanner` (air-gapped `/etc/synapse/emergency-leases/*.json`).
- **Tests:** 35 passing tests in `packages/sdk`.

### 1.4 PR 4 (`feat/sdk-long-poll-telemetry`): State Synchronization & Zero-Context Telemetry (`packages/sdk`)

- **Delivered:** `StateClient` (ETag long-polling client loop with 304 caching, cryptographic ingestion, and exponential backoff fail-static resilience), `TelemetryHook` (Zero-context OpenFeature `Hook` collecting strictly `(flag_key, variant, reason)` tuples with ring-buffer bulkhead protection and periodic sorted export), and `generateUlid` generator.
- **Tests:** 53 passing tests in `packages/sdk`.

### 1.5 PR 5 (`perf/sdk-microbenchmarks`): Hot-Path Microbenchmarks (`packages/sdk/benchmarks/`)

- **Delivered:**
  - Automated benchmark harness (`tinybench@6.2.2`) with hardware/runtime profiling.
  - Vitest benchmark suite (`benchmarks/hot-path.bench.ts`).
  - Unit-tested fixtures verifying fallback delegation, override matches, dual-clock math, and client resolutions (`benchmarks/benchmarks.test.ts`).
  - Continuous benchmark commands: `pnpm --filter @synapsestate/sdk run bench` and `pnpm --filter @synapsestate/sdk run bench:vitest`.
  - Published benchmark report in `docs/benchmarks/sdk-overhead.md`:
    - Fallback (cache miss) Map lookup takes 99.0 ns (±0.54%) in isolation (vs 77.4 ns (±0.50%) for raw `Map.get()`).
    - Direct provider fallback resolutions track closely with bare delegate (0.91x to 1.22x ratio), with fluctuations within normal sub-microsecond JIT/GC variance.
    - Active override matches resolve in 2.16 µs – 3.06 µs (bypassing underlying delegate evaluation).
    - Dual-clock expiry validation adds +749.4 ns inside `LeaseStore.getActiveLease()`, with isolated clock syscalls taking 284.8 ns (±0.51%) and expiry arithmetic taking 472.3 ns (±1.18%).
    - Full statistical profile with RME (±%) and exact p75/p99 percentiles documented.
- **Tests:** 62 passing tests in `packages/sdk` (10 test files).
- **Monorepo Baseline:** 178/178 passing tests across monorepo, 0 build errors, 0 typecheck errors, 0 lint warnings.

---

## 2. Next Ticket: Phase 2, PR 6 Scope & Deliverables

- **Target Branch:** `feat/control-api-scaffolding` (branch from `main`)
- **Target Package:** `apps/control-api`
- **PR Title:** `feat(api): Fastify/Postgres schema migrations, audit ledger, and health endpoints`

### Core Components to Implement

1. **PostgreSQL Relational Schema (`apps/control-api/src/db/schema.sql`):**
   - Tables per `docs/ARCHITECTURE.md` §7 and `docs/SpecDoc.md` §2.1:
     - `flags`: `(key VARCHAR(128), env VARCHAR(64), class VARCHAR(32), owner VARCHAR(128), description TEXT, registry_version BIGINT, created_at, updated_at, PRIMARY KEY (key, env))`.
     - `leases`: `(lease_id VARCHAR(32) PRIMARY KEY, flag_key VARCHAR(128), env VARCHAR(64), payload JSONB, sig TEXT, state VARCHAR(32), issued_at TIMESTAMPTZ, ttl_seconds INT, expires_at TIMESTAMPTZ, created_by_kid VARCHAR(128), promote_pr_url TEXT, created_at TIMESTAMPTZ)`. Partial unique index on `(flag_key, env)` where `state = 'ACTIVE'`.
     - `audit_pending` and `audit_ledger`: Tamper-evident hash-chained SHA-256 audit ledger (ARCHITECTURE §8, Invariant 7).
     - `key_revocations` and `revocations`: Deny-only revocation tables.
     - `telemetry_metrics`: Metrics aggregation tables.
2. **Database Migration Runner & Pool Setup (`apps/control-api/src/db/`):**
   - Pure TypeScript migration engine or pg client pool initialization.
   - Connection pool isolation (dedicated pools for leases vs telemetry load-shedding).
3. **Control API Service Framework (`apps/control-api/src/`):**
   - Fastify HTTP server setup.
   - Health probes: `GET /healthz` (liveness) and `GET /readyz` (readiness with PG ping).
   - Time synchronization endpoint: `GET /v1/time` returning `{ server_time: ISO8601 }` (ARCHITECTURE §4.2 Step 1).
4. **Automated Integration & Unit Tests (`apps/control-api/src/`):**
   - Health and time endpoint tests.
   - Schema validation and migration idempotency tests.

---

## 3. Verification Commands for PR 6

```bash
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm test
```
