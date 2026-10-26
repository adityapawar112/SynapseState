# SynapseState k6 Load Testing & Stress Harness

This directory contains the production-grade k6 load-testing suites and saturation benchmarks for **SynapseState Control API** and SDK state delivery mechanisms, delivering **Phase 3 PR 14 (`test/load-k6-benchmarks`)** as specified in [docs/ROADMAP.md §5 (3.3)](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) and [docs/ARCHITECTURE.md §10 & §11](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md).

---

## 1. Architectural Invariants Tested

The load harness explicitly stress-tests the core architectural invariants of SynapseState:

| Invariant                                                     | System Boundary                                      | Test Verification Mechanism                                                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Invariant 1: Fail-Safe Hot Path & Delegation**              | Application evaluation path                          | Validates that when Control API is driven into saturation or pool exhaustion, client SDKs continue evaluating cached state and fall back safely without application crashes.                                         |
| **Invariant 5: Zero-Context Telemetry & Bounded Cardinality** | Batch ingestion route (`POST /v1/telemetry/batches`) | Enforces that all telemetry batches sent across 100+ concurrent SDKs contain strictly `(flag_key, variant, reason)` tuples with integer counts. Strictly verifies no user IDs or targeting attributes are processed. |
| **SLO 1: Lease Propagation Lag**                              | State delivery route (`GET /v1/sdk/state?wait=30s`)  | Verifies that under 100 concurrent long-polling SDKs with active ETag caching, p95 lease propagation lag remains ≤ 10 s measured strictly via server timestamps (`server_time - issued_at`).                         |
| **Bulkhead Isolation**                                        | Database pool allocation                             | Proves that telemetry flush saturation trips HTTP 429 load shedding on the dedicated `telemetryPool` bulkhead, leaving `leasePool` and state delivery unaffected.                                                    |

---

## 2. Directory Structure

```
load/
├── README.md                 # This operational and architectural guide
├── tsconfig.json             # TypeScript configuration for mock server compilation
└── k6/
    ├── common.js             # Shared helpers, zero-context generator, custom metrics & summary export
    ├── config.json           # Standardized execution profiles (smoke, average_load, stress, spike, soak)
    ├── long-polling.js       # 100 concurrent SDK long-polling instances with ETag validation & live mutations
    ├── telemetry.js          # High-throughput batch upsert ingestion harness (configurable BATCH_SIZE)
    ├── mixed-stress.js       # Combined multi-scenario reader/writer stress test (supports DURATION scaling)
    ├── story-arc.js          # Standardized 4-phase operational story arc traffic orchestration
    └── mock-server.ts        # Zero-dependency pure Node.js mock Control API with /metrics & revocation support
```

---

## 3. Prerequisites & Tooling

1. **k6**: Version 0.45.0 or later installed on the system:

   ```bash
   # Windows (winget or scoop)
   winget install GrafanaLabs.k6
   # macOS (Homebrew)
   brew install k6
   # Linux (APT)
   sudo apt-get install k6
   ```

2. **SynapseState Control API** (or Mock Server):
   ```bash
   # Option A: Start production Control API (requires PostgreSQL)
   pnpm --filter @synapsestate/control-api run dev

   # Option B: Start standalone zero-dependency Mock Control API
   pnpm exec tsx load/k6/mock-server.ts
   # or
   pnpm run test:load:mock
   ```

---

## 4. Execution Commands

### 4.1 Long-Polling Load Test (`load/k6/long-polling.js`)

Simulates concurrent client SDK instances long-polling `GET /v1/sdk/state?env=production&wait=30s`.

- Emulates client ETag caching via `If-None-Match`.
- Asserts HTTP 304 during quiet periods and immediate HTTP 200 on state mutations.
- Enforces SLO threshold: `synapse_lease_propagation_lag_ms <= 10000` (p95 ≤ 10 s).
- Supports optional live break-glass lease mutations via `-e INJECT_MUTATIONS=true`.

```bash
# Standard 100 VU run (2 minutes)
k6 run load/k6/long-polling.js

# Custom concurrency, environment, wait time, and live mutation injection
k6 run -e VUS=200 -e WAIT_TIME=15s -e SYNAPSE_ENV=staging -e INJECT_MUTATIONS=true load/k6/long-polling.js
```

### 4.2 High-Throughput Telemetry Ingestion Harness (`load/k6/telemetry.js`)

Simulates concurrent microservices flushing evaluation metrics batches via `POST /v1/telemetry/batches`.

- Bounded payload: only canonical `(flag_key, variant, reason, count)` tuples adhering strictly to Invariant 5.
- Measures batch upsert throughput and verifies graceful bulkhead 429 load shedding.
- Target endpoint configurable via `TELEMETRY_PATH` (defaults to `/v1/telemetry/batches`).
- Batch size configurable via `BATCH_SIZE` (defaults to 4; supports 50+ for saturation).

```bash
# Standard 20 VU flusher run
k6 run load/k6/telemetry.js

# Stress telemetry ingestion with 50 VUs and 50 metrics per batch (>5,000 evals/s)
k6 run -e VUS=50 -e DURATION=1m -e BATCH_SIZE=50 load/k6/telemetry.js
```

