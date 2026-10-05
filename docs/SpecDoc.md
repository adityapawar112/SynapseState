# Product specification document: SynapseState

**Document version:** 2.0.0-GA-SPEC

**Engineering classification:** Cloud-native distributed systems and runtime configuration infrastructure

**Primary language ecosystem:** Go monorepo (`synapsestate/synapsestate`) with polyglot SDK packages

**Licensing baseline:** 100% permissive open source (Apache 2.0)

---

## 1. Document control, revision history and scope

### 1.1 Revision history

* **v1.0.0-DRAFT:** Initial systems design sketch covering dual-plane GitOps and shared-memory sidecars.
* **v1.1.0-REV:** Addressed architectural scope; introduced single Go control plane, RFC 8785 canonical leasing, formal Quiescence Index ($Q$), and sharded Kubernetes CRDs.
* **v1.2.0-GA-SPEC:** Added reader unmap safety, lease lifecycle gaps, schema mismatches, and cold-start availability.
* **v2.0.0-GA-SPEC (Current):** Architectural pivot to Sidecar-Multiplexed In-Process Data Plane:
  * Replaced POSIX shared memory (`mmap` + FlatBuffers) with sidecar delta streaming over local Unix Domain Sockets into language-native heap memory.
  * Eliminated Node.js N-API FFI overhead and process crash hazards (`SIGSEGV`/`SIGBUS`).
  * Replaced strict dual-control requirement with Tiered Emergency Leases (single-operator break-glass with 30-minute TTL for MTTE < 30 seconds, promoted via dual control or Git merge).
  * Added flag lifecycle taxonomy (`release`, `experiment`, `killswitch`, `permission`) and pre-flight compiler type-checks/unit-test verification to `synapse-purger`.
  * Removed native C/Rust compilation toolchain from the Node.js SDK; implemented `sdk/node` in pure TypeScript.

### 1.2 Target system boundaries (v2.0 release scope)

SynapseState delivers a self-hosted, distributed runtime configuration and feature flag platform optimized for high-throughput, latency-critical microservices running in Kubernetes clusters.

The v2.0 release targets server-side microservices running in Go and Node.js (pure TypeScript). Additional runtimes (Rust, Java, Python) are roadmapped for subsequent minor releases.

### 1.3 Explicit non-goals (out of scope for v2.0)

* **Client-side, single-page (SPA), and mobile applications:** Excluded by design. Distributing internal rulesets to untrusted browsers or devices leaks business heuristics and breaks the zero-context-egress privacy guarantee.
* **Per-evaluation network or socket round-trips:** Excluded. Unlike proxy sidecars, the application SDK never makes network or socket round-trips to evaluate a flag.
* **Graphical administrative web UI:** Excluded. Operations in v2.0 are strictly declarative (GitOps via CRDs) and operational (Synapse CLI).
* **Unverified autonomous code commits:** Excluded. Automated code changes are submitted as Draft Pull Requests verified by compiler checks and repository tests.

---

## 2. Competitive positioning matrix

Performance figures for external projects reflect published benchmark ranges and standard in-process memory architectures. Figures for SynapseState represent strict engineering Target Service Level Objectives (SLOs) enforced during continuous automated benchmarking.

