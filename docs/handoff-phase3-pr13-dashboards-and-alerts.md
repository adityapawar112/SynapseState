# SynapseState Handoff: Phase 3 PR 13 (`obs/dashboards-and-alerts`) Onboarding

> **Target Session:** Implement Phase 3 PR 13 (`obs/dashboards-and-alerts`)  
> **Repository:** `synapsestate/synapsestate`  
> **Previous Branch:** `feat/metrics-control-api-sdk` (PR 12 complete, hardened, and verified)  
> **Next Target Branch:** `feat/dashboards-and-alerts` (PR 13)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1 & 5)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§11 Observability, §11.1 Metrics Catalog, §11.2 SLOs & Alert Rules)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 3, PRs 12–14)  
> - Limitations & Failure Modes: [docs/limitations.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/limitations.md)  

---

## 1. Executive Summary & Monorepo State

PR 12 (`feat/metrics-control-api-sdk`) is **100% complete, peer-reviewed, and verified**.
- Prometheus metrics are fully exposed via `GET /metrics` on the Control API (`apps/control-api/src/metrics/*`).
- Pluggable vendor-neutral metrics callback interface is wired into the SDK (`packages/sdk/src/metrics.ts`).
- Code review items have been resolved:
  - Keyset lifecycle callback isolation in `KeysetWatcher.onKeysetUpdate` (defensive try/catch).
  - DB gauge query parallelization with `Promise.all` and 5s cache throttle (`REFRESH_THROTTLE_MS = 5000`).
  - Unified `AuditSealer` gauge ownership with `SynapseMetrics` injection.
  - Fail-open database outage and throwing-collector hot-path regression tests passing.
- **Monorepo Gates:** 36 test files, 280 tests passed, 0 lint warnings, clean build & typecheck across all 7 projects.

---

## 2. Phase 3 PR 13 Scope & Deliverables

PR 13 delivers production-grade Grafana dashboards and Prometheus Alertmanager rules as defined in [docs/ROADMAP.md §5](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) and [docs/ARCHITECTURE.md §11](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md):

### 1. Operations Grafana Dashboard (`deploy/helm/dashboards/synapsestate-operations.json`)
Create an SRE operations dashboard with the following panel hierarchy:
- **Active Incident & Overrides Overview:**
  - Stat / Gauge: `synapse_leases_active{env}` — currently active break-glass leases per environment.
  - Timeseries: `sum by (from, to) (rate(synapse_lease_transitions_total[5m]))` — transition rates.
  - Table: Active lease breakdown with TTL countdown / expiration visualization.
- **SLO & Latency Performance:**
  - Timeseries: Histogram quantiles of lease propagation latency ($p50, p95, p99$ via `histogram_quantile(..., sum(rate(synapse_lease_propagation_seconds_bucket[5m])) by (le))`). Target SLO: $p95 \le 10\text{s}$.
  - Timeseries: State poll duration by status code (`sum by (status_code) (rate(synapse_state_poll_duration_seconds_count[5m]))`).
- **Audit Ledger Health:**
  - Gauge / Timeseries: `synapse_audit_pending_queue_size` (depth of unsealed events).
  - Gauge / Alert: `synapse_audit_pending_age_seconds` (age of oldest unsealed event, threshold 30s).
  - Monotonic counter: `synapse_audit_chain_length` (ledger height).
- **Client SDK Fleet Health:**
  - Timeseries: `max(synapse_sdk_state_age_seconds)` & `max(synapse_sdk_keyset_age_seconds)`.
  - Timeseries: `sum(rate(synapse_sdk_poll_errors_total[5m]))`.
  - Timeseries: `sum(rate(synapse_sdk_telemetry_dropped_total[5m]))`.

### 2. Multi-Window Multi-Burn-Rate Alert Rules (`deploy/helm/alerts/synapsestate-rules.yaml`)
Implement Google SRE Workbook standard multi-window multi-burn-rate alerts:
- **State API Availability SLO (99.5% over 30 days):**
  - **Fast Burn (14.4x rate, consumes 2% error budget in 1 hour):**
    - Short window: 5m, Long window: 1h.
    - Severity: `critical` (PagerDuty / immediate response).
  - **Slow Burn (6x rate, consumes 5% error budget in 6 hours):**
    - Short window: 30m, Long window: 6h.
    - Severity: `warning` (ticket / business hours response).
- **Propagation Lag Degradation:**
  - `SynapseLeasePropagationDegraded`: Fired when $p95$ of `synapse_lease_propagation_seconds > 10\text{s}$ for $> 5\text{m}$.
- **Audit Sealer Stalled:**
  - `SynapseAuditSealerLagging`: Fired when `synapse_audit_pending_age_seconds > 30` for $> 2\text{m}$.
- **SDK Fleet Staleness:**
  - `SynapseStateStale`: Alert if `synapse_sdk_state_age_seconds > 60` for $> 5\text{m}$.
  - `SynapseKeysetStale`: Alert if `synapse_sdk_keyset_age_seconds > 900` (15 minutes).

### 3. Helm Integration (`deploy/helm/control-api/`)
- Wire dashboards and alerts into Helm templates as ConfigMaps or PrometheusRule CRDs (conditionally enabled via `values.yaml`).

---

## 3. Review Checkpoints & Invariants for PR 13

1. **Metric Cardinality Audit (Invariant 5):**
   - Ensure all dashboard queries and alert rules only aggregate bounded labels (`env`, `status_code`, `reason`, `from`, `to`).
   - Strictly zero references to user IDs, context attributes, or lease IDs.
2. **Multi-Window Multi-Burn-Rate Mathematical Correctness:**
   - Verify burn-rate formulas against 99.5% error budget ($0.5\%$ budget):
     - Fast burn: $\text{rate}_{1\text{h}} > 14.4 \times 0.005 = 0.072$ AND $\text{rate}_{5\text{m}} > 0.072$.
     - Slow burn: $\text{rate}_{6\text{h}} > 6 \times 0.005 = 0.030$ AND $\text{rate}_{30\text{m}} > 0.030$.

---

## 4. Suggested Skills for Next Agent

The next agent should call the `Skill` tool for:
- `test-driven-development`: Write YAML / JSON linting and rule validation tests for Alertmanager and Grafana definitions.
- `verification-before-completion`: Run all repository gates (`pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm -r run test`, `helm lint`) before claiming completion.
- `codebase-design`: Keep Helm alert and dashboard templates cleanly separated and modular.

---

## 5. Verification Commands

```bash
# Monorepo Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm -r run test

# Helm Lint
helm lint deploy/helm/control-api
helm lint deploy/helm/demo-shop
```