### 4.3 Mixed Traffic & Stress Scenarios (`load/k6/mixed-stress.js`)

Drives realistic mixed traffic consisting of concurrent state readers (long-pollers), telemetry batch writers, and periodic lease mutators.

```bash
# Average production load profile (100 pollers + 20 telemetry flushers + 1 mutator)
k6 run -e PROFILE=average_load load/k6/mixed-stress.js

# Smoke profile for fast CI validation (5 pollers + 2 flushers + 1 mutator, 30s)
k6 run -e PROFILE=smoke load/k6/mixed-stress.js

# Stress profile ramping up to 250 pollers + 150 flushers
k6 run -e PROFILE=stress load/k6/mixed-stress.js

# 10-Minute Sustained Soak Benchmark (validates Node.js RSS memory stability)
k6 run -e PROFILE=soak load/k6/mixed-stress.js
# or with stress profile scaled to 10 minutes:
k6 run -e PROFILE=stress -e DURATION=10m load/k6/mixed-stress.js

# Sudden traffic spike profile (surges from 10 to 300 VUs)
k6 run -e PROFILE=spike load/k6/mixed-stress.js
```

### 4.4 Standardized 4-Phase Story Arc Traffic Orchestration (`load/k6/story-arc.js`)

Orchestrates a complete operational incident lifecycle across 4 distinct phases:

1. **Phase 1: Steady-State Baseline**: 100 concurrent SDKs long-polling with ETag caching (95%+ HTTP 304 quiet responses, 0 active leases).
2. **Phase 2: 2 AM Incident Break-Glass Override**: SRE signs emergency lease (`checkout-v2-flow` = `true`). Control API broadcasts invalidation; SDKs wake up and ingest within <500ms (p95 ≤ 10 s SLO).
3. **Phase 3: Bulkhead Saturation & Load-Shedding**: High-volume telemetry batch flushes (5,000+ evals/sec). Proves Invariant 1 bulkhead isolation: `telemetryPool` sheds load with HTTP 429 while `leasePool` state delivery remains 100% available with 0 drops.
4. **Phase 4: Graceful Expiry & Revocation**: Lease is revoked via `POST /v1/leases/:id/revoke`. Active override count returns to 0; fleet returns to quiet 304 baseline.

```bash
# Standard 2m30s story arc run
pnpm run test:load:story-arc
# or
k6 run load/k6/story-arc.js

# Fast smoke run for CI or local smoke testing
k6 run -e DURATION=30s -e VUS=20 -e TELEMETRY_VUS=20 -e WAIT_TIME=5s load/k6/story-arc.js
```

---

## 5. Metrics Catalog & SLO Assertions

The harness registers custom Prometheus-compatible k6 metrics:

| Metric Name                                        | Type    | Description                                       | SLO / Acceptance Criteria           |
| -------------------------------------------------- | ------- | ------------------------------------------------- | ----------------------------------- |
| `synapse_lease_propagation_lag_ms`                 | Trend   | Latency from server emission to client delivery   | p95 ≤ 10 s                          |
| `synapse_invalidation_wakeup_ms`                   | Trend   | Measured invalidation wakeup lag on lease change  | ≤ 100 ms (target)                   |
| `synapse_long_poll_duration_ms`                    | Trend   | Duration of long-polling HTTP requests            | p95 ≤ 32 s (for 30s wait)           |
| `synapse_long_poll_200_total`                      | Counter | Count of HTTP 200 state delivery responses        | Monotonically increasing            |
| `synapse_long_poll_304_total`                      | Counter | Count of HTTP 304 Not Modified responses          | Monotonically increasing            |
| `synapse_long_poll_error_rate`                     | Rate    | Fraction of failed long-polling calls             | < 0.01 (< 1%)                       |
| `synapse_telemetry_batch_duration_ms`              | Trend   | Batch upsert database response latency            | p95 ≤ 500 ms                        |
| `synapse_telemetry_success_total`                  | Counter | Successfully ingested batches (HTTP 202)          | Monotonically increasing            |
| `synapse_telemetry_load_shed_429_total`            | Counter | Shed batches due to bulkhead pool limits          | Expected under stress saturation    |
| `synapse_telemetry_error_rate`                     | Rate    | Unhandled telemetry failure rate (excluding 429)  | < 0.05 (< 5%)                       |
| `synapse_bulkhead_isolation_violations`            | Counter | State poll failures during telemetry 429 shedding | **0** (strictly 0)                  |
| `synapse_bulkhead_state_deliveries_under_shedding` | Counter | Successful state polls during telemetry shedding  | Monotonically increasing under load |
| `http_req_failed`                                  | Rate    | k6 standard failed request metric                 | < 0.05 (< 5%)                       |

---

## 6. Documented Saturation Limits & Capacity Planning

For the formal capacity analysis, observed saturation curves, and hardware verification report, refer to:
[docs/benchmarks/load-test-report.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/benchmarks/load-test-report.md).
