# Product Specification Document (PRD): SynapseState

**Document Version:** 1.2.0-GA-SPEC

**Engineering Classification:** Cloud-Native Distributed Systems & Runtime Configuration Infrastructure

**Primary Language Ecosystem:** Go Monorepo (`synapsestate/synapsestate`) with Polyglot SDK Packages

**Licensing Baseline:** 100% Permissive Open Source — Apache 2.0 (Core Engine, Operator, Agent, SDKs)

---

## 1. Document Control, Revision History & Scope

### 1.1 Revision History

* **v1.0.0-DRAFT:** Initial systems design sketch covering dual-plane GitOps, shared-memory sidecars, and automated cleanup.
* **v1.1.0-REV:** Addressed architectural scope; introduced single Go control plane, RFC 8785 canonical leasing, formal Quiescence Index ($Q$), and sharded Kubernetes CRDs.
* **v1.2.0-GA-SPEC (Current):** Addressed reader unmap safety, lease lifecycle gaps, schema mismatches, and cold-start availability:
* Replaced time-based unmap with atomic reader epoch/refcount reclamation; defined SDK string lifetime contracts and bounded tmpfs cgroup memory budgeting.
* Replaced single-point Valkey dependency with direct gRPC delta streaming over mTLS; added native PostgreSQL `LISTEN`/`NOTIFY` control-plane synchronization.
* Extended emergency leases to require dual-control Ed25519 cryptographic signatures; added local monotonic clock deadlines, break-glass Kubernetes API fallbacks, and updated ArgoCD/Flux prune-prevention annotations.


* Synchronized the FlatBuffers binary schema with CRD capabilities: added multi-variant rollout splits, `float64` types, typed rule operators, and deterministic unsigned 32-bit MurmurHash3 bucketing.
* Corrected Quiescence formula notation; added multi-cluster invariance constraints, partial failure/error ceilings, and scoped AST parsing to `go/types` and `ts-morph` over a testable fixture corpus.
* Established deterministic cold-start initialization using Kubernetes 1.29+ native sidecar containers and local snapshot fallbacks.



### 1.2 Target System Boundaries (v1.0 Release Scope)

SynapseState delivers a self-hosted, distributed runtime configuration and feature flag platform optimized for high-throughput, latency-critical microservices running in Kubernetes clusters.

The v1.0 release targets server-side microservices running in Go and Node.js (via native N-API bindings). Additional runtimes (Rust, Java, Python) are roadmapped for subsequent minor releases.

### 1.3 Explicit Non-Goals (Out of Scope for v1.0)

* **Client-Side, Single-Page (SPA), and Mobile Applications:** Excluded by design. Distributing internal rulesets to untrusted browsers or devices leaks business heuristics and breaks the zero-context-egress privacy guarantee.
* **Serverless / Ephemeral Execution Environments:** Excluded. Environments such as AWS Lambda, Google Cloud Run, or Cloudflare Workers lack persistent local POSIX shared-memory mounts (`/dev/shm`), background daemon lifecycles, and `inotify` file primitives.
* **Node-Level DaemonSet Mode:** Excluded. Cross-pod memory sharing requires `hostPath` or `hostIPC` volumes, which violate Kubernetes Pod Security Standards (Restricted profile) and create cross-tenant memory isolation vulnerabilities.
* **Bayesian / Multi-Armed Bandit Experimentation:** Excluded. SynapseState does not calculate statistical p-values, conversion funnels, or dynamic multi-variant traffic re-allocations.
* **Graphical Administrative Web UI:** Excluded. Operations in v1.0 are strictly declarative (GitOps via CRDs) and operational (Synapse CLI).
* **In-Engine Container Sandbox Execution:** Excluded. The remediation engine does not run arbitrary container builds or manage Docker/Kata daemons. Automated code changes are submitted as Draft Pull Requests verified by the target repository's existing CI pipeline.

---

## 2. Competitive Positioning Matrix & Honest Performance Accounting

Performance figures for external projects reflect published benchmark ranges and standard in-process memory architectures. Figures for SynapseState represent strict engineering Target Service Level Objectives (SLOs) enforced during continuous automated benchmarking.

