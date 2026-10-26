# 0. Record of Pre-Pivot Architectural Rejections

Date: 2026-10-06  
Status: Accepted (Historical Reference)

---

## Context

Prior to standardizing on the OpenFeature governance model, early design iterations of SynapseState explored four high-performance, low-level data plane architectures:

1. **POSIX Shared Memory (`mmap` + FlatBuffers):** Mapping binary configuration state from `/dev/shm` directly into application processes to achieve 15–45ns evaluation benchmarks.
2. **In-Pod Sidecar Daemons (`synapse-agent`) & Unix Domain Sockets (UDS):** Running a Go sidecar injected via Kubernetes mutating admission webhooks, streaming updates over `/var/run/synapse/synapse.sock`.
3. **Custom Evaluation Engine & Rollout DSL:** Re-implementing targeting rules, user context matchers, and MurmurHash3 percentage rollouts in both Go and TypeScript.
4. **Custom Concurrency Primitives:** Manual epoch-based memory reclamation and custom lock-free atomic pointer swappers.

---

## Decision

We formally rejected all four architectures across the initial pivot:

1. **Rejection of Shared Memory (`mmap`):**
   - _FFI Overhead:_ In Node.js, crossing the Foreign Function Interface (N-API) adds 30–60ns per call, making FFI reads 2× to 4× slower than a native V8 JavaScript Map lookup (10–25ns).
   - _Process Crash Hazards:_ Truncation, bad offsets, or unmap race conditions trigger uncatchable hardware signals (`SIGSEGV`, `SIGBUS`) that crash application containers immediately.
   - _Native Toolchain Friction:_ Required native C toolchains (`node-gyp`), platform-specific binaries, and memory-backed tmpfs volume configuration.
2. **Rejection of In-Pod Sidecar Daemons & UDS:**
   - _Operational Friction:_ Mutating admission webhooks are notoriously difficult to configure, debug, and secure in enterprise Kubernetes clusters.
   - _Resource Waste:_ Sidecars add memory overhead per pod, startup delays, and readiness probe coordination complexity.
   - _Cross-Platform Incompatibility:_ Sockets required named pipe fallbacks and platform-specific client libraries on Windows developer machines.
   - _SLO Reality:_ The target propagation latency (p95 ≤ 10 s) does not require sub-millisecond local Unix socket streaming.
3. **Rejection of Custom Flag Evaluation:**
   - Re-implementing flag evaluation adds zero novel value: mature evaluation engines already exist in the CNCF OpenFeature ecosystem (flagd, Unleash, Flipt).
   - SynapseState's unique value is incident safety (signed, auto-expiring emergency overrides) and lifecycle governance (evidence-driven flag retirement).
4. **Rejection of Polyglot Toolchains:**
   - Maintaining parallel codebases in Go and TypeScript created disproportionate CI/CD, testing, and serialization overhead for a focused team.

---

## Consequences

### Positive

- 100% memory-safe user space: completely eliminates process-level crash signals (`SIGSEGV`, `SIGBUS`).
- Zero mutating webhooks, zero sidecars, zero intra-pod socket volumes.
- Vendor-neutral integration via OpenFeature standards.
- Pure TypeScript / Node.js codebase with zero native C compilation dependencies.

### Negative

- Flag evaluation latency is bounded by the delegate OpenFeature provider plus wrapper lookup overhead.
