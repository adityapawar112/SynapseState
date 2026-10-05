# SynapseState: System Limitations & Failure Boundaries

> **Status:** Active Reference Document  
> **Primary Specification:** [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md)  
> **Charter:** [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md)

---

## 1. Scope & Purpose

SynapseState adheres to an **evidence-based claims policy**: we document our architectural boundaries, non-goals, and failure modes explicitly. This document details what SynapseState does **not** protect against and where its operational boundaries lie.

---

## 2. Infrastructure & Availability Boundaries

### 2.1 Single-Node Governance Plane
* **Limitation:** In the default architecture, the Control API and PostgreSQL run on a single Kubernetes node (e.g. k3s on a single cloud VM).
* **Implication:** There is no multi-region replication or multi-master high availability. If the underlying VM or database crashes, the Control API becomes unavailable until restarted.
* **Mitigation & Fallback:** Application microservices evaluate feature flags locally in memory. During Control API outages, **workload evaluation never blocks or fails**. SDKs fail static: already-verified leases remain active until their individual deadlines elapse, and general evaluation falls back to the delegate OpenFeature provider.

### 2.2 Revocation Window Under Network Partition
* **Limitation:** When an operator revokes an emergency lease via `synapse lease revoke`, the revocation record is distributed via HTTP polling.
* **Implication:** If an application pod is partitioned from the Control API, it cannot receive the revocation. The active override will continue to be honored until its original time-to-live (`ttl_seconds`) expires.
* **Bound:** The exposure window is strictly bounded by the lease's remaining TTL, which is capped at `MAX_TTL` (default 30 to 60 minutes).

---

## 3. Cryptographic & Clock Boundaries

### 3.1 Cold Restart Under Severe Clock Skew
* **Limitation:** SDKs use a monotonic clock captured on first sight (`first_seen_mono`) plus a wall-clock deadline (`issued_at + ttl_seconds + SKEW_TOLERANCE`).
* **Implication:** If a pod experiences a cold restart, its monotonic counter resets to zero. If the pod's host machine simultaneously suffers from severe wall-clock drift (greater than `SKEW_TOLERANCE`), a previously expired or superseded lease replayed by a compromised network proxy could theoretically be accepted as new until `ttl_seconds` elapses on the new monotonic clock.
* **Mitigation:** The SDK compares `issued_at` against the `server_time` returned in the same signed response envelope, rejecting leases whose age at first sight exceeds normal polling thresholds.

### 3.2 Compromise of Operator Private Keys
* **Limitation:** Overrides are authorized by individual operator Ed25519 signatures.
* **Implication:** If an attacker exfiltrates an authorized SRE's private signing key, the attacker can sign emergency overrides until the key is revoked.
* **Mitigation:** Emergency leases enforce a mandatory 30-minute maximum TTL. To persist an override, Git promotion requires peer review. Compromised keys are revoked by committing an updated keyset to Git, which updates the mounted ConfigMap across pods.

### 3.3 Audit Ledger Tamper-Evidence
* **Limitation:** The PostgreSQL audit ledger uses SHA-256 hash chaining.
* **Implication:** A hash chain alone does not prevent an attacker with root database access from rewriting history and recalculating hashes from the point of edit onward.
* **Bound:** SynapseState provides **tamper-evidence**, not absolute tamper-proof storage. External anchoring jobs periodically sign and commit checkpoints to an immutable write-once store (e.g., protected Git branch or S3 Object Lock). Any tampering prior to the latest anchored checkpoint is immediately detectable during verification (`synapse audit verify`).

---

## 4. Telemetry & Stale Detection Boundaries

### 4.1 Telemetry Coverage Dependency
* **Limitation:** A feature toggle is only classified as a `stale_candidate` if 100% of registered services in the target environment have actively submitted evaluation metrics during the 30-day observation window.
* **Implication:** If a single microservice that evaluates the flag is silent (due to network misconfiguration, crashed telemetry worker, or unregistered legacy process), the flag will **never** qualify for automated retirement. A silent service means **unknown**, not unused.

### 4.2 Zero Context Invisibility
* **Limitation:** To guarantee zero context egress and complete privacy compliance, `TelemetryHook` captures only `(flag_key, variant, reason)` tuples.
* **Implication:** SynapseState cannot determine which specific user cohorts, tenants, or geographies received a variant. It only knows aggregate cluster-wide variant distributions.

---

## 5. Automated Code Refactoring (`synapse-purger`) Boundaries

### 5.1 Narrow Syntactic Coverage
* **Limitation:** `synapse-purger` v1 is designed specifically for TypeScript using `ts-morph` and targets only literal string keys in standard evaluation calls (`client.getBooleanValue('key', false)`).
* **Excluded Patterns (Refused by Default):**
  - Dynamically constructed keys (`client.getBooleanValue(config.prefix + id)`).
  - Wrapper helper functions or custom abstraction layers around the OpenFeature client.
  - Multi-variant string, number, or object flag evaluations in v1.
  - Flag references inside unit test mocks or fixture files that cannot be statically mapped.
* **Behavior:** When an unsupported pattern is detected, the purger **refuses to modify code** and emits a structured `Refusal Report`.

### 5.2 Mandatory Human Review
* **Limitation:** The purger does not autonomously merge code.
* **Implication:** All purger operations result in GitHub **Draft Pull Requests**. A human engineer must inspect the diff and verify repository CI before merging.

---

## 6. Evaluation Path & Wrapper Overhead

* **Limitation:** SynapseState wraps an underlying OpenFeature provider. It cannot evaluate flags faster than the delegate provider itself.
* **Overhead Budget:** The `OverrideProvider` introduces a single in-memory Map lookup and null check before calling the delegate. The exact overhead will be measured in Phase 1 microbenchmarks and published transparently in `docs/benchmarks/`.