| Evaluation dimension | flagd / OpenFeature Operator | Flipt (Git-engine mode) | Unleash (Self-hosted OSS) | LaunchDarkly Enterprise | SynapseState v2.0 architecture |
| --- | --- | --- | --- | --- | --- |
| **Data plane IPC** | Localhost TCP / Unix domain socket per check | HTTP / gRPC loopback sidecar per check | In-process SDK cache or Unleash Edge | In-process SDK cache or Relay Proxy | **Local UDS delta stream on change; in-process heap cache on check** |
| **Hot-path P99 latency (Node.js)** | 200 µs – 1,500 µs (Socket IPC) | 700 µs – 3,000 µs (HTTP IPC) | 10 – 30 ns (In-process V8 heap) | 10 – 30 ns (In-process V8 heap) | **Target: 10 – 25 ns (Pure TypeScript, zero FFI)** |
| **Hot-path P99 latency (Go)** | 150 µs – 800 µs (Socket IPC) | 700 µs – 2,800 µs (Loopback sidecar) | < 1.0 µs (In-process heap) | < 1.0 µs (In-process heap) | **Target: < 0.5 µs (Native Go Engine)** |
| **Hot-path memory IPC cost** | Socket buffers, gRPC serialization per eval | Socket buffers, HTTP JSON serialization | Duplicate outbound connections per process | Duplicate outbound connections per process | **Zero socket calls on check; lightweight in-process heap cache** |
| **Process crash hazard** | Low (Socket timeouts) | Low (HTTP errors) | None (Pure managed runtime) | None (Pure managed runtime) | **None (Pure managed runtime, zero memory-mapping faults)** |
| **Emergency mitigation speed** | Blocked by K8s API event loop | Blocked by Git PR/commit cycle (3–10 min) | Web UI edit (Immediate; bypasses Git) | Web UI edit (Immediate; bypasses Git) | **Target: < 30 s via signed break-glass lease; dual-control promotion** |
| **GitOps drift defense** | K8s CRD authoritative | Git repository authoritative | Not GitOps-native (Database authoritative) | Not GitOps-native (SaaS DB authoritative) | **Git-authoritative with signed lease overlays + automated PR back-sync** |
| **Stale flag cleanup** | Unaddressed (OTel emission only) | Unaddressed (Manual removal) | UI stale markers; automation paywalled | UI stale markers; manual code PR required | **Guarded AST pruning with compiler type checks and test validation** |
| **Licensing stability** | Apache 2.0 | Open Core (Enterprise features paywalled) | Unleash Edge OSS reaches EOL Dec 31, 2026 | Proprietary SaaS with connection/seat billing | **100% Permissive Open Source (Apache 2.0)** |

---

## 3. Source-of-truth hierarchy and control-plane architecture

To eliminate split-brain states and reconcile competing configuration sources, SynapseState defines a strict, unidirectional source-of-truth hierarchy:

1. **Git repository (authoritative desired baseline):** The authoritative system of record for all steady-state feature configurations, variant weights, and targeting rules.
2. **Kubernetes API and custom resources (cluster projection):** GitOps controllers (ArgoCD or Flux v2) project Git declarations into cluster-level `FeatureFlagGroup` Custom Resources. The Synapse Operator watches these resources via Controller-Runtime Informers.
3. **PostgreSQL 16+ (derived system state and immutable audit ledger):** Stores relational snapshots of valid configurations, active and historic emergency leases, API credentials, and an append-only audit trail. Database triggers emit lightweight metadata pointers over `LISTEN`/`NOTIFY` when rows update.
4. **Upstream gRPC delta stream (real-time propagation bus):** Control plane replicas broadcast binary deltas over mTLS gRPC connections directly to pod sidecar agents.
5. **Local IPC delta stream (pod multiplexer):** The `synapse-agent` sidecar maintains a single upstream connection per pod and pushes parsed deltas over a local Unix domain socket (`/var/run/synapse/synapse.sock`) to application processes only when state changes.
6. **In-process heap cache (runtime evaluation):** Application SDKs store compiled rules in language-native heap memory (V8 Map in Node.js, `sync.Map` or atomic pointer in Go). Flag evaluations execute in 10 to 25 nanoseconds.

---

## 4. Threat model and security architecture (STRIDE analysis)

