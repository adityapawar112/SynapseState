# SynapseState Handoff: Phase 2 Security & Best Practice Checkpoint & Phase 3 Onboarding

> **Target Session:** Review Phase 2 Security & Best Practice Checkpoints and initialize Phase 3 (`obs/metrics-control-api-sdk`, PR 12)  
> **Repository:** `synapsestate/synapsestate`  
> **Current Branch:** `infra/terraform-k3s-helm` (ready to merge to `main`)  
> **Next Target Branch:** `feat/metrics-control-api-sdk` (PR 12)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§8 Audit Ledger, §11 Observability, §12 IaC & Topology, §13 Architectural Decisions)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 2 Audit, Phase 3 PRs 12–14)  
> - Limitations & Failure Modes: [docs/limitations.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/limitations.md)  

---

## 1. Executive Summary & Monorepo State (Halfway Milestone)

Phase 2 (Deployment & Infrastructure as Code) is **100% complete**. All 11 foundational pull requests across Phase 1 and Phase 2 have been implemented, hardened, and verified against monorepo quality gates.

### Delivery Milestone Status:
- **Phase 1 (Foundation, Crypto Leases & Conformance):**
  - PR 1 (`feat/lease-crypto-schemas`): RFC 8785 canonicalization, Ed25519 signing/verification, dual-clock expiry.
  - PR 2 (`feat/conformance-golden-vectors`): Language-neutral test vectors and golden runner.
  - PR 3 (`feat/sdk-override-provider`): OpenFeature `OverrideProvider`, in-memory store, keyset watcher, emergency scanner.
  - PR 4 (`feat/sdk-long-poll-telemetry`): ETag long-polling client, zero-context `TelemetryHook`.
  - PR 5 (`perf/sdk-microbenchmarks`): Microbenchmarks measuring delegate vs override wrapper overhead.
- **Phase 2 (Control API & Infrastructure as Code):**
  - PR 6 (`feat/control-api-db-schema`): PostgreSQL migrations, connection pool isolation (`leasePool` vs `telemetryPool`).
  - PR 7 (`feat/control-api-state-delivery`): Server time sync, lease ingestion, ETag long-polling state endpoint.
  - PR 8 (`feat/control-api-audit-sealer`): In-process asynchronous audit sealer with `pg_try_advisory_xact_lock`.
  - PR 9 (`feat/control-api-telemetry-changes`): Bulkhead telemetry batch ingestion and change-event feed.
  - PR 10 (`infra/docker-packaging`): Multi-stage distroless containerization (`Dockerfile.control-api`, `Dockerfile.demo-shop`), GHCR Trivy scanning.
  - PR 11 (`infra/terraform-k3s-helm`): Terraform VM provisioning on k3s, fail-closed firewall, IMDSv2, S3 Object Lock, modular Helm charts (`control-api`, `demo-shop`), and `make teardown`.

---

## 2. Phase 2 Security & Best Practice Checkpoint Audit

The four formal review checkpoints specified in [docs/ROADMAP.md §5](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) have been audited:

| Review Checkpoint | Target Requirement | Audit Evidence & Implementation Detail | Status |
|---|---|---|---|
| **1. SQL Injection & Connection Safety** | Parameterized queries only (`pg`); separate pool instances for high-priority lease ingestion vs. low-priority telemetry flushes to prevent starvation. | Audited all SQL statements across `apps/control-api/src/db/*` and `apps/control-api/src/routes/*`. All queries strictly use parameterized `$1, $2` inputs. `leasePool` (max 20 connections, 5s timeout) is isolated from `telemetryPool` (max 5 connections, 2s timeout, shedding with 429/503), guaranteeing telemetry bursts cannot starve emergency lease operations. | **VERIFIED** |
| **2. Concurrency & Advisory Lock Safety** | Transaction-scoped advisory locking via `pg_try_advisory_xact_lock(hashtext('synapse_audit_sealer'))` per batch; safe across PgBouncer in transaction pooling mode. | Verified in `apps/control-api/src/sealer/sealer.ts`. Lock is acquired exclusively inside `withTransaction()` via `pg_try_advisory_xact_lock`. The lock releases automatically upon commit/rollback, preventing lock leaks across pooled connections or PgBouncer recycling. | **VERIFIED** |
| **3. Container & Pod Hardening** | Enforce read-only root filesystems, non-root user (`USER 65532`), dropped capabilities (`ALL`), and `allowPrivilegeEscalation: false` in Helm templates. | Enforced in `deploy/helm/control-api/values.yaml` and `deploy/helm/demo-shop/values.yaml`: `runAsUser: 65532`, `runAsGroup: 65532`, `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities: { drop: ["ALL"] }`, `seccompProfile: { type: RuntimeDefault }`, and `/tmp` mounted to `emptyDir: {}`. | **VERIFIED** |
| **4. Secret Management & Trust Root Separation** | Database credentials and signing keys injected via Kubernetes Secrets; zero cleartext credentials in Git; trust roots decoupled from Helm. | Zero cleartext secrets in Git. `DATABASE_URL` and `CHECKPOINT_SIGNING_KEY` injected exclusively via Kubernetes Secrets (`secretKeyRef`). Pinned Keyset (`synapse-keyset`) and emergency leases volumes are decoupled from Helm templates, mounted read-only, and managed out-of-band via GitOps (ARCH §3.1, Invariant 2). S3 Object Lock enforces `COMPLIANCE` retention with write-only IAM policy. | **VERIFIED** |