| Evaluation Dimension | flagd / OpenFeature Operator | Flipt (Git-Engine Mode) | Unleash (Self-Hosted OSS) | LaunchDarkly Enterprise | SynapseState v1.0 Architecture |
| --- | --- | --- | --- | --- | --- |
| **Data Plane IPC** | Localhost TCP / Unix Domain Socket (gRPC) | HTTP / gRPC loopback sidecar | In-process SDK cache or Unleash Edge | In-process SDK cache or Relay Proxy | **POSIX Shared Memory (`mmap`) via atomic `rename(2)**` |
| **Hot-Path P99 Latency (Go)** | 800 µs – 3,200 µs (Sidecar mode); < 1 µs (In-process mode) | 700 µs – 2,800 µs (Loopback sidecar) | < 1 µs (In-process SDK cache) | < 1 µs (In-process SDK cache) | **Target: < 0.8 µs (Native Engine); < 2.0 µs (Public SDK)** |
| **Hot-Path Memory IPC Cost** | Socket buffers, gRPC serialization per eval | Socket buffers, HTTP JSON serialization | Zero (In-process heap cache) | Zero (In-process heap cache) | **Zero syscalls; direct FlatBuffer pointer dereference** |
| **Emergency Mitigation Speed** | Blocked by K8s API event loop | Blocked by Git PR/commit cycle (3–10 min) | Web UI edit (Immediate; bypasses Git) | Web UI edit (Immediate; bypasses Git) | **Target: < 50 ms intra-cluster; signed dual-control leases** |
| **GitOps Drift Defense** | K8s CRD authoritative | Git repository authoritative | Not GitOps-native (Database authoritative) | Not GitOps-native (SaaS DB authoritative) | **Git-authoritative with signed lease overlays + automated PR back-sync** |
| **Stale Flag Cleanup** | Unaddressed (OTel emission only) | Unaddressed (Manual removal) | UI stale markers; automation paywalled | UI stale markers; manual code PR required | **Telemetry-verified AST pruning via Draft PRs** |
| **Licensing Stability** | Apache 2.0 | Open Core (Enterprise features paywalled) | Unleash Edge OSS reaches EOL Dec 31, 2026 | Proprietary SaaS with connection/seat billing | **100% Permissive Open Source (Apache 2.0)** |

*Note on Latency and Architecture:* When configured in pure in-process caching mode, existing tools like LaunchDarkly and Unleash achieve sub-microsecond evaluations. SynapseState's performance advantage applies specifically against proxy- and sidecar-based topologies (such as flagd sidecars or Flipt proxies), while avoiding the duplicate polyglot memory overhead incurred when each language runtime maintains its own in-memory cache.

---

## 3. Source-of-Truth Hierarchy & Control-Plane Architecture

To eliminate split-brain states and reconcile competing configuration sources, SynapseState defines a strict, unidirectional source-of-truth hierarchy:

1. **Git Repository (Authoritative Desired Baseline):** The authoritative system of record for all steady-state feature configurations, variant weights, and targeting rules.
2. **Kubernetes API & Custom Resources (Cluster Projection):** GitOps controllers (ArgoCD or Flux v2) project Git declarations into cluster-level `FeatureFlagGroup` Custom Resources. The Synapse Operator watches these resources via Controller-Runtime Informers.
3. **PostgreSQL 16+ (Derived System State & Immutable Audit Ledger):** Stores relational snapshots of valid configurations, active and historic emergency leases, API credentials, and an append-only audit trail. PostgreSQL is derived from Git for steady-state flags, but serves as the primary system of record for emergency leases and audit histories.
4. **gRPC Invalidation & Delta Stream (Real-Time Propagation Bus):** The control plane maintains long-lived HTTP/2 gRPC streaming connections directly to all Pod sidecar agents. Changes committed to PostgreSQL are broadcast across control-plane replicas via PostgreSQL `LISTEN`/`NOTIFY` and streamed to agents.
5. **Shared Memory Arena (Immutable Runtime Snapshot):** An immutable FlatBuffers binary (`arena.bin`) mapped into workload process memory via `mmap(2)` with `PROT_READ`.

### System Component Interactions

* **Steady-State GitOps Flow:**
* SRE or Developer merges configuration change into the Git repository.
* ArgoCD or Flux reconciles Git state into Kubernetes `FeatureFlagGroup` Custom Resources.
* The Synapse Operator validates manifests via an Admission Webhook and updates the PostgreSQL ledger.
* The Synapse Control Plane compiles the new generation, assigns a monotonically increasing Generation ID, and streams the delta to connected agents over gRPC.
* The agent writes the binary FlatBuffer payload into a memory-backed volume and atomically swaps the active file.
* Workload SDKs detect the updated generation and read the new flag state directly from memory.


