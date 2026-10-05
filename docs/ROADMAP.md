# Wayfinder Delivery Roadmap: SynapseState

> **Status:** Active Roadmap (Post-Pivot v3.0)  
> **Charter:** [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md)  
> **Architecture:** [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md)  
> **Product Definition:** [PRODUCT.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/PRODUCT.md)  
> **System Boundaries & Limitations:** [docs/limitations.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/limitations.md)

---

## 1. Destination & North Star

SynapseState delivers a production-grade, self-hosted **incident-safety and lifecycle governance layer for OpenFeature**. It adds signed, auto-expiring emergency overrides that reconcile back to Git, and telemetry-driven, compiler-verified code retirement pull requests for dead feature flags.

The delivery plan is organized into **sequenced, demonstrable phases**. Each phase concludes with working code, automated verification, and demonstrable evidence.

---

## 2. Phased Delivery Map

Estimates assume part-time engineering (10 to 15 focused hours per week).

```mermaid
gantt
    title SynapseState Delivery Phasing
    dateFormat  YYYY-MM-DD
    section MVP
    Phase 1: Foundation (Core SDK & Lease)     :done, p1, 2026-10-06, 14d
    Phase 2: Deploy (Control API & k3s)         :active, p2, after p1, 14d
    Phase 3: Observe (Observability & SLOs)     :p3, after p2, 14d
    Phase 4: Incident Loop (CLI & Git PRs)      :p4, after p3, 14d
    section Lifecycle & UI
    Phase 5: Purger (AST Refactoring)          :p5, after p4, 14d
    Phase 6: Dashboard & Attribution           :p6, after p5, 14d
    section Extensions
    Phase 7: Optional (GitOps / Second Provider):p7, after p6, 21d
```

### Phase 1: Cryptographic Foundation & In-Process SDK (Weeks 1 – 2)
**Deliverable:** Monorepo scaffolding, CI pipelines, Dockerfiles, `packages/lease`, `packages/sdk`, and language-neutral conformance suite.

* **1.1 Monorepo Workspace & Build Orchestration:**
  * Configure npm/pnpm workspaces for `packages/*` and `apps/*`.
  * Establish GitHub Actions CI: linting, formatting (`prettier`), type-checking, and tests.
* **1.2 Cryptographic Lease Core (`packages/lease`):**
  * RFC 8785 JSON canonicalization.
  * Ed25519 signing and verification with domain separation (`"synapsestate/lease/v1\n"`).
  * Dual-clock expiration validation logic (`min(wall_expiry, mono_expiry)`).
* **1.3 OpenFeature In-Process SDK (`packages/sdk`):**
  * `OverrideProvider`: Implements OpenFeature `Provider` interface; wraps any delegate provider (e.g., flagd file source or plain JSON).
  * In-memory lease cache with thread-safe pointer references.
  * Fail-safe exception shielding: any internal error falls through to the delegate provider.
  * `TelemetryHook`: Zero-context `after`/`finally` hook recording `(flag_key, variant, reason)`.
* **1.4 Golden Test Conformance Suite (`packages/conformance`):**
  * Test vectors covering valid signatures, tampered payloads, unknown `kid`, wall-clock expiry, monotonic expiry, future-dating, and clock-skew tolerance.
* **Definition of Done:** 100% green CI; full conformance vector coverage; zero dependencies on native C/Rust binaries.

---

### Phase 2: Deployment & Infrastructure as Code (Weeks 3 – 4)
**Deliverable:** Control API + PostgreSQL deployed on k3s via Terraform and Helm; container images published to GHCR.

* **2.1 Control Plane Service (`apps/control-api`):**
  * Express/Fastify service in TypeScript connected to PostgreSQL 16.
  * `POST /v1/leases`: validates signatures against pinned keyset, enforces single active lease constraint, commits to Postgres.
  * `GET /v1/sdk/state`: HTTP polling endpoint with `ETag` and `304 Not Modified` conditional responses.
  * `POST /v1/telemetry/batches`: idempotent batch ingestion with `(instance_id, batch_id)` deduplication.
* **2.2 Infrastructure as Code (`deploy/terraform`):**
  * Terraform configuration provisioning a single lightweight cloud VM, security groups, firewall rules, and DNS records.
  * Remote state with state locking; `terraform fmt`, `validate`, and `plan` running in CI.
  * Automated `make teardown` target for cost management.
