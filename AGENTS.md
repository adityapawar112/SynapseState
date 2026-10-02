# AGENTS.md — SynapseState Engineering Charter & Operating Guide

> **Target Audience:** All AI agents, pair programmers, and human contributors operating in `synapsestate/synapsestate`.
> **Primary Specification:** [docs/SpecDoc.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/SpecDoc.md) (v1.2.0-GA-SPEC)

---

## 1. Project Mission & Non-Goals

SynapseState delivers a self-hosted, distributed runtime configuration and feature flag platform optimized for high-throughput, latency-critical microservices running in Kubernetes clusters.

### Core Non-Goals (Hard System Boundaries)
- **NO Client-Side / Web / Mobile:** Internal rulesets never egress to untrusted browsers or devices.
- **NO Web Administrative UI:** Operations are strictly declarative (GitOps via CRDs) and operational via `synapse-cli`.
- **NO Serverless / Ephemeral:** Platforms without POSIX `/dev/shm` mounts and daemon lifecycles are out of scope.
- **NO Node-Level DaemonSets:** Sharing memory across pods violates Kubernetes Pod Security Standards.
- **NO In-Engine Container Sandboxing:** Automated code remediation (`synapse-purger`) submits Draft PRs verified by existing CI.

---

## 2. Architectural Invariants & Commandments

Every code modification and pull request MUST adhere to these non-negotiable invariants:

1. **Zero-Copy Hot Path:** The evaluation path in the native Go engine and Rust N-API core must perform direct pointer dereference over mapped FlatBuffers memory. **Zero heap allocations (`0 B/op`)** on steady-state evaluations.
2. **Atomic File Swaps:** Never write or mutate `/synapse/arena.bin` in place. Always compile to `/synapse/arena.<generation>.bin` and swap using atomic POSIX `rename(2)`.
3. **Epoch-Based Reader Reclamation:** Never use time-based unmap grace periods. Readers must atomically acquire and release `ArenaMapping.refCount`. An arena is only unmapped (`munmap`) when its `refCount` drops to zero.
4. **Strict Source-of-Truth Hierarchy:**
   $$\text{Git Baseline} \longrightarrow \text{K8s CRDs} \longrightarrow \text{PostgreSQL Ledger} \longrightarrow \text{gRPC Streaming} \longrightarrow \text{Shared Memory Arena}$$
5. **Dual-Control Cryptographic Leases:** Emergency overrides require two independent Ed25519 signatures (issuer + approver) over RFC 8785 canonical JSON with local monotonic expiration deadlines.
6. **Boundary Discipline:** Isolate all input validation, sanitization, and parsing at system boundaries (K8s Admission Webhook, CLI flags, gRPC endpoints). Internal engine functions must remain pure.

---

## 3. Monorepo Structure

```
.
├── cmd/
│   ├── synapse-control/     # Go control plane daemon (gRPC stream, PostgreSQL ledger, CRD sync)
│   ├── synapse-operator/    # K8s Controller-Runtime operator (FeatureFlagGroup, mutating webhook)
│   ├── synapse-agent/       # Go sidecar daemon (FlatBuffers compilation, atomic rename, inotify)
│   ├── synapse-cli/         # SRE CLI (Ed25519 dual-control signing, break-glass)
│   └── synapse-purger/      # Quiescence engine & AST refactoring tool (go/types, ts-morph)
├── pkg/
│   ├── apis/                # Kubernetes CRD structs and OpenAPI validation schemas
│   ├── buffer/              # FlatBuffers canonical schema (schema/arena.fbs) & generated Go bindings
│   ├── crypto/              # Ed25519 dual-control signing, RFC 8785 canonicalization
│   └── engine/              # Zero-copy rule evaluation & MurmurHash3 unsigned 32-bit bucketing
├── sdk/
│   ├── go/                  # OpenFeature Go Provider reading /synapse/arena.bin via unix.Mmap
│   └── node/                # OpenFeature Node.js Provider wrapping Rust addon via napi-rs
├── deploy/
│   ├── manifests/           # Base CRD manifests (FeatureFlagGroup, EmergencyLease)
│   └── helm/                # Production Helm charts
├── tests/
│   ├── conformance/         # Cross-runtime test vectors (Go vs Node vs Rust)
│   ├── chaos/               # Fault injection (unmap safety, network partitions, crash loops)
│   └── fixtures/            # Test repositories for AST pruning validation
└── docs/
    └── SpecDoc.md           # Authoritative system specification
```

---

## 4. Active Skills & Agent Workflows

The workspace is configured with 29 active skills located in [`.agents/skills/`](file:///c:/Users/adity/Desktop/Projects/SynapseState/.agents/skills):

| Phase / Workflow | Recommended Skills to Invoke |
|---|---|
| **Architecture & Interface Design** | `codebase-design`, `domain-modeling`, `architect`, `principle-foundational-thinking` |
| **Monorepo Planning & Roadmap** | `wayfinder`, `to-tickets`, `research` |
| **Multi-Agent Task Execution** | `subagent-driven-development`, `using-git-worktrees`, `dispatching-parallel-agents` |
| **Implementation & Concurrency** | `test-driven-development`, `principle-separate-before-serializing-shared-state`, `principle-boundary-discipline` |
| **Debugging & Invariant Violations** | `systematic-debugging`, `principle-fix-root-causes`, `blast-radius` |
| **Verification & PR Gatekeeping** | `verification-before-completion`, `receiving-code-review`, `requesting-code-review`, `show-me-your-work` |

---

## 5. Performance SLOs (Benchmark Gates)

All code touching the evaluation path must be validated against continuous benchmarks before merging:

| Boundary | Target SLO | Conditions |
|---|---|---|
| **Native Go Engine** | $p99 \le 0.8\text{ µs}$ | Direct pointer dereference, 0 heap allocs |
| **Public Go OpenFeature SDK** | $p99 \le 2.0\text{ µs}$ | Includes `ResolutionDetails` allocation |
| **Public Node.js OpenFeature SDK** | $p99 \le 5.0\text{ µs}$ | Crossing `napi-rs` boundary |
| **Intra-Cluster EEL Propagation** | $p99 \le 50\text{ ms}$ | API acceptance to verified memory swap across $\ge 99\%$ of 100 pods |
| **Straggler Pod Detection** | $\text{Max} \le 10\text{ s}$ | Alerting non-acknowledging pods |

---

## 6. Git & Commit Guidelines

- **Format:** Conventional Commits (`feat(engine): ...`, `fix(agent): ...`, `perf(buffer): ...`, `docs: ...`).
- **Tracer Bullets:** Every commit and PR must leave the repository in a compile-clean, green-test state.
- **Evidence Before Claims:** Always run tests and benchmarks, pasting raw outputs in PR descriptions.
