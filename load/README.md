# SynapseState k6 Load Testing & Stress Harness

This directory contains the production-grade k6 load-testing suites and saturation benchmarks for **SynapseState Control API** and SDK state delivery mechanisms, delivering **Phase 3 PR 14 (`test/load-k6-benchmarks`)** as specified in [docs/ROADMAP.md §5 (3.3)](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) and [docs/ARCHITECTURE.md §10 & §11](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md).

---

## 1. Architectural Invariants Tested

The load harness explicitly stress-tests the core architectural invariants of SynapseState:

| Invariant                                                     | System Boundary                                      | Test Verification Mechanism                                                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Invariant 1: Fail-Safe Hot Path & Delegation**              | Application evaluation path                          | Validates that when Control API is driven into saturation or pool exhaustion, client SDKs continue evaluating cached state and fall back safely without application crashes.                                         |
| **Invariant 5: Zero-Context Telemetry & Bounded Cardinality** | Batch ingestion route (`POST /v1/telemetry/batches`) | Enforces that all telemetry batches sent across 100+ concurrent SDKs contain strictly `(flag_key, variant, reason)` tuples with integer counts. Strictly verifies no user IDs or targeting attributes are processed. |
| **SLO 1: Lease Propagation Lag**                              | State delivery route (`GET /v1/sdk/state?wait=30s`)  | Verifies that under 100 concurrent long-polling SDKs with active ETag caching, $p95$ lease propagation lag remains $\le 10\text{ s}$.                                                                                |
| **Bulkhead Isolation**                                        | Database pool allocation                             | Proves that telemetry flush saturation trips HTTP 429 load shedding on the dedicated `telemetryPool` bulkhead, leaving `leasePool` and state delivery unaffected.                                                    |

---

## 2. Directory Structure

```
load/
├── README.md                 # This operational and architectural guide
└── k6/
    ├── common.js             # Shared helpers, zero-context generator, and custom metrics
    ├── config.json           # Standardized execution profiles (smoke, average_load, stress, spike)
    ├── long-polling.js       # 100 concurrent SDK long-polling instances with ETag validation
    ├── telemetry.js          # High-throughput batch upsert ingestion harness
    └── mixed-stress.js       # Combined multi-scenario reader/writer stress test
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

2. **SynapseState Control API**: Running locally or on Kubernetes:
   ```bash
   # In terminal 1 (starts local Postgres + Control API)
   pnpm --filter @synapsestate/control-api run dev
   ```

---

## 4. Execution Commands

### 4.1 Long-Polling Load Test (`load/k6/long-polling.js`)

Simulates 100 concurrent client SDK instances long-polling `GET /v1/sdk/state?env=production&wait=30s`.

- Emulates client ETag caching via `If-None-Match`.
- Asserts HTTP 304 during quiet periods and immediate HTTP 200 on state mutations.
- Enforces SLO threshold: `synapse_lease_propagation_lag_ms <= 10000` ($p95 \le 10\text{ s}$).

```bash
# Standard 100 VU run (2 minutes)
k6 run load/k6/long-polling.js

# Custom concurrency, environment, and wait time
k6 run -e VUS=200 -e WAIT_TIME=15s -e SYNAPSE_ENV=staging load/k6/long-polling.js
```

### 4.2 High-Throughput Telemetry Ingestion Harness (`load/k6/telemetry.js`)

Simulates concurrent microservices flushing evaluation metrics batches via `POST /v1/telemetry/batches` (and alias `/v1/telemetry/flags`).

- Bounded payload: only canonical `(flag_key, variant, reason, count)` tuples.
- Measures batch upsert throughput and verifies graceful bulkhead 429 load shedding.

```bash
# Standard 20 VU flusher run
k6 run load/k6/telemetry.js

# Stress telemetry ingestion with 50 VUs targeting the alias route
k6 run -e VUS=50 -e TELEMETRY_PATH=/v1/telemetry/flags load/k6/telemetry.js
```

### 4.3 Mixed Traffic & Stress Scenarios (`load/k6/mixed-stress.js`)

Drives realistic mixed traffic consisting of concurrent state readers (long-pollers) and telemetry batch writers.

```bash
# Average production load profile (100 pollers + 20 telemetry flushers)
k6 run -e PROFILE=average_load load/k6/mixed-stress.js

# Smoke profile for fast CI validation (5 pollers + 2 flushers, 30s)
k6 run -e PROFILE=smoke load/k6/mixed-stress.js

# Stress profile ramping up to 250 pollers + 150 flushers
k6 run -e PROFILE=stress load/k6/mixed-stress.js

# Sudden traffic spike profile (surges from 10 to 300 VUs)
k6 run -e PROFILE=spike load/k6/mixed-stress.js
```

---

## 5. Metrics Catalog & SLO Assertions

The harness registers custom Prometheus-compatible k6 metrics:

| Metric Name                             | Type    | Description                                      | SLO / Acceptance Criteria            |
| --------------------------------------- | ------- | ------------------------------------------------ | ------------------------------------ |
| `synapse_lease_propagation_lag_ms`      | Trend   | Latency from server emission to client delivery  | $p95 \le 10\text{ s}$                |
| `synapse_long_poll_duration_ms`         | Trend   | Duration of long-polling HTTP requests           | $p95 \le 35\text{ s}$ (for 30s wait) |
| `synapse_long_poll_200_total`           | Counter | Count of HTTP 200 state delivery responses       | Monotonically increasing             |
| `synapse_long_poll_304_total`           | Counter | Count of HTTP 304 Not Modified responses         | Monotonically increasing             |
| `synapse_long_poll_error_rate`          | Rate    | Fraction of failed long-polling calls            | $< 0.01$ (< 1%)                      |
| `synapse_telemetry_batch_duration_ms`   | Trend   | Batch upsert database response latency           | $p95 \le 500\text{ ms}$              |
| `synapse_telemetry_success_total`       | Counter | Successfully ingested batches (HTTP 202)         | Monotonically increasing             |
| `synapse_telemetry_load_shed_429_total` | Counter | Shed batches due to bulkhead pool limits         | Expected under stress saturation     |
| `synapse_telemetry_error_rate`          | Rate    | Unhandled telemetry failure rate (excluding 429) | $< 0.05$ (< 5%)                      |
| `http_req_failed`                       | Rate    | k6 standard failed request metric                | $< 0.05$ (< 5%)                      |

---

## 6. Documented Saturation Limits & Capacity Planning

For the formal capacity analysis, observed saturation curves, and hardware verification report, refer to:
[docs/benchmarks/load-test-report.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/benchmarks/load-test-report.md).