* **2.3 Kubernetes Packaging (`deploy/helm`):**
  * Helm charts deploying Control API and Postgres on k3s.
  * Pod security standards: read-only root filesystems, non-root users, dropped capabilities.
  * Ingress routing with TLS termination via cert-manager.
* **Definition of Done:** Public HTTPS endpoint live; clean tag-triggered release deployment; working teardown and recreation scripts.

---

### Phase 3: Observability, Metrics & SLO Verification (Weeks 5 – 6)
**Deliverable:** Prometheus metrics, Grafana dashboards, OpenTelemetry traces, multi-window burn-rate alerts, and k6 load verification.

* **3.1 Metrics Instrumentation:**
  * Control API Prometheus metrics: `synapse_leases_active`, `synapse_lease_transitions_total`, `synapse_state_poll_duration_seconds`, `synapse_telemetry_batches_total`.
  * SDK metrics callback: `synapse_sdk_state_age_seconds`, `synapse_sdk_poll_errors_total`, `synapse_sdk_telemetry_dropped_total`.
* **3.2 Grafana Dashboards & Alert Rules:**
  * Operations dashboard tracking active leases, TTL countdowns, and propagation lag.
  * Alertmanager multi-window burn-rate alert rules on state availability and propagation lag.
* **3.3 Load & Stress Benchmarking (`load/k6`):**
  * k6 load test simulating 100 concurrent SDK polling instances and telemetry flushes.
  * Identify first saturation bottleneck and publish documented limits.
* **Definition of Done:** Working Grafana dashboard with real firing alert screenshots; published SLO verification report with measured numbers.

---

### Phase 4: Incident Break-Glass Loop & Git Reconciliation (Weeks 7 – 8)
**Deliverable:** SRE CLI tool, Git PR promotion loop, tamper-evident audit ledger with external anchoring, and scripted failure drills.

* **4.1 Command-Line Interface (`packages/cli`):**
  * `synapse lease create`: canonicalizes, signs with operator Ed25519 private key, posts to API.
  * `synapse lease list`: tabular display of active leases and remaining TTL.
  * `synapse lease revoke`: issues signed revocation message.
  * `synapse promote`: triggers Git reconciliation PR.
  * `synapse audit verify`: recomputes hash chain from genesis against checkpoints.
* **4.2 Git Reconciliation & Dual-Control Promotion:**
  * GitHub App integration: opens PR on `flags.yaml` when an operator promotes a lease.
  * Human peer review and merge of the PR serves as formal secondary approval.
  * GitHub merge webhook transitions lease to `PROMOTED` and emits revocation.
* **4.3 Tamper-Evident Audit Ledger:**
  * SHA-256 hash chaining of all state mutations in Postgres.
  * Scheduled job signs periodic checkpoints to an external write-once store.
* **4.4 Reliability & Chaos Drills:**
  * Drill 1: Kill Control API during active lease -> verify fail-static until TTL expiry.
  * Drill 2: Clock-skew injection -> verify monotonic expiry enforcement.
  * Drill 3: Network partition during revocation -> verify bounded exposure.
  * Drill 4: Write one formal postmortem report in `docs/postmortems/`.
* **Definition of Done:** Scripted 90-second demo executable end-to-end; one written postmortem from a deliberate failure drill.

---

### Phase 5: Autonomous Code Retirement (`synapse-purger`) (Weeks 9 – 10)
**Deliverable:** `ts-morph` AST refactoring engine, labeled evaluation corpus, and structured refusal reports.

* **5.1 Quiescence & Candidate Qualification Engine:**
  * SQL rollup jobs scanning `flag_usage_daily` and `services`.
  * Candidate rule: `class = release`, single variant for 30 days, 100% service telemetry coverage, zero active leases.
* **5.2 TypeScript AST Refactoring Pipeline (`apps/purger`):**
  * Parse repository via `ts-morph` from `tsconfig.json`.
  * Identify literal string key evaluations (`getBooleanValue('literal-key', defaultVal)`).
  * Inline winning variant, eliminate dead conditionals, prune unreferenced imports.
* **5.3 Pre-Flight Compiler & Test Verification:**
  * Execute `tsc --noEmit`, ESLint, and repository test suites.
  * Submit GitHub **Draft Pull Request** with attached telemetry proofs.
* **5.4 Refusal by Default:**
  * Emit structured Refusal Report for non-literal keys, wrappers, or complex test mocks.