* **Emergency Incident Flow:**
* SRE executes `synapse emergency-lease create` via the CLI.
* SRE and an independent Approver provide cryptographic Ed25519 signatures over the canonical lease envelope.
* The Control Plane validates signatures, commits the lease to PostgreSQL, and broadcasts the override across the gRPC stream.
* Agents receive the lease, write an updated arena snapshot to shared memory, and return an acknowledgment containing the applied generation ID.
* The Control Plane initiates automated Git convergence by opening a Pull Request against the Git baseline.



---

## 4. Threat Model & Security Architecture (STRIDE Analysis)

| Threat Category | Target Boundary | Specific Attack Vector | SynapseState Architectural Mitigation |
| --- | --- | --- | --- |
| **Spoofing** | Operator to Control Plane | Unauthorized actor submits an emergency override to disable authentication or safety checks. | Mandatory OIDC JWT verification. Production leases require dual-control authorization: two independent Ed25519 signatures (issuer and approver) validated directly against a trusted public key set. |
| **Tampering** | Control Plane to Agent | Intermediary network hop modifies configuration deltas or injects forced variants. | Deltas and emergency leases are serialized using RFC 8785 (JSON Canonicalization Scheme) and signed with Ed25519. Agents verify signatures locally against a public-key `ConfigMap`. |
| **Repudiation** | Emergency Override Actions | An operator denies triggering an operational kill switch during an outage. | Signed lease envelopes contain immutable operator IDs, approver IDs, nonces, and incident ticket references. Records are written to an append-only PostgreSQL ledger with revoked `UPDATE`/`DELETE` grants. |
| **Information Disclosure** | Workload Process Context | User IDs, email addresses, and demographic attributes leak upstream during evaluation. | Targeting context never leaves the local process memory. SDKs perform all rule evaluations and MurmurHash3 bucketing locally. Telemetry exports only aggregated counters (`key`, `variant`, `reason`). |
| **Tampering / Corruption** | Workload Container to Agent | Compromised application process attempts to overwrite or corrupt the shared-memory arena. | The shared tmpfs volume is mounted with `readOnly: true` in the application container. The Linux kernel enforces memory protection via `mmap(PROT_READ)` and returns `EROFS` on write attempts. |
| **Elevation of Privilege** | Code Remediation Worker | Malicious repository injection or CI container breakout via automated code cleanup. | The purger executes no build scripts, runs no containers, and requests no CI privileges. It uses scoped Git credentials to submit Draft Pull Requests, leaving verification to the repository's native CI. |

---

## 5. Data Plane: Zero-Copy Shared Memory Engine & Safe Reader Contract

### 5.1 Memory Layout, Inode Preservation & Atomic File Replacement

The shared-memory data plane uses a memory-backed volume (`emptyDir: { medium: Memory }`) mounted at `/synapse` in the Pod:

* **Agent Permissions:** Read-Write (`readOnly: false`), running under dedicated UID `10001`.
* **Application Permissions:** Read-Only (`readOnly: true`), running under dedicated UID `10002`.

To eliminate reader/writer races and avoid torn reads, the agent treats all binary arena files as immutable artifacts:

1. The agent compiles the incoming flag configuration into a new generation file: `/synapse/arena.<generation>.bin`.
2. The agent executes an atomic replacement:

$$\text{rename}("/\text{synapse}/\text{arena}.\langle\text{gen}\rangle.\text{bin}", "/\text{synapse}/\text{arena}.\text{bin}")$$


3. Under POSIX filesystem semantics, any application process holding an open file descriptor on the prior `arena.bin` continues reading from that existing inode without interruption.

### 5.2 Safe Reader Contract: Epoch-Based Reclamation & String Lifetimes

Time-based unmap grace periods are unsafe because paused reader threads can trigger `SIGSEGV` if an unmap occurs while memory is being accessed. SynapseState enforces an explicit reader lifecycle protocol:

* **In-Process Reader Registration (Epoch-Based Tracking):**
Workload SDKs maintain an atomic global pointer to the current memory mapping structure:
```go
type ArenaMapping struct {
    generation uint64
    data       []byte
    refCount   int64
    unmapped   uint32
}

```