---

## 3. Definition of Done Audit (Phase 2 Gate)

- [x] **Monorepo Green:** ESLint clean, TypeScript build clean (7/7 projects), typecheck clean (7/7 projects), unit tests passing across all packages.
- [x] **Container Packaging:** Distroless Node 22 images published via GHCR with Trivy vulnerability scanning (`.github/workflows/docker.yml`).
- [x] **Single-Node VM:** Pinned k3s `v1.30.5+k3s1` on Ubuntu 22.04 LTS via Terraform with IMDSv2, fail-closed firewall rules, and S3 Object Lock in COMPLIANCE mode.
- [x] **Automated Cost Teardown:** `make teardown` target in root [Makefile](file:///c:/Users/adity/Desktop/Projects/SynapseState/Makefile) running `terraform destroy -auto-approve`.
- [x] **Helm Quality Gate:** `helm lint` and `helm template` validated in CI (`.github/workflows/infra.yml`).

---

## 4. Phase 3 Scope & Onboarding (Observability, Metrics & SLO Verification)

The upcoming session begins **Phase 3 (Weeks 5 – 6)** of the SynapseState roadmap:

### Upcoming Deliverables:
1. **PR 12 (`feat/metrics-control-api-sdk`):**
   - **Control API Metrics (`apps/control-api/src/metrics/*`):**
     - `synapse_leases_active{env}`: Number of currently active break-glass leases.
     - `synapse_lease_transitions_total{from, to}`: State transition counter.
     - `synapse_lease_propagation_seconds`: Histogram of propagation latency.
     - `synapse_state_poll_duration_seconds`: Histogram of `/v1/sdk/state` request latency.
     - `synapse_audit_pending_queue_size`: Depth of unsealed events in `audit_pending`.
     - `synapse_audit_pending_age_seconds`: Age of the oldest unsealed event in `audit_pending` (alerts if > 30s).
     - `synapse_audit_chain_length`: Monotonic counter of sealed audit events.
     - Route: `GET /metrics` returning Prometheus format via `prom-client`.
   - **SDK Metrics Callbacks (`packages/sdk/src/metrics.ts`):**
     - Pluggable metrics interface exporting: `synapse_sdk_state_age_seconds`, `synapse_sdk_keyset_age_seconds`, `synapse_sdk_active_overrides`, `synapse_sdk_poll_errors_total`, `synapse_sdk_telemetry_dropped_total`.
   - *Security Checkpoint:* Cardinality audit — ensure **no high-cardinality labels** (user IDs, context keys, lease IDs) are exposed in metrics. Only bounded dimensions (`env`, `status_code`, `reason`).

2. **PR 13 (`obs/dashboards-and-alerts`):**
   - Operations Grafana dashboard tracking active leases, countdown timers, and propagation lag.
   - Alertmanager multi-window multi-burn-rate alert rules (Google SRE standard: 14.4× 1h/6h, 6× 6h/3d) for state availability and propagation lag without flapping.
   - Files: `deploy/helm/dashboards/*`, `deploy/helm/alerts/*`.

3. **PR 14 (`test/load-k6-benchmarks`):**
   - k6 load harness simulating 100 concurrent SDK long-polling instances and telemetry flushes.
   - Saturation limit documentation in `load/k6/*`.

---

## 5. Suggested Skills for Next Agent

The next agent should call the `Skill` tool for:
- `test-driven-development`: Write failing metrics tests before implementing `prom-client` metric registries in `apps/control-api` and callbacks in `packages/sdk`.
- `verification-before-completion`: Run `pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, and test suites before making any completion claims.
- `codebase-design`: Design the pluggable metrics callback seam in `@synapsestate/sdk` to avoid coupling the SDK to a specific metrics vendor (vendor-neutral OpenFeature invariant).

---

## 6. Verification Commands

```bash
# Monorepo Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm run test

# Infrastructure & Helm Gates
cd deploy/terraform && terraform fmt -check && terraform validate
cd ../.. && helm lint deploy/helm/control-api && helm lint deploy/helm/demo-shop
```
