# SynapseState Handoff: Phase 3 PR 12 (`feat/metrics-control-api-sdk`) Completion

> **Target Session:** PR 12 Implementation Complete & PR 13 Onboarding (`obs/dashboards-and-alerts`)  
> **Repository:** `synapsestate/synapsestate`  
> **Current Branch:** `feat/metrics-control-api-sdk` (ready to merge to `main`)  
> **Next Target Branch:** `feat/dashboards-and-alerts` (PR 13)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1 & 5)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§11.1 Prometheus Metrics, §11.2 Alert Rules, §11.3 SLO Linkage)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 3, PRs 12–14)  

---

## 1. Executive Summary: PR 12 Deliverables

PR 12 delivers the core Prometheus metrics subsystem across the Control API (`apps/control-api`) and the pluggable vendor-neutral metrics callback seam in the Node.js SDK (`@synapsestate/sdk`).

### Implementation Highlights:
1. **Control API Prometheus Metrics (`apps/control-api/src/metrics/*`):**
   - Implemented standard Prometheus metrics registry using `prom-client`:
     - `synapse_leases_active{env}`: Gauge tracking currently active, unexpired emergency leases.
     - `synapse_lease_transitions_total{from, to}`: Counter tracking state transitions (`active -> revoked`, `staged -> sealed`, etc.).
     - `synapse_lease_propagation_seconds`: Histogram measuring lease propagation latency from creation to SDK ingestion via telemetry feedback.
     - `synapse_state_poll_duration_seconds{status_code}`: Histogram tracking HTTP latency of long-polling and conditional requests (`/v1/sdk/state`).
     - `synapse_audit_pending_queue_size`: Gauge reporting the depth of unsealed records in `audit_pending`.
     - `synapse_audit_pending_age_seconds`: Gauge measuring the age in seconds of the oldest unsealed record in `audit_pending`.
     - `synapse_audit_chain_length`: Gauge tracking total sealed records in `audit_events`.
   - Exposed endpoint `GET /metrics` in `apps/control-api/src/routes/metrics.ts` with on-scrape asynchronous gauge synchronization against PostgreSQL.
   - Verified **Cardinality Audit**: Strict prohibition on high-cardinality labels (no lease IDs, user IDs, or flag keys in Prometheus labels; strictly bounded dimensions: `env`, `status_code`, `reason`, `from`, `to`).

2. **SDK Vendor-Neutral Pluggable Metrics (`packages/sdk/src/metrics.ts`):**
   - Defined `SynapseSdkMetrics` callback interface:
     - `onStateAge(seconds: number)`
     - `onKeysetAge(seconds: number)`
     - `onActiveOverrides(count: number)`
     - `onPollError(labels?: { reason?: string })`
     - `onTelemetryDropped(count: number)`
   - Built `InMemoryMetricsCollector` and factory `createInMemoryMetricsCollector()` for testing and local aggregation.
   - Enforced **Invariant 1 (Fail-Safe Hot Path)**: All metric invocations are wrapped inside `safeInvokeMetricCallback()`. If a consumer's metrics reporter throws, it is caught safely without affecting flag evaluation or SDK execution.
   - Plumbed metrics throughout SDK components: `OverrideProvider`, `LeaseStore`, `KeysetWatcher`, `StateClient`, and `TelemetryHook`.

---

## 2. Quality Gates & Verification Evidence

All monorepo quality gates have passed with zero warnings or errors:

```bash
# 1. Monorepo ESLint
pnpm run lint
# Exit Code: 0 (Clean)

# 2. TypeScript Compilation (7/7 workspace projects)
pnpm -r run build
# Exit Code: 0 (Clean)

# 3. TypeScript Typecheck (7/7 workspace projects)
pnpm -r run typecheck
# Exit Code: 0 (Clean)

# 4. Monorepo Test Suites (36 files, 280 passed)
pnpm -r run test
# - packages/lease: 6 test files, 91 passed
# - packages/sdk: 11 test files, 73 passed
# - packages/cli: 1 test file, 1 passed
# - packages/conformance: 3 test files, 22 passed
# - apps/control-api: 13 test files, 91 passed
# - apps/purger: 1 test file, 1 passed
# - apps/demo-shop: 1 test file, 1 passed
# Total: 36 test files, 280 tests passed!
```

---

## 3. Code Review Follow-Up Hardening (PR 12 Review Feedback)

In response to formal code review feedback, the following robustness enhancements were added:
1. **Defensive Keyset Lifecycle Containment:** Wrapped `KeysetWatcher.onKeysetUpdate` in `try/catch + logger.warn` to ensure subscriber exceptions never cause the watcher to erroneously transition to `stale` or `unreadable`.
2. **Scrape Query Optimization & Throttle:** Added `REFRESH_THROTTLE_MS = 5000` guard in `GET /metrics` and parallelized database gauge queries with `Promise.all` to mitigate connection pool contention during scrape bursts.
3. **Unified Audit Sealer Gauge Ownership:** Injected `SynapseMetrics` into `AuditSealer`, removing duplicate gauge creation and preventing dual-registry divergence.
4. **Sentinel Contract Clarity:** Formally documented and enforced `-1` cold-start sentinel behavior in `InMemoryMetricsCollector.onKeysetAge`.
5. **Fail-Open & Invariant 1 Regression Tests:** Added tests verifying `GET /metrics` fails open (HTTP 200 + warning) on Postgres connection drop, and `OverrideProvider` evaluation proceeds safely without interruption when a consumer's metrics collector throws.

---

## 3. Phase 3 Next Step: PR 13 (`obs/dashboards-and-alerts`)

The next deliverable in Phase 3 is PR 13:
1. **Grafana Dashboards (`deploy/helm/dashboards/`):**
   - SRE Operations Dashboard displaying active leases, expiration countdowns, lease propagation latency ($p50, p95, p99$), audit backlog depth, and SDK poll error rates.
2. **Prometheus Alertmanager Rules (`deploy/helm/alerts/`):**
   - Multi-window multi-burn-rate alerts (Google SRE book standard: $14.4\times$ 1h/6h, $6\times$ 6h/3d) for State API error budget burn.
   - `SynapseAuditSealerLagging`: Alert if `synapse_audit_pending_age_seconds > 30` for $> 2\text{m}$.
   - `SynapseLeasePropagationDegraded`: Alert if $p95$ of `synapse_lease_propagation_seconds > 10\text{s}$ for $> 5\text{m}$.
   - `SynapseStateStale`: Alert if `synapse_sdk_state_age_seconds > 60` across SDK instances.
