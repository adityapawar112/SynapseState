# AGENTS.md — SynapseState Engineering Charter & Operating Guide

> **Target Audience:** All AI agents, pair programmers, and human contributors operating in `synapsestate/synapsestate`.
> **Primary Specification:** [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) & [PRODUCT.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/PRODUCT.md)

---

## 1. Project Mission & Non-Goals

SynapseState delivers a self-hosted, distributed runtime configuration and feature flag platform optimized for high-throughput, latency-critical microservices running in Kubernetes clusters.

### Core Non-Goals (Hard System Boundaries)
- **NO Client-Side / Web / Mobile:** Internal rulesets never egress to untrusted browsers or devices.
- **NO Web Administrative UI:** Operations are strictly declarative (GitOps via CRDs) and operational via `synapse-cli`.
- **NO Per-Evaluation Socket Calls:** Application SDKs never make network or socket roundtrips to evaluate a flag.
- **NO Unverified Autonomous Merges:** Automated code remediation (`synapse-purger`) submits Draft PRs verified by compiler checks and repository tests.

---

## 2. Architectural Invariants & Commandments

Every code modification and pull request MUST adhere to these non-negotiable invariants:

1. **Zero-Hop Hot Path:** The evaluation path in the native Go engine and TypeScript SDK must evaluate directly from language-native memory with atomic reference swaps. **Zero network syscalls** on steady-state evaluations.
2. **In-Pod Sidecar Multiplexing:** The `synapse-agent` sidecar maintains the sole upstream connection per pod and pushes delta updates over local IPC only when configurations change.
3. **Immutable Snapshot Swaps & Runtime GC:** Never mutate active ruleset objects in place. All updates compile into an immutable snapshot and swap atomically. Superseded snapshots are reclaimed by the language runtime's garbage collector. Zero manual memory unmapping.
4. **Strict Source-of-Truth Hierarchy:**
   $$\text{Git Baseline} \longrightarrow \text{K8s CRDs} \longrightarrow \text{PostgreSQL Ledger} \longrightarrow \text{gRPC Streaming} \longrightarrow \text{Local IPC Stream} \longrightarrow \text{In-Process Heap}$$
5. **Tiered Cryptographic Leases:** Immediate break-glass overrides require one Ed25519 signature with a mandatory 30-minute expiration. Permanent overrides require dual-control authorization (issuer + approver) or an automated Git merge.
6. **Boundary Discipline:** Isolate all input validation, sanitization, and parsing at system boundaries (K8s Admission Webhook, CLI flags, gRPC endpoints). Internal engine functions must remain pure.

---

## 3. Monorepo Structure

```
.
├── cmd/
│   ├── synapse-control/     # Go control plane daemon (gRPC stream, PostgreSQL ledger, CRD sync)
│   ├── synapse-operator/    # K8s Controller-Runtime operator (FeatureFlagGroup, mutating webhook)
│   ├── synapse-agent/       # Go sidecar daemon (pod multiplexer, local UDS streaming, disk snapshot)
│   ├── synapse-cli/         # SRE CLI (Ed25519 break-glass signing, lease management)
│   └── synapse-purger/      # Quiescence engine & AST refactoring tool (go/types, ts-morph)
├── pkg/
│   ├── apis/                # Kubernetes CRD structs and OpenAPI validation schemas
│   ├── protocol/            # Protobuf delta schemas & generated Go/TypeScript bindings
│   ├── crypto/              # Ed25519 signing, RFC 8785 canonicalization
│   └── engine/              # In-process rule evaluation & MurmurHash3 unsigned 32-bit bucketing
├── sdk/
│   ├── go/                  # OpenFeature Go Provider with atomic pointer swaps
│   └── node/                # Pure TypeScript OpenFeature Node.js Provider
├── deploy/
│   ├── manifests/           # Base CRD manifests (FeatureFlagGroup, EmergencyLease)
│   └── helm/                # Production Helm charts
├── tests/
│   ├── conformance/         # Cross-runtime test vectors (Go vs Node.js)
│   ├── chaos/               # Fault injection (network partitions, sidecar crashes, reconnect loops)
│   └── fixtures/            # Test repositories for AST pruning validation
└── docs/
    ├── ARCHITECTURE.md      # Authoritative system architecture
    ├── ROADMAP.md           # Phased Wayfinder delivery roadmap
    └── adr/                 # Architectural Decision Records
```

---

## 4. Active Skills & Agent Workflows

The workspace is configured with active skills located in [`.agents/skills/`](file:///c:/Users/adity/Desktop/Projects/SynapseState/.agents/skills):

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
| **Native Go Engine** | $p99 \le 0.5\text{ µs}$ | Direct in-memory lookup, 0 heap allocs on evaluation |
| **Public Go OpenFeature SDK** | $p99 \le 1.0\text{ µs}$ | Includes `ResolutionDetails` allocation |
| **Public Node.js OpenFeature SDK** | $p99 \le 1.0\text{ µs}$ | Pure V8 in-memory lookup, zero FFI overhead |
| **Intra-Cluster EEL Propagation** | $p99 \le 50\text{ ms}$ | API acceptance to verified memory swap across $\ge 99\%$ of 100 pods |
| **Straggler Pod Detection** | $\text{Max} \le 10\text{ s}$ | Alerting non-acknowledging pods |

---

## 6. Git & Commit Guidelines

- **Format:** Conventional Commits (`feat(engine): ...`, `fix(agent): ...`, `perf(protocol): ...`, `docs: ...`).
- **Tracer Bullets:** Every commit and PR must leave the repository in a compile-clean, green-test state.
- **Evidence Before Claims:** Always run tests and benchmarks, pasting raw outputs in PR descriptions.