* **Definition of Done:** Zero incorrect removals on labeled corpus; published refusal and success rates.

---

### Phase 6: Operations Dashboard & Change Attribution (Weeks 11 – 12)
**Deliverable:** Next.js read-mostly dashboard with OIDC RBAC, Alertmanager change attribution webhook, and polished documentation.

* **6.1 Next.js Operations Dashboard (`apps/dashboard`):**
  * Read-mostly interface displaying active leases, countdown timers, flag inventory, and telemetry rollups.
  * GitHub OIDC authentication with roles (`viewer`, `operator`, `admin`).
  * Safety boundary: Dashboard can promote or revoke, but **cannot create leases** (signing keys reside on operator machines).
* **6.2 Incident Change Attribution Engine:**
  * Webhook listener on `POST /v1/alerts/webhook`.
  * Ranks flag events in the preceding 30 minutes by temporal recency and service evaluation overlap.
  * Automatically creates Grafana annotations and suggests copy-pasteable `synapse lease create` commands.
* **Definition of Done:** Deployed, clickable dashboard linked from README; end-to-end incident attribution demonstrated.

---

### Phase 7: Optional Advanced Integrations (Post-GA)
* GitOps controller integration (ArgoCD / Flux image-updater).
* Kubernetes CRD & operator for declarative flag manifest synchronization.
* Additional delegate providers (Unleash provider, Flipt provider).

---

## 3. Non-Negotiable Kill Criteria

To prevent scope creep and maintain strict project delivery:
1. **Infrastructure Over Features:** If Phase 2 (deployment on k3s via Terraform and Helm) is not live by the end of Week 4, stop adding features. If not live by Week 6, **cut the Dashboard and the Purger**. *Cut features, never infrastructure.*
2. **Purger Safety Gate:** If `synapse-purger` cannot achieve **zero incorrect removals** on the labeled corpus, ship it as **report-only** (lists candidates and call sites, but opens zero code PRs).
3. **Sequential Focus:** No secondary project or optional phase may begin until Phase 4 is completely green and demonstrated.

---

## 4. Scripted 90-Second Demo

1. **Baseline Operation:** The `demo-shop` application is running in k3s. Grafana shows steady transaction rates and zero 5xx errors.
2. **Trigger Incident:** Simulate a bad release merged behind flag `checkout-v2`. Latency spikes, and the Alertmanager burn-rate alert fires.
3. **Inspect Suspects:** The alert notification identifies `checkout-v2` as the top suspect change within the last 30 minutes.
4. **Issue Break-Glass Lease:**
   ```bash
   synapse lease create --flag checkout-v2 --env prod --value false --ttl 30m --reason "INC-142: High latency"
   ```
5. **Observe Recovery:** SDK polls state, verifies Ed25519 signature, and forces flag value to `false`. Grafana shows immediate error rate collapse.
6. **Promote to Git:**
   ```bash
   synapse promote <lease_id>
   ```
   Show the generated GitHub PR changing `checkout-v2` in `flags.yaml`.
7. **Verify Audit Chain:**
   ```bash
   synapse audit verify
   ```
   Confirm all transitions are cryptographically chained and match external checkpoints.

---

## 5. Engineering Portfolio & Competency Evidence Map

| Engineering Dimension | Artifact & Implementation | Verifiable Proof |
|---|---|---|
| **CI/CD Automation** | GitHub Actions: lint, test, conformance, Docker build, scan, Cosign signing, GHCR push | Green pipeline runs, signed release assets |
| **Containerization** | Multi-stage Dockerfiles with pinned distroless bases; `docker compose` | Single-command local developer environment |
| **Cloud & IaC** | Terraform: VM, security groups, firewall, DNS, S3 remote state | Committed Terraform plans, live HTTPS endpoint |
| **Kubernetes** | Helm chart on k3s, Traefik ingress, cert-manager TLS, NetworkPolicies | Manifests, running cluster workloads |
| **Observability** | Prometheus metrics, Grafana dashboards, OpenTelemetry spans | Dashboard screenshots, firing alert recordings |
| **Reliability Engineering** | Documented SLOs, k6 load testing, clock-skew injection drills, postmortem | Production-grade writeups in `docs/postmortems/` |
| **Supply-Chain Security** | Trivy vulnerability scanning, CycloneDX SBOMs, Cosign keyless signatures | CI logs, signed image provenance |