Before evaluating a flag, the reader executes an atomic acquire on the active `ArenaMapping` pointer and increments `refCount`. Upon evaluation completion, the reader decrements `refCount`.
* **Resource Reclamation Protocol:**
When the SDK detects a new `arena.bin` via `inotify` (with a 25ms timer fallback):
1. The SDK maps the new generation via `mmap(PROT_READ)` and atomically updates the active pointer.
2. The previous mapping is marked as superseded.
3. When the previous mapping's `refCount` reaches zero, the SDK safely unmaps the memory segment (`munmap`).
4. The sidecar agent maintains at most two historical generation files on disk before unlinking them.


* **SDK String Lifetime Contract:**
FlatBuffers accessors return string pointers that reference the underlying mapped memory segment.
* *Native Engine Path:* Returns raw byte slices or string views directly, achieving zero allocations on the hot path.
* *Public OpenFeature Path:* Copies string values (variant names and reason codes) when constructing the standard `ResolutionDetails` object. This guarantees that strings returned to user application code remain valid even after an arena generation is unmapped.



### 5.3 Memory Budgeting & Update Coalescing

* **tmpfs Allocation Formula:**
Memory-backed `emptyDir` volumes are charged to the cgroup of the writing process (the agent). The volume quota is defined as:

$$\text{sizeLimit} = (1 + G_{\text{retained}}) \times S_{\text{arena}}$$



With $G_{\text{retained}} = 2$ and a maximum arena size $S_{\text{arena}} = 16\text{ MB}$, the volume limit is set to:

$$\text{sizeLimit} = (1 + 2) \times 16\text{ MB} = 48\text{ MB}$$


* **Update Coalescing Window:**
To prevent memory pressure during rapid Git updates, the agent coalesces non-emergency updates within a configurable 25ms batching window. Emergency leases bypass this window and trigger immediate compilation.

---

## 6. Emergency Override & Lease State Machine

### 6.1 Dual-Control Cryptographic Lease Envelope

Emergency leases represent authoritative overrides and must be cryptographically verifiable by agents even during total upstream network partitions.

```typescript
interface CanonicalEmergencyLease {
  version: 1;
  leaseId: string;
  issuedAt: number;              // Epoch milliseconds
  expiresAt: number;             // Epoch milliseconds
  environment: string;
  clusterId: string;
  flagKey: string;
  forcedVariant: string;
  baseGeneration: number;
  nonce: string;                 // Hex-encoded 128-bit random value
  keyId: string;                 // Matches active public key identifier
  operatorId: string;            // Opaque principal UUID
  approverId: string;            // Independent approving SRE UUID
  incidentTicketRef: string;     // e.g., "INC-88912"
  convergenceMode: 'AUTO_PR_CONVERGENCE' | 'HOLD_SAFE_STATIC';
  onLeaseExpiry: 'REVERT_TO_CANONICAL' | 'HOLD_SAFE_STATIC';
  holdSafeVariant?: string;
  issuerSignature: string;       // Ed25519 signature over RFC 8785 canonical bytes
  approverSignature: string;     // Ed25519 signature by independent approver
}

```

### 6.2 Local Expiration & Anti-Rollback Verification

1. **Anti-Rollback Enforcement:** Agents track the highest observed generation and lease sequence. Any payload with a generation lower than the currently active generation is rejected.
2. **Monotonic Expiration Deadlines:** To defend against NTP steps and clock skew, the agent converts wall-clock timestamps into a local monotonic deadline upon receiving the lease:

$$\text{Duration} = \max(0, \text{expiresAt} - \text{issuedAt})$$


$$\text{Deadline}_{\text{mono}} = \text{Clock}_{\text{mono}} + \text{Duration}$$



If local wall-clock time differs from `issuedAt` by more than $\pm 5\text{ seconds}$ at receipt, an alert is raised while the monotonic deadline continues to run.
3. **Revocation Support:** Active leases can be terminated ahead of schedule using a signed revocation tombstone containing the original `leaseId` and a cryptographically verified `REVOKED` state flag.

### 6.3 Lifecycle State Machine