| Threat category | Target boundary | Specific attack vector | SynapseState architectural mitigation |
| --- | --- | --- | --- |
| **Spoofing** | Operator to Control Plane | Unauthorized actor submits an emergency override. | Mandatory OIDC JWT verification. Break-glass leases require Ed25519 digital signatures verified against trusted public key sets. |
| **Tampering** | Control Plane to Agent | Intermediary network hop modifies configuration deltas. | Deltas and emergency leases serialize using RFC 8785 (JSON Canonicalization Scheme) and sign with Ed25519. Agents verify signatures locally against a public-key ConfigMap. |
| **Repudiation** | Emergency Override Actions | An operator denies triggering an operational kill switch during an outage. | Signed lease envelopes contain immutable operator IDs, nonces, and incident ticket references recorded in an append-only PostgreSQL ledger. |
| **Information Disclosure** | Workload Process Context | User IDs, email addresses, and demographic attributes leak upstream during evaluation. | Targeting context never leaves process memory. SDKs perform all rule evaluations and MurmurHash3 bucketing locally. Telemetry exports only aggregated counters (`key`, `variant`, `reason`). |
| **Tampering / Corruption** | Workload Container to Agent | Compromised application process attempts to corrupt configuration state. | Communication occurs over a local Unix domain socket mounted via an intra-pod volume. Workload processes cannot write to the agent's internal configuration state. |
| **Elevation of Privilege** | Code Remediation Worker | Malicious repository injection or CI container breakout via automated code cleanup. | The purger executes no build scripts, runs no privileged containers, and requests no CI write permissions. It submits Draft Pull Requests verified by the repository's native CI. |

---

## 5. Data plane: sidecar streaming and in-process heap synchronization

### 5.1 Local transport and socket permissions

The data plane uses a standard intra-pod volume mounted at `/var/run/synapse`:
* **Sidecar Agent:** Creates and listens on Unix domain socket `/var/run/synapse/synapse.sock`.
* **Application SDK:** Connects to the local socket upon initialization.

### 5.2 Handshake protocol and streaming deltas

1. When an application process starts, the SDK establishes a connection to the local socket and sends a handshake frame requesting the active generation snapshot.
2. The sidecar responds with the complete configuration state.
3. The socket remains open. When upstream configuration updates arrive, the sidecar pushes compact Protobuf deltas containing only modified or deleted flag rules.

### 5.3 Lock-free atomic reference swaps and automatic memory reclamation

Application SDKs model configuration rulesets as immutable data snapshots:
* **Evaluation (Hot Path):** Readers read from the active ruleset reference using an atomic pointer load. Evaluations execute with zero mutex locks, zero network syscalls, and zero FFI transitions.
* **Update (Background Path):** Upon receiving a delta, the SDK compiles a new immutable snapshot in the background and executes an atomic pointer swap.
* **Reclamation:** Ongoing evaluations finish cleanly against their captured reference. Once unreferenced, superseded snapshots are collected automatically by the language runtime's garbage collector.
* **Crash Immunity:** Eliminates manual memory unmapping (`munmap`), eliminating all `SIGSEGV` and `SIGBUS` process crash hazards.

---

## 6. Emergency override and lease state machine

### 6.1 Tiered emergency authorization

SynapseState provides a two-tier emergency lease protocol to mitigate production incidents rapidly:

1. **Tier 1 (Single-Operator Break-Glass Lease):**
   * Signed with a single Ed25519 private key by an authorized SRE.
   * Mandatory maximum time-to-live (TTL) of 30 minutes.
   * Propagates cluster-wide in under 30 seconds (MTTE < 30s) to mitigate critical P0 incidents without late-night coordination delays.
   * The control plane automatically opens a back-sync pull request against the authoritative Git repository.
2. **Tier 2 (Dual-Control Promotion):**
   * To extend an emergency lease beyond 30 minutes, an independent approver must co-sign the lease with their Ed25519 key, or the automated GitOps back-sync PR must be merged.
   * If neither occurs within 30 minutes, the lease expires automatically, reverting the flag to its baseline.

### 6.2 GitOps sync loop protection

When an emergency lease is active, the agent annotates cluster state. GitOps reconcilers (such as ArgoCD or Flux) respect active lease overlays, preventing continuous delivery sync loops from reverting the emergency fix while the incident is ongoing.

