# Product overview: SynapseState

SynapseState is a self-hosted runtime configuration and feature flag platform for high-throughput, latency-critical microservices running on Kubernetes.

It replaces network-hop sidecar queries and uncoordinated SaaS streaming connections with a sidecar-multiplexed in-process evaluation engine. Flag evaluation runs in 10 to 25 nanoseconds in Node.js and under 0.5 microseconds in Go, with zero network syscalls on the evaluation path and zero native compilation dependencies.

## The problem

Modern feature management platforms force platform engineering teams into severe trade-offs:

1. **Networked sidecars add unacceptable latency.** Systems like flagd or Flipt loopback sidecars evaluate flags over local Unix domain sockets or HTTP/gRPC on every check. Each evaluation costs between 150 and 400 microseconds. For a service evaluating 50 flags per incoming request, flag checks alone add 7 to 20 milliseconds of latency to every transaction.
2. **Direct SaaS streaming multiplies outbound connections and egress.** Platforms like LaunchDarkly and Unleash require every application worker to maintain long-lived outbound connections to external servers. When a Kubernetes node runs 30 microservice pods across multiple worker processes, hundreds of independent connections flood cluster egress. Updates trigger uncoordinated deserialization and garbage collection churn across all runtimes simultaneously.
3. **Emergency rollbacks take minutes in GitOps.** When a feature causes an outage, reverting the flag through standard GitOps pull requests takes 3 to 10 minutes while CI and deployment pipelines run.
4. **Direct UI overrides create GitOps drift.** SaaS platforms let operators flip flags in a web UI within seconds, but those changes bypass Git. The live cluster diverges from the committed configuration repository, creating silent configuration drift.
5. **Stale flags turn codebases into technical debt.** Feature flags often outlive their lifecycle. Teams rarely prioritize removing old boolean branches, which leads to dead code paths and unpredictable test matrix explosion.

## The SynapseState solution

SynapseState separates configuration delivery from configuration evaluation:

* **Sidecar-multiplexed in-process data plane.** A Kubernetes native sidecar (`synapse-agent`) runs in each pod. It maintains a single mTLS gRPC connection to the cluster control plane, receives binary delta updates, and streams diffs to application SDKs over a local Unix domain socket only when configurations change. Application SDKs store the ruleset directly in language-native heap memory (JavaScript V8 objects in Node.js, native memory in Go). Evaluations run completely in-process with zero network syscalls, zero native C/Rust FFI dependencies, and zero crash hazards.
* **Tiered emergency leases.** Operators can force a flag variant across an entire Kubernetes cluster in under 30 seconds using signed break-glass leases. A single authorized SRE can apply an immediate 30-minute override to stop an active outage. Promoting the lease to a permanent override requires an independent secondary signature or an automated Git merge, preventing coordination bottlenecks during late-night incidents.
* **Automated GitOps reconciliation.** When an emergency lease takes effect, the control plane opens an automated pull request against the authoritative Git repository. The temporary override automatically expires once the Git baseline merges and rolls out.
* **Guarded code pruning via Quiescence index ($Q$).** SynapseState tracks flag evaluation telemetry. When a release flag shows 100% invariance ($Q = 1.0$) across all production clusters for 30 consecutive days with over 100,000 evaluations, the system triggers `synapse-purger`. The purger validates that the flag is a temporary release toggle (ignoring permanent operational kill switches), verifies TypeScript compiler type narrowing, runs the repository unit test suite, and opens a verified Draft Pull Request.

## User personas

| Persona | Primary goal | How SynapseState solves it |
|---|---|---|
| **Platform / SRE engineer** | Maintain cluster reliability, sub-microsecond evaluation latency, and strict GitOps audit trails. | Eliminates network-hop latency from feature flags, provides single-operator break-glass switches with short TTL, and back-syncs overrides to Git. |
| **Microservice developer** | Ship features behind flags without adding latency, memory overhead, or dead code. | Evaluates flags through standard OpenFeature SDKs with 10 to 25 nanosecond latency in pure TypeScript and Go, knowing stale flags will be safely cleaned up from the codebase. |
| **Security & compliance auditor** | Verify that no production overrides bypass review and that customer data never leaves the cluster. | Guarantees zero context egress outside process memory, enforces cryptographic signatures and short TTLs on break-glass overrides, and maintains an append-only PostgreSQL ledger. |

## Competitive positioning

| Capability | flagd / OpenFeature Operator | Flipt (Git mode) | LaunchDarkly Enterprise | Unleash (Self-hosted OSS) | SynapseState |
|---|---|---|---|---|---|
| **Data plane IPC** | Localhost TCP or Unix domain socket per evaluation | Loopback HTTP or gRPC per evaluation | Direct outbound SaaS stream to in-process SDK cache | Direct outbound SaaS stream to in-process SDK cache | Local sidecar delta stream on change; in-process heap evaluation on check |
| **P99 latency (Node.js)** | 200 to 1,500 µs (Socket IPC) | 700 to 3,000 µs (HTTP IPC) | 10 to 30 ns (In-process V8 heap) | 10 to 30 ns (In-process V8 heap) | **10 to 25 ns (In-process V8 heap, zero FFI)** |
| **P99 latency (Go)** | 150 to 800 µs (Socket IPC) | 700 to 2,800 µs (HTTP IPC) | < 1.0 µs (In-process heap) | < 1.0 µs (In-process heap) | **< 0.5 µs (In-process heap, atomic pointer swap)** |
| **Hot-path memory overhead** | Socket buffers and JSON/gRPC serialization per call | Socket buffers and HTTP serialization | Duplicate outbound connections per process | Duplicate outbound connections per process | One sidecar connection per pod; lightweight in-process heap cache (1 to 5 MB) |
| **Process crash hazard** | Low (Socket timeouts) | Low (HTTP errors) | None (Pure managed runtime) | None (Pure managed runtime) | **None (Pure managed runtime, zero memory-mapping faults)** |
| **Emergency mitigation speed** | Blocked by Kubernetes API sync loop | Blocked by Git commit and CI cycle (3 to 10 min) | Web UI toggle (Immediate; bypasses Git) | Web UI toggle (Immediate; bypasses Git) | **< 30 seconds via signed break-glass lease; dual-control promotion** |
| **GitOps drift defense** | Kubernetes CRD authoritative | Git authoritative | Not GitOps-native (SaaS DB authoritative) | Not GitOps-native (Database authoritative) | **Git authoritative with cryptographic lease overlays and automated PR back-sync** |
| **Code cleanup automation** | None | None | Stale markers in UI; manual removal required | Stale markers in UI; manual removal required | **Guarded AST pruning with compiler type checks and test validation** |
| **License** | Apache 2.0 | Open Core (Enterprise features closed) | Proprietary commercial SaaS | Unleash Edge OSS reaches EOL Dec 31, 2026 | **100% Permissive Open Source (Apache 2.0)** |

## System boundaries and non-goals

SynapseState maintains strict engineering boundaries:

* **No client-side or mobile distribution.** Internal targeting rules, user segments, and business heuristics stay inside the server-side cluster.
* **No web administrative UI.** All operations happen declaratively through GitOps and Kubernetes CRDs, or imperatively through the `synapse-cli` binary.
* **No per-evaluation socket IPC.** Unlike proxy sidecars, the application SDK never makes network or socket roundtrips to evaluate a flag.
* **No unverified autonomous code commits.** The code refactoring tool generates Draft Pull Requests after running compiler and test checks. It never merges directly to master branches.
