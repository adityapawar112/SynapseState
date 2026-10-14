# SynapseState: System Limitations & Failure Boundaries

> **Status:** Active Reference Document  
> **Primary Specification:** [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md)  
> **Charter:** [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md)

---

## 1. Scope & Purpose

SynapseState adheres to an **evidence-based claims policy**: we document our architectural boundaries, non-goals, and failure modes explicitly. This document details what SynapseState does **not** protect against and where its operational boundaries lie.

---

## 2. Infrastructure & Availability Boundaries

### 2.1 Single-Node Governance Plane & Air-Gapped Fallback
* **Limitation:** In the default architecture, the Control API and PostgreSQL run on a single Kubernetes node (e.g. k3s on a single cloud VM).
* **Implication:** If the VM or database crashes, the Control API becomes unavailable until restarted.
* **Mitigation & Fallbacks:** 
  1. **Fail-Static In-Process:** Application microservices evaluate feature flags locally in memory. During Control API outages, **workload evaluation never blocks or fails**. SDKs fail static: already-verified leases remain active until their individual deadlines elapse.
  2. **Air-Gapped Out-of-Band Channel:** Because leases are self-authenticating, SREs can apply overrides directly via `kubectl apply` to `/etc/synapse/emergency-leases/` mounted ConfigMaps. Workloads enforce overrides without contacting the Control API.

### 2.2 Revocation Window Under Network Partition
* **Limitation:** When an operator revokes an emergency lease via `synapse lease revoke`, the revocation record is distributed via HTTP long-polling.
* **Implication:** If an application pod is partitioned from the Control API, it cannot receive the revocation. The active override will continue to be honored until its original time-to-live (`ttl_seconds`) expires.
* **Bound:** The exposure window is strictly bounded by the lease's remaining TTL, which is capped at `MAX_TTL` (default 30 minutes, configurable up to 24 hours). Revocations in the API are retained exactly until `lease.expires_at + SKEW_TOLERANCE`.

---

## 3. Cryptographic & Clock Boundaries

### 3.1 Cold Restart Under Severe Clock Skew
* **Limitation:** The monotonic clock (`first_seen_mono + ttl_seconds`) resets to zero when a pod restarts.
* **Invariant:** The monotonic leg strictly bounds lease duration against NTP jumps **within a single process incarnation**. Across cold restarts, the absolute wall-clock ceiling (`issued_at + ttl_seconds + SKEW_TOLERANCE`) unconditionally bounds lease validity.
* **Mitigation:** The CLI syncs `issued_at` via `GET /v1/time`, and the Control API rejects any lease creation where workstation drift exceeds `SKEW_TOLERANCE`.

### 3.2 Compromise of Operator Private Keys
* **Limitation:** Overrides are authorized by individual operator Ed25519 signatures.
* **Storage Threat Model:** The default pure-TypeScript CLI signer stores private keys in encrypted files on disk (`~/.synapse/keys/<kid>.key`) encrypted with AES-256-GCM and `crypto.scrypt` with strict POSIX mode `0600` permissions. While protected by a mandatory passphrase and AAD binding, a file on disk is accessible to any malware or process executing under the operator's user context (unlike hardware-backed YubiKeys or non-exportable OS keychains). Pluggable `Signer` interfaces allow teams to configure OS keychains or SSH-agent / SSHSIG signers where higher assurance is needed.
* **Operational Redundancy:** A lost laptop means the on-call person cannot sign overrides until a Git PR adds a new public key. Team policy mandates at least **two authorized key holders** on every on-call rotation, and the CLI provides `synapse key generate` and `synapse key export-public` to automate replacement PRs.
* **Mitigation:** 
  1. **Per-Key TTL Caps:** Keyset specifies `max_ttl_seconds` per key (e.g. 1 hour default), bounding the attack window.
  2. **Signed Fast-Path Key Invalidation:** Emergency key revocations (`synapsestate/keyrevocation/v1\n`) distributed via the Control API immediately drop active leases across all connected pods.
  3. **Hot-Reload Keyset Polling:** SDKs poll the mounted keyset file hash every 10 seconds.

### 3.3 Audit Ledger Tamper-Evidence
* **Limitation:** The PostgreSQL audit ledger uses SHA-256 hash chaining sealed asynchronously via an in-process single-writer background process.
* **Chain Ordering Invariant:** Sequence numbers (`seq`) and hash chains are assigned at seal time by the sealer, not insertion time (`audit_pending.id`), ensuring chain continuity despite concurrent out-of-order database commits.
* **Implication:** A hash chain alone does not prevent an attacker with root database access from rewriting history and recalculating hashes from the point of edit onward.
* **Bound:** SynapseState provides **tamper-evidence**, not absolute tamper-proof storage. External anchoring jobs run as an independent Kubernetes CronJob with isolated credentials, periodically signing and committing checkpoints to an immutable write-once store (e.g., protected Git branch or S3 Object Lock). Any tampering prior to the latest anchored checkpoint is immediately detectable during verification (`synapse audit verify`).