---

## 7. Protocol Buffers delta schema and evaluation engine

### 7.1 Schema definition (`pkg/protocol/delta.proto`)

```protobuf
syntax = "proto3";

package synapsestate.protocol;

enum FlagLifecycle {
  RELEASE = 0;
  EXPERIMENT = 1;
  KILLSWITCH = 2;
  PERMISSION = 3;
}

enum Operator {
  EQUALS = 0;
  NOT_EQUALS = 1;
  IN = 2;
  NOT_IN = 3;
  GREATER_THAN = 4;
  LESS_THAN = 5;
  SEMVER_GTE = 6;
}

message TargetingRule {
  uint32 priority = 1;
  string attribute_name = 2;
  Operator op = 3;
  repeated string match_values = 4;
  string serve_variant = 5;
}

message RolloutSplit {
  string variant_name = 1;
  uint32 weight_basis_points = 2; // 0 to 10,000
}

message FlagDefinition {
  string key_name = 1;
  FlagLifecycle lifecycle = 2;
  bool is_enabled = 3;
  string default_variant = 4;
  string off_variant = 5;
  repeated TargetingRule rules = 6;
  repeated RolloutSplit splits = 7;
}

message DeltaUpdate {
  uint64 generation = 1;
  repeated FlagDefinition upserted_flags = 2;
  repeated string deleted_flag_keys = 3;
}
```

### 7.2 Evaluation flow and MurmurHash3 bucketing

Rule evaluation follows a deterministic execution order:
1. **Map Lookup:** O(1) hash map lookup by flag key in process memory.
2. **Enabled Check:** If `is_enabled == false`, return `off_variant` with reason `DISABLED`.
3. **Targeting Rules:** Evaluated in ascending priority order. If an attribute matches, return `serve_variant` with reason `TARGETING_MATCH`.
4. **Percentage Rollout:** If no rule matches, calculate bucket using unsigned 32-bit MurmurHash3:
   $$\text{Bucket} = \text{uint32}(\text{Murmur3\_32}(\text{key} + ":" + \text{attributeValue})) \pmod{10000}$$
   Return corresponding variant with reason `SPLIT`.
5. **Default Fallback:** If splits are unconfigured, return `default_variant` with reason `STATIC`.

---

## 8. Autonomous code remediation: guarded Quiescence and safe AST pruning

### 8.1 Candidate qualification criteria

A flag is classified as a `STALE_CANDIDATE` if and only if all of the following conditions hold simultaneously:
* **Lifecycle Eligibility:** The flag's declared lifecycle is `release` or `experiment`. Flags marked `killswitch` or `permission` are permanently excluded.
* **Complete Invariance:** $Q(f, \tau) = 1.0$ continuously across the entire observation window ($\tau \ge 30\text{ days}$).
* **Minimum Volume:** Total valid evaluations $\ge 100,000$.
* **Error Rate Ceiling:** Degraded evaluations $\le 1\%$.
* **Multi-Cluster Invariance:** Evaluates to the identical dominant variant across 100% of production clusters.

### 8.2 Guarded two-phase deletion protocol

1. **Phase 1: Source code pruning with CI validation.**
   * `synapse-purger` parses application code using `ts-morph` (TypeScript) or `go/types` (Go).
   * Inlines the winning execution path and removes dead conditional blocks.
   * **Pre-flight compiler verification:** Runs `tsc --noEmit` to verify that removing conditional branches has not broken control-flow type narrowing.
   * **Pre-flight test verification:** Runs repository unit tests to identify and update unit test mocks asserting flag evaluations.
   * Submits a **Draft Pull Request** with telemetry proofs. Automatic merging is prohibited.
2. **Phase 2: Configuration pruning.**
   * Once the Phase 1 PR is merged and deployed, the control plane enters a 7-day observation period.
   * After evaluation counts drop to zero across all production pods, the control plane opens an automated PR removing the flag definition from Git.

---

