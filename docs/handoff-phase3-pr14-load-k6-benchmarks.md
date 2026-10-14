# SynapseState Handoff: Phase 3 PR 14 (`test/load-k6-benchmarks`) Onboarding

> **Target Session:** Implement Phase 3 PR 14 (`test/load-k6-benchmarks`)  
> **Repository:** `synapsestate/synapsestate`  
> **Previous Branch:** `feat/dashboards-and-alerts` (PR 13 complete, peer-reviewed, hardened, and verified with all I1–I5 and M1–M5 review blockers resolved)  
> **Next Target Branch:** `feat/load-k6-benchmarks` (PR 14)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1 & 5)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§11 Observability, §11.1 Metrics Catalog, §11.2 SLOs & Alert Rules, §10 Reliability)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 3, PRs 12–14)  
> - Limitations & Failure Modes: [docs/limitations.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/limitations.md)  

---

## 1. Executive Summary & Monorepo State

PR 13 (`feat/dashboards-and-alerts`) is **100% complete, peer-reviewed, and verified**.
All review blockers have been remediated:
1. **Chart Drift Guard:** Automated test in `packages/conformance/src/observability.test.ts` asserts byte-identical synchronization between `deploy/helm/dashboards/` and `deploy/helm/control-api/dashboards/`, as well as `deploy/helm/alerts/` and `deploy/helm/control-api/alerts/`.
2. **Cardinality & TTL Documentation:** Clarified that per-lease TTL countdown is intentionally omitted from Prometheus metrics to strictly preserve Invariant 5 (bounded cardinality without `lease_id` series), directing operators to `synapse lease list`.
3. **Dual Y-Axis State Poll Query:** Configured panel id:7 with Target A (request rate req/s) and Target B ($p95$ duration s) with right-hand Y-axis overrides.
4. **Alertmanager Hygiene & Flapping Guards:** Upgraded `SynapseActiveEmergencyLeases` to `severity: warning` and added traffic floor guards (`> 0.03 req/s`) to multi-burn rate alerts to prevent false positives during 304 long-poll quiet periods.
5. **Operational Runbooks:** Created in-tree runbooks for all 4 alerted failure modes in `docs/runbooks/` (`state-api-outage.md`, `propagation-latency.md`, `audit-sealer-lag.md`, `sdk-staleness.md`).
6. **Monorepo Gates Passing:** ESLint clean (0 warnings), `tsc` typecheck clean across all 7 projects, `helm lint` passing 0 errors on both charts, and 100% unit/conformance tests passing.

---

## 2. Phase 3 PR 14 Scope & Deliverables

PR 14 completes Phase 3 by delivering the **k6 load-testing harness and documented saturation limits** as defined in [docs/ROADMAP.md §5 (3.3)](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md):

### 1. k6 Long-Polling Load Test Harness (`load/k6/long-polling.js`)
- Simulate **100 concurrent client SDK instances** long-polling `GET /v1/sdk/state?env=production&wait=30s`.
- Implement ETag caching: simulate client maintaining active ETag, expecting HTTP 304 on quiet periods and immediate HTTP 200 (< 100ms) on state mutations.
- Measure propagation lag distribution ($p50, p95, p99$) under concurrent lease ingestion/revocation.
- Verify SLO target: **Lease Propagation Lag $p95 \le 10\text{ s}$** and **0% request drop / unhandled exceptions**.

### 2. High-Throughput Telemetry Ingestion Harness (`load/k6/telemetry.js`)
- Simulate concurrent SDK clients flushing evaluation metrics batches via `POST /v1/telemetry/flags`.
- Generate realistic tuples strictly bounded by Invariant 5: `(flag_key, variant, reason)` tuples with aggregated integer counts.
- Benchmark database ingestion rate and verify audit queue depth (`synapse_audit_pending_queue_size`) remains bounded.

### 3. Mixed Traffic & Stress Scenarios (`load/k6/mixed-stress.js` & `load/k6/config.json`)
- Combined scenario driving concurrent long-polling readers and telemetry writers.
- Measure Control API resource consumption (CPU, memory, event loop latency, and PostgreSQL connection pool utilization).
- Establish ramp-up profiles (smoke, average load, stress, and spike).

### 4. Saturation Analysis & Documented Limits Report (`docs/benchmarks/load-test-report.md` or `load/README.md`)
- Identify first saturation bottleneck (e.g., PostgreSQL connection pool exhaustion, Fastify async suspension memory, or event loop lag).
- Publish documented hardware specs, execution methodology, observed saturation curves, and recommended operator capacity limits.

---

## 3. Architectural Invariants to Uphold in PR 14

1. **Invariant 1 (Fail-Safe Hot Path & Fallback):**
   - Ensure the k6 scenarios verify that client SDKs continue serving evaluations fail-open even when the Control API is driven to saturation or transient 5xx timeouts.
2. **Invariant 5 (Zero-Context Telemetry & Bounded Cardinality):**
   - Telemetry load payloads must never inject dynamic user IDs, targeting attributes, or high-cardinality keys. Only realistic feature flag names, variants, and evaluation reasons (`DEFAULT`, `TARGETING_MATCH`, `OVERRIDE`).
3. **No Unsubstantiated Claims:**
   - Adhere strictly to AGENTS.md §1 & §6: "No microbenchmark theater." All published throughput numbers and latency limits must include hardware specs, concurrent VUs, test duration, and raw log evidence.

---

## 4. Suggested Skills for Next Agent

The next agent should call the `Skill` tool for:
- `test-driven-development`: Structure clean k6 test suites, modular threshold configs, and automated verification scripts.
- `verification-before-completion`: Run all repository gates (`pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm -r run test`, `helm lint`) before claiming PR completion.
- `codebase-design`: Keep `load/` scripts clean, sharing common helpers (payload generators, header helpers, URL builders) in `load/k6/common.js`.

---

## 5. Verification Commands

```bash
# Monorepo Quality Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm run test
helm lint deploy/helm/control-api
helm lint deploy/helm/demo-shop

# Load Testing Verification (when Control API & Postgres are running)
k6 run load/k6/long-polling.js
k6 run load/k6/telemetry.js
k6 run load/k6/mixed-stress.js
```