### 3.4 Bounded Keyset Fallback Cache
* **Limitation:** When volume mounts experience turbulence or symlink update delays, the SDK falls back to its in-memory parsed keyset cache.
* **Bounded Staleness Window:** The SDK tracks `keyset_verified_at` and exports `synapse_sdk_keyset_age_seconds`. If volume reads continue to fail beyond **15 minutes**, the SDK halts acceptance of *new* emergency leases (failing static for overrides).
* **Revocation Latency Trade-Off:** Caching preserves override resilience against transient Kubernetes filesystem blips, but delays key revocation enforcement if the filesystem mount permanently breaks. The 15-minute ceiling bounds this revocation exposure.
* **Delegate Continuity:** Keyset read failures never disrupt baseline flag evaluation; evaluations fall through unaffected to the delegate provider.
* **Cold Starts:** Pods starting cold with an unreadable keyset file boot with overrides disabled and emit a degraded metric without failing readiness probes.

---

## 4. Telemetry & Stale Detection Boundaries

### 4.1 Telemetry Coverage Dependency & Service Lifecycle
* **Limitation:** A flag qualifies as a `stale_candidate` only if all services that recorded evaluations for that flag within data retention are in `ACTIVE` or `RETIRED` status.
* **Implication:** If an evaluating service goes `SILENT` (no heartbeat for $> 14\text{ days}$), stale qualification for its flags is paused to prevent deleting code prematurely from scaled-to-zero or monthly batch services.
* **Escape Valve:** SREs explicitly unblock flags by retiring decommissioned services via `synapse service retire`, or allowing the 90-day auto-retirement sweep to transition them.

### 4.2 Zero Context Invisibility
* **Limitation:** To guarantee zero context egress and complete privacy compliance, `TelemetryHook` captures only `(flag_key, variant, reason)` tuples.
* **Implication:** SynapseState cannot determine which specific user cohorts, tenants, or geographies received a variant. It only knows aggregate cluster-wide variant distributions.

---

## 5. Automated Code Governance (`synapse-purger`) Boundaries

### 5.1 Read-Only Scanner Scope
* **Limitation:** `synapse-purger` in v1 operates strictly as a read-only scanner and qualification engine. It does not rewrite code or execute tests.
* **Security Barrier:** The purger **never** executes repository test suites (`npm test`) or build scripts inside application repositories next to GitHub credentials.
* **Interoperability:** It outputs structured `(flag_key, winning_variant)` candidate reports with call-site locations for integration with established refactoring tools (Uber Piranha, GritQL) or human review.

---

## 6. Evaluation Path & Wrapper Overhead

* **Limitation:** SynapseState wraps an underlying OpenFeature provider. It cannot evaluate flags faster than the delegate provider itself.
* **Overhead Budget:** The `OverrideProvider` introduces a single in-memory Map lookup and null check before calling the delegate. The exact overhead will be measured in Phase 1 microbenchmarks and published transparently in `docs/benchmarks/`.

---

## 7. Git Promotion Provider Scope (v1)

* **Limitation:** Automated lease promotion (`synapse promote`) modifies flag definitions in Git by opening Pull Requests against `flags/<env>/<flag_key>.yaml`.
* **Provider Boundary:** In v1, automated promotion is strictly supported for **Git-backed flag providers** (such as `flagd` in-process or JSON/YAML file providers).
* **SaaS / External Providers:** For providers where baseline definitions reside in an external database or SaaS vendor console (such as Unleash or LaunchDarkly), SynapseState emergency overrides evaluate and expire correctly, but automated Git promotion is out of scope. Permanent baseline changes must be applied through the vendor's administrative interface.

---

## 8. Observability & Benchmark Boundaries

### 8.1 Metric Cardinality & Per-Lease TTL Countdown
* **Limitation:** Prometheus metrics exported by Control API deliberately omit individual `lease_id` labels and dynamic countdown series.
* **Invariant:** Invariant 5 requires bounded cardinality. During major incidents with multiple overrides, exporting per-lease gauge series (`synapse_lease_ttl_remaining{lease_id="..."}`) risks cardinality explosion in Prometheus TSDB.
* **Operational Alternative:** Real-time remaining lease TTLs are inspected via CLI (`synapse lease list`) or the read-only operations dashboard table.

### 8.2 Load Benchmark Environment Boundaries
* **Limitation:** Phase 3 k6 benchmarks were conducted against local mock servers and single-node Control API instances under loopback networking.
* **Boundary:** Measured wake-up and propagation latencies ($p95 \approx 462\text{ms}$) reflect server-side event dispatch and local I/O. In geographically distributed Kubernetes clusters, cross-node network latency and ingress proxy hops will add baseline RTT, while remaining well within the $p95 \le 10\text{s}$ SLO.

### 8.3 Telemetry Pool Load-Shedding Trade-Off
* **Limitation:** The dedicated `telemetryPool` bulkhead sheds load via `HTTP 429 Too Many Requests` during database write saturation.
* **Implication:** If client SDKs experience extended network partitions or high evaluation surges, dropped batches increment `synapse_sdk_telemetry_dropped_total`.
* **Design Priority:** Telemetry is non-critical path. Shedding telemetry batches guarantees that critical break-glass lease creation, revocation, and `/v1/sdk/state` delivery remain 100% available without connection pool starvation.