## 9. Kubernetes integration and operational reliability

### 9.1 Deterministic pod startup order

Application containers do not start until the `synapse-agent` native sidecar initializes the local socket:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  template:
    spec:
      volumes:
        - name: synapse-socket
          emptyDir: {}
      initContainers:
        - name: synapse-agent
          image: synapsestate/agent:v2.0.0
          restartPolicy: Always
          volumeMounts:
            - name: synapse-socket
              mountPath: /var/run/synapse
          startupProbe:
            httpGet:
              path: /readyz
              port: 9091
            failureThreshold: 30
            periodSeconds: 1
      containers:
        - name: application
          image: payment-service:v2.4.0
          volumeMounts:
            - name: synapse-socket
              mountPath: /var/run/synapse
```

### 9.2 Probe isolation and offline resilience

* **Liveness Probe (`/healthz`):** Checks agent local process health only. Does not check upstream connectivity.
* **Readiness Probe (`/readyz`):** Returns HTTP 200 once the local Unix domain socket is active and initialized.
* **Cold-Start Disk Snapshot:** If a pod schedules during a central control plane outage, the agent loads a cached snapshot from local storage, initializes the local socket, and allows the application to start immediately.

---

## 10. Service Level Objectives (SLOs)

| Measurement boundary | Target metric | Evaluation conditions |
| --- | --- | --- |
| **Native Go Engine** | $p99 \le 0.5\text{ µs}$ | Direct in-memory lookup, 0 heap allocs on evaluation. |
| **Public Go SDK (OpenFeature)** | $p99 \le 1.0\text{ µs}$ | Complete OpenFeature evaluation path including `ResolutionDetails`. |
| **Public Node.js SDK (OpenFeature)** | $p99 \le 1.0\text{ µs}$ | Pure TypeScript in-memory lookup (10–25 ns core evaluation). |
| **Intra-Cluster EEL Propagation** | $p99 \le 50\text{ ms}$ | Time from control-plane API acceptance to local SDK pointer swap. |
| **Straggler Pod Detection** | $\text{Max} \le 10\text{ s}$ | Maximum time to detect and alert on non-acknowledging pods. |

---

## 11. Technology stack and directory layout

* `cmd/`
  * `synapse-control/`: Go control plane daemon; handles gRPC streaming, CRD sync, and Ed25519 signing.
  * `synapse-operator/`: Kubernetes controller built with Controller-Runtime; reconciles `FeatureFlagGroup` CRDs.
  * `synapse-agent/`: Lightweight Go sidecar daemon; manages upstream sync and local UDS streaming.
  * `synapse-cli/`: SRE administrative tool; handles break-glass override signing and lease management.
  * `synapse-purger/`: Quiescence engine and AST refactoring tool using `go/types` and `ts-morph`.
* `pkg/`
  * `apis/`: Kubernetes CustomResourceDefinition structs and OpenAPI validation schemas.
  * `protocol/`: Protobuf delta schemas (`pkg/protocol/delta.proto`) and generated Go/TypeScript bindings.
  * `crypto/`: Ed25519 signing, verification, and RFC 8785 canonicalization utilities.
  * `engine/`: In-process rule evaluation and unsigned 32-bit MurmurHash3 bucketing logic.
* `sdk/`
  * `go/`: OpenFeature Go Provider with atomic pointer swaps.
  * `node/`: Pure TypeScript OpenFeature Node.js Provider.
* `deploy/`
  * `manifests/`: Base CRD manifests (`FeatureFlagGroup`, `EmergencyLease`).
  * `helm/`: Helm deployment charts for control plane, PostgreSQL, and sidecar mutating webhooks.
* `tests/`
  * `conformance/`: Cross-runtime test vectors verifying identical evaluation outcomes.
  * `chaos/`: Failure injection suites testing network partitions, sidecar crashes, and reconnect loops.
  * `fixtures/`: Corpus of test repositories containing standard OpenFeature patterns for AST validation.