* **LEASE_ACTIVE:** The signed override is verified and actively served from shared memory.
* **PR_CREATED:** The automated convergence worker branches from `base_sha` and opens a Pull Request against the Git baseline.
* **PR_MERGED:** The Pull Request is merged into the Git repository.
* **RECONCILED:** ArgoCD or Flux applies the new configuration, and the agent acknowledges an updated generation that contains the merged variant. The lease is retired without flap windows.
* **EXPIRING_SOON:** The lease is within 15 minutes of expiration without a merged PR. Escalation alerts are dispatched via Alertmanager.
* **LEASE_EXPIRED:** The monotonic deadline is reached. The agent executes the configured `onLeaseExpiry` directive (`REVERT_TO_CANONICAL` or `HOLD_SAFE_STATIC`).
* **REVOKED:** A verified revocation tombstone is received, returning the flag to baseline immediately.
* **PR_CONFLICT / PR_CREATE_FAILED:** Automated convergence encountered a merge conflict or Git API failure. The override remains in `LEASE_ACTIVE` while alerting platform operators.

### 6.4 GitOps Engine Compatibility

To prevent GitOps reconcilers from pruning active emergency overrides, resources apply explicit metadata annotations:

* **ArgoCD Protection:** Configured with `Prune=false` to prevent resource deletion during Git sync operations:


```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-options: Prune=false
    argocd.argoproj.io/compare-options: IgnoreExtraneous

```


* **Flux v2 Protection:** Configured with `prune: disabled` to preserve the resource across reconciliation passes:
```yaml
metadata:
  annotations:
    kustomize.toolkit.fluxcd.io/prune: disabled

```



### 6.5 Break-Glass Execution Path

If the control plane or PostgreSQL becomes unavailable during an infrastructure outage, operators can apply overrides directly using the Kubernetes API:

```bash
synapse emergency-lease create --break-glass \
  --flag=payment-rail \
  --variant=off \
  --ttl=1h \
  --issuer-key=./sre-key.pem \
  --approver-key=./lead-key.pem \
  | kubectl apply -f -

```

Sidecar agents watch cluster `EmergencyLease` resources directly as a secondary fallback, verifying Ed25519 signatures and applying updates to `/synapse/arena.bin` without control plane dependencies.

---

## 7. FlatBuffers Binary Schema & Conformance Engine

### 7.1 Schema Definition (`schema/arena.fbs`)

```protobuf
namespace Synapse.Buffer;

enum FlagType : byte { Release = 0, Operational = 1, Experiment = 2, Permission = 3 }
enum EvaluationType : byte { Boolean = 0, String = 1, Int = 2, Float = 3, JSON = 4 }
enum Operator : byte { Equals = 0, NotEquals = 1, In = 2, NotIn = 3, GreaterThan = 4, LessThan = 5, SemverGte = 6 }
enum ExpiryPolicy : byte { RevertToCanonical = 0, HoldSafeStatic = 1 }

table TypedValue {
  string_val: string;
  int_val: int64;
  float_val: float64;
  bool_val: bool;
  json_val: string;
}

table Variant {
  name: string (key);
  value: TypedValue;
}

table TargetingRule {
  priority: uint16;
  attribute_name: string;
  op: Operator;
  match_values: [string];
  serve_variant: string;
}

table RolloutSplit {
  variant_name: string;
  weight_basis_points: uint16; // 0 to 10,000; sum across splits must equal 10,000
}

table RolloutConfig {
  splits: [RolloutSplit];
  stickiness_attribute: string;
  seed: uint32;
}

table EmergencyOverride {
  is_active: bool;
  forced_variant: string;
  lease_id: string;
  expires_at_epoch_ms: uint64;
  on_lease_expiry: ExpiryPolicy;
  hold_safe_variant: string;
  nonce: string;
}

table FlagRecord {
  key_name: string (key); // Primary lexicographical search key
  key_hash: uint64;       // 64-bit FNV-1a hash for fast index filtering
  flag_type: FlagType;
  evaluation_type: EvaluationType;
  is_enabled: bool;
  default_variant: string;
  off_variant: string;
  variants: [Variant];
  rollout: RolloutConfig;
  rules: [TargetingRule];
  override: EmergencyOverride;
}

table FlagArena {
  generation: uint64;
  schema_version: uint16;
  project_id: string;
  flags: [FlagRecord];
}

root_type FlagArena;

```

### 7.2 Evaluation Flow & Deterministic Bucketing

Rule evaluation follows a deterministic execution order:

1. **Record Lookup:** The SDK executes a binary search over `FlagArena.flags` matching `key_name`. If the key is not found, the SDK returns the application fallback with reason `DEFAULT`.
2. **Emergency Override Check:** If `override.is_active == true`, the SDK validates the local monotonic expiration deadline. If the lease is valid, it immediately returns `override.forced_variant` with reason `EMERGENCY_OVERRIDE`.
3. **Enabled Check:** If `is_enabled == false`, the SDK returns `off_variant` with reason `DISABLED`.
4. **Targeting Rules Evaluation:** Rules are evaluated in ascending order by `priority`. If an attribute is missing or exhibits a type mismatch, the rule is marked non-matching. If a rule matches, its `serve_variant` is returned with reason `TARGETING_MATCH`.
5. **Percentage Rollout Resolution:** If no targeted rule matches, the SDK resolves rollout splits using MurmurHash3 bucketing:

$$\text{HashInput} = \text{key\_name} + ":" + \text{AttributeValue} + ":" + \text{uint32ToString}(\text{seed})$$


$$\text{Bucket} = \text{uint32}(\text{Murmur3\_32}(\text{HashInput})) \pmod{10000}$$



The SDK iterates through `rollout.splits`, accumulating `weight_basis_points`. The first split where the cumulative weight exceeds `Bucket` is returned with reason `SPLIT`.
6. **Default Fallback:** If splits are unconfigured, `default_variant` is returned with reason `STATIC`.

---

## 8. Autonomous Code Remediation: Quiescence Index & Safe AST Pruning

### 8.1 Mathematical Definition of the Quiescence Index ($Q$)

A feature flag is eligible for automated removal only when it demonstrates statistical invariance across all production environments over a full observation window ($\tau \ge 30\text{ days}$).

Let $\mathcal{E}(f, \tau)$ be the complete set of evaluation events recorded for flag $f$ during time window $\tau$. The valid evaluation set is defined as:


$$\mathcal{E}_{\text{valid}}(f, \tau) = \{e \in \mathcal{E}(f, \tau) \mid \text{reason}(e) \in \mathcal{R}_{\text{valid}}\}$$


Where:

$$\mathcal{R}_{\text{valid}} = \{\text{"static"}, \text{"split"}, \text{"targeting\_match"}, \text{"disabled"}\}$$

Evaluations returning error states or operational overrides are tracked in an invalidation set:


$$\mathcal{E}_{\text{invalid}}(f, \tau) = \{e \in \mathcal{E}(f, \tau) \mid \text{reason}(e) \in \{\text{"default"}, \text{"error"}, \text{"emergency\_override"}\}\}$$

The Quiescence Index $Q(f, \tau)$ is defined as:


$$Q(f, \tau) = \frac{\sum_{e \in \mathcal{E}_{\text{valid}}(f, \tau)} \mathbb{I}(\text{variant}(e) = v_{\text{dominant}})}{\vert{}\mathcal{E}_{\text{valid}}(f, \tau)\vert{}}$$

### 8.2 Candidate Qualification Criteria

A flag is classified as `STALE_CANDIDATE` if and only if all of the following conditions hold simultaneously:

* **Taxonomy Eligibility:** The flag's declared type is `release` or `experiment`. Flags marked `operational` or `permission` are permanently excluded.
* **Complete Invariance:** $Q(f, \tau) = 1.0$ continuously across the entire observation window ($\tau \ge 30\text{ days}$).
* **Minimum Traffic Volume:** Total valid evaluations satisfy $\vert{}\mathcal{E}_{\text{valid}}(f, \tau)\vert{} \ge 100,000$.
* **Error Rate Ceiling:** Degraded evaluations must not exceed 1% of total traffic:

$$\frac{\vert{}\mathcal{E}_{\text{invalid}}(f, \tau)\vert{}}{\vert{}\mathcal{E}(f, \tau)\vert{}} \le 0.01$$


* **Multi-Cluster Invariance:** The flag evaluates to the identical $v_{\text{dominant}}$ variant across 100% of reporting clusters and regions.
* **Absence of Overrides:** Zero emergency lease activations occurred during window $\tau$.

### 8.3 Two-Phase Safe Deletion Pipeline

To prevent regressions in rollbacks, canaries, or long-running worker pods, code removal is separated into two decoupled phases:

* **Phase 1: Source Code Pruning (Draft PR):**
* The remediation worker scans repository source trees using semantic analyzers: `ts-morph` for TypeScript and `go/packages` + `go/types` for Go.
* Supported syntax patterns: Direct OpenFeature client calls (`client.GetBooleanValue("key", ...)`), conditional `if/else` blocks, and ternary expressions where the flag key is a string literal.
* Dynamic flag keys (e.g., `client.GetBooleanValue(computedKey)`), reflection wrappers, and cross-repository dependencies are detected, logged, and skipped.
* The engine inlines the winning execution path, removes dead conditional branches, cleans up unused imports, and removes flag-specific test files.
* The worker submits a **Draft Pull Request** containing evaluation telemetry proofs. Automatic merging is prohibited; human review and standard repository CI checks are required.


* **Phase 2: Configuration Pruning:**
* Once the Phase 1 PR is merged and deployed, the control plane enters a 7-day observation period.
* The flag definition is removed from Git via an automated PR only after evaluation counters for the flag drop to exactly zero across all production pods.



---

## 9. Kubernetes Integration, Cold Starts & Operational Reliability

### 9.1 Deterministic Pod Startup Order

To prevent cold-starting application containers from serving default values during control plane outages, SynapseState uses Kubernetes 1.29+ Native Sidecar Containers:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  template:
    spec:
      volumes:
        - name: synapse-shm
          emptyDir:
            medium: Memory
            sizeLimit: 48Mi
      initContainers:
        - name: synapse-agent
          image: synapsestate/agent:v1.2.0
          restartPolicy: Always # Declares container as a native Kubernetes sidecar
          volumeMounts:
            - name: synapse-shm
              mountPath: /synapse
              readOnly: false
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
            - name: synapse-shm
              mountPath: /synapse
              readOnly: true

```

Under Kubernetes native sidecar semantics, the application container does not start until the `synapse-agent` sidecar's startup probe passes.

### 9.2 Probe Isolation & Offline Resilience

* **Liveness Probe (`/healthz` on Port 9091):** Monitors agent internal process health only. Does not check upstream database or control plane connectivity. If upstream systems fail, the agent remains alive and continues serving current shared memory.
* **Readiness Probe (`/readyz` on Port 9091):** Returns HTTP 200 only when a valid, verified `arena.bin` file is mapped in `/synapse`.
* **Cold-Start Fallback Snapshot:** If a newly scheduled pod starts during a total control-plane outage, the agent loads a cryptographically signed bootstrap snapshot from a cluster-local ConfigMap (`synapse-bootstrap-<project>`), populates `/synapse/arena.bin`, and allows the workload to start without upstream connectivity.

### 9.3 Admission Safety & Mass Deletion Guards

* **Validating Webhook:** Enforces that single `FeatureFlagGroup` manifests do not exceed 1 MiB. Rejects any GitOps reconciliation that attempts to delete more than 20% of active flags in a single commit unless explicitly annotated with `synapse.io/allow-mass-deletion: true`.
* **Resource Conflict Resolution:** Flag keys are scoped hierarchically: `<project>.<group>.<flagKey>`. Cross-group key collisions are rejected during webhook validation.
* **`inotify` Limit Defense:** If host OS `inotify` watches are exhausted (`ENOSPC` or `EMFILE`), SDKs fall back to 25ms timer-based filesystem polling.

---

## 10. Service Level Objectives (SLOs) & Benchmark Methodology

### 10.1 System Performance SLOs

| Measurement Boundary | Target Metric | Evaluation Conditions & Environmental Constraints |
| --- | --- | --- |
| **Native Go Engine** | p99 $\le 0.8\text{ \mu s}$ | Direct pointer dereference and Murmur3 bucketing. Zero heap allocations. AWS `c6i.metal`, 8 pinned cores. |
| **Public Go SDK (OpenFeature)** | p99 $\le 2.0\text{ \mu s}$ | Complete OpenFeature evaluation path including `ResolutionDetails` object allocation. |
| **Public Node.js SDK (OpenFeature)** | p99 $\le 5.0\text{ \mu s}$ | Complete evaluation path crossing the native N-API boundary (`napi-rs`), warm V8 optimization. |
| **Intra-Cluster EEL Propagation** | p99 $\le 50\text{ ms}$ | Time from control-plane API acceptance to verified memory swap across $\ge 99\%$ of pods in a 100-pod cluster. |
| **Straggler Pod Detection** | Max $\le 10\text{ s}$ | Maximum time to detect and raise alerts for any non-acknowledging pod following an emergency override dispatch. |

### 10.2 Benchmark Methodology

* **Instrumentation Overhead Correction:** Benchmarks use batched evaluations (10,000 iterations per timing capture) and HDR Histogram logging to eliminate per-call timing overhead.
* **Invariant Stress Verification:** Write-storm benchmarks execute 100 arena swaps per second under 500,000 concurrent evaluation requests per second. Every record in generation $N$ encodes its generation ID; readers continuously verify that values match the expected generation sequence to confirm zero torn reads or use-after-unmap faults.

---

## 11. Technology Stack, Directory Layout & Delivery Roadmap

### 11.1 Monorepo Structure

* `cmd/`
* `synapse-control/`: Go control plane daemon; handles gRPC streaming, CRD sync, and Ed25519 signing.
* `synapse-operator/`: Kubernetes controller built with Controller-Runtime; reconciles `FeatureFlagGroup` CRDs.
* `synapse-agent/`: Lightweight Go sidecar daemon; manages binary compilation and atomic file swaps.
* `synapse-cli/`: SRE administrative tool; handles dual-control override signing and break-glass workflows.
* `synapse-purger/`: Quiescence engine and AST refactoring tool using `go/types` and `ts-morph`.


* `pkg/`
* `apis/`: Kubernetes CustomResourceDefinition structs and OpenAPI validation schemas.
* `buffer/`: Canonical FlatBuffers schemas (`schema/arena.fbs`) and generated Go bindings.
* `crypto/`: Ed25519 signing, verification, and RFC 8785 canonicalization utilities.
* `engine/`: Zero-copy rule evaluation and unsigned 32-bit MurmurHash3 bucketing logic.


* `sdk/`
* `go/`: OpenFeature Go Provider reading `/synapse/arena.bin` via `golang.org/x/sys/unix`.
* `node/`: OpenFeature Node.js Provider wrapping a Rust native addon via `napi-rs`.


* `deploy/`
* `manifests/`: Base CRD manifests (`FeatureFlagGroup`, `EmergencyLease`).
* `helm/`: Helm deployment charts for control plane, PostgreSQL, and sidecar mutating webhooks.


* `tests/`
* `conformance/`: Cross-runtime test vectors verifying identical evaluation outcomes.
* `chaos/`: Failure injection suites testing memory unmaps, network partitions, and pod crash lifecycles.
* `fixtures/`: Corpus of test repositories containing standard OpenFeature patterns for AST validation.



### 11.2 Phased Delivery Roadmap

* **Phase 1: Vertical Slice Data Plane (Weeks 1 to 6):**
* Core FlatBuffers schema compiler, epoch/refcount reader reclamation, and atomic file swap engine.
* Go OpenFeature SDK with zero hot-path allocations on native pointer dereferences.
* Cross-runtime test vectors and benchmark validation on bare-metal hardware.


* **Phase 2: Emergency Overrides & Control Plane (Weeks 7 to 12):**
* Control plane API with PostgreSQL persistence, gRPC delta streaming, and PostgreSQL `LISTEN`/`NOTIFY`.
* Dual-control Ed25519 signing pipeline, local monotonic expiration enforcement, and break-glass CLI workflows.
* Fleet acknowledgment tracking with straggler pod detection.


* **Phase 3: Kubernetes Operator & Node.js Native SDK (Weeks 13 to 18):**
* Controller-Runtime operator reconciling sharded `FeatureFlagGroup` Custom Resources.
* Mutating webhook for automated native sidecar injection and tmpfs volume mounting.
* Node.js OpenFeature SDK utilizing `napi-rs` with prebuilt binaries for Linux x64 and arm64.


* **Phase 4: Telemetry Ingestion & Autonomous Code Pruning (Weeks 19 to 24):**
* OpenTelemetry evaluation metric ingestion pipeline tracking standardized semantic conventions.
* Quiescence Index ($Q$) engine with error-rate ceilings, multi-cluster invariance, and demo replay tooling.
* AST pruning engine (`ts-morph` and `go/types`) generating verified Draft Pull Requests against the fixture corpus.