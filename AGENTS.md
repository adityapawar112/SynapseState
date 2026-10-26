# AGENTS.md — SynapseState Engineering Charter & Operating Guide

> **Target Audience:** All AI agents, pair programmers, and human contributors operating in `synapsestate/synapsestate`.
> **Primary Specifications:** [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md), [PRODUCT.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/PRODUCT.md) & [docs/limitations.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/limitations.md)

---

## 1. Project Mission & Non-Goals

SynapseState delivers a vendor-neutral **incident-safety and lifecycle governance layer for OpenFeature**. It adds signed, auto-expiring emergency overrides (break-glass leases) that evaluate in-process and reconcile back to Git, and telemetry-driven, compiler-verified cleanup pull requests for dead feature flags.

It does **not** evaluate flags or manage rollouts. It wraps an existing OpenFeature provider (such as flagd in-process, a plain JSON provider, or Unleash).

### Core Non-Goals (Hard System Boundaries)

- **NO Custom Evaluator or Rollout DSL:** We do not write flag evaluation logic, context segmenters, or MurmurHash3 bucketing engines. Evaluation is strictly delegated to standard OpenFeature providers.
- **NO Client-Side / Mobile SDKs:** Internal rulesets, keysets, and telemetry never egress to untrusted browsers or mobile devices.
- **NO Web Administrative Flag Authoring:** Baseline flag configurations are managed declaratively in Git. SynapseState does not provide a UI for editing flag definitions.
- **NO In-Pod Sidecar Daemons or UDS Sockets:** We do not inject sidecar containers or maintain intra-pod Unix domain socket streaming. SDKs poll the Control API directly over HTTPS with `ETag`.
- **NO Unverified Autonomous Code Merges:** Automated code cleanup (`synapse-purger`) submits Draft PRs verified by compiler type-checks (`tsc --noEmit`), linters, and repository test suites. Automatic merging is strictly prohibited.
- **NO Microbenchmark Theater:** We do not market unsubstantiated nanosecond records. We publish only measured wrapper overhead compared against bare delegate providers.

---

## 2. Architectural Invariants & Commandments

Every code modification and pull request MUST adhere to these non-negotiable invariants:

1. **Fail-Safe Hot Path Delegation:** Flag evaluation occurs entirely in-memory within the application process. The `OverrideProvider` checks an in-memory map of active, valid leases. If no lease exists, or if an internal exception occurs, it **must immediately fall back to the delegate OpenFeature provider**. SynapseState must never disrupt application traffic.
2. **Pinned Keyset Trust Root:** SDKs verify Ed25519 signatures against a locally pinned keyset file mounted from Git. **The Control API must never serve or modify the trusted keyset.** Even under total control-plane compromise, an attacker cannot forge emergency overrides.
3. **Deterministic Dual-Clock Expiry:** Overrides enforce both monotonic relative time per process incarnation (`first_seen_mono + ttl_seconds`) and wall-clock absolute bounds (`issued_at + ttl_seconds + SKEW_TOLERANCE`). Overrides are honored for $\le \min(\text{wall\_expiry}, \text{mono\_expiry})$. **Zero leases may survive past their deadline.**
4. **Git Reconciliation as Dual Control:** The 2 AM incident path requires only a single operator signature with a time-limited TTL (default 30 minutes, configurable by policy up to 24 hours). Making an override permanent requires promoting it via `synapse promote`, opening a GitHub PR against Git. **Human review and merge of that PR serves as the mandatory secondary approval.**
5. **Zero-Context Telemetry:** The `TelemetryHook` aggregates only `(flag_key, variant, reason)` tuples and counts in memory. It must **never inspect, capture, or export evaluation context, user IDs, or targeting attributes**.
6. **Read-Only Codebase Scanner:** `synapse-purger` operates as a read-only AST scanner and candidate qualifier. It **must never execute target repository test suites or build scripts** while holding GitHub credentials. If dynamic expressions or silent services block qualification, it emits a structured Refusal Report.
7. **Tamper-Evident Audit Ledger:** All state mutations stage to `audit_pending` and seal asynchronously to a SHA-256 hash-chained PostgreSQL ledger by a single writer. Scheduled tasks sign periodic checkpoints to an immutable external write-once store.
8. **Ecosystem & Library-First Primitive Reuse:** Always prioritize native runtime APIs and established ecosystem primitives (e.g., Node.js `node:crypto`, Fastify ecosystem plugins, OpenFeature standard types) before writing bespoke utilities from scratch.

---

## 3. Monorepo Structure

```
.
├── apps/
│   ├── control-api/        # Node.js + Postgres governance service (HTTP API)
│   ├── dashboard/          # Read-mostly Next.js operations portal with GitHub OAuth & RBAC
│   ├── demo-shop/          # Example microservice app using SDK (fault-injection target)
│   └── purger/             # Read-only TypeScript AST scanner & qualifier (ts-morph)
├── packages/
│   ├── lease/              # Canonicalization (RFC 8785), Ed25519 signing & verification
│   ├── sdk/                # Pure TypeScript OpenFeature OverrideProvider & TelemetryHook
│   ├── cli/                # SRE command-line tool (synapse)
│   └── conformance/        # Language-neutral test vectors (JSON) & test runner
├── deploy/
│   ├── terraform/          # Cloud VM, networking, firewall, DNS, object storage
│   ├── helm/               # Helm charts for Control API, Postgres, Observability
│   └── gitops/             # GitOps deployment manifests (Phase 7)
├── test/
│   └── drills/             # Chaos injection & disaster recovery failure drills
├── load/                   # k6 load-testing scripts
└── docs/
    ├── ARCHITECTURE.md     # Authoritative system architecture
    ├── ROADMAP.md          # Phased delivery roadmap & kill criteria
    ├── SpecDoc.md          # Technical product specification
    ├── limitations.md      # System boundaries and failure modes
    ├── adr/                # Architectural Decision Records
    ├── runbooks/           # Operator disaster recovery and incident runbooks
    └── postmortems/        # Failure injection reports and retrospectives
```

---

## 4. Active Skills & Agent Workflows

The workspace is configured with active skills located in [`.agents/skills/`](file:///c:/Users/adity/Desktop/Projects/SynapseState/.agents/skills):

| Phase / Workflow                     | Recommended Skills to Invoke                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| **Architecture & Interface Design**  | `codebase-design`, `domain-modeling`, `architect`                                   |
| **Monorepo Planning & Roadmap**      | `research`                                                                          |
| **Implementation & Concurrency**     | `test-driven-development`                                                           |
| **Debugging & Invariant Violations** | `systematic-debugging`                                                              |
| **Verification & PR Gatekeeping**    | `verification-before-completion`, `receiving-code-review`, `requesting-code-review` |

---

## 5. Performance & Reliability SLOs

All code touching state delivery and SDK evaluation must be validated against continuous benchmarks before merging:

| Measurement Boundary             | Target SLO                        | Conditions & Verification                                                        |
| -------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| **Lease Propagation Lag**        | $p95 \le 10\text{ s}$             | Measured using server timestamps (`server_time - issued_at`) under long-polling. |
| **Lease Expiry Correctness**     | **0** past `TTL + SKEW_TOLERANCE` | Validated by property tests (`fast-check`) and chaos clock-skew injection.       |
| **SDK Hot-Path Overhead**        | Minimal overhead vs bare delegate | Microbenchmarks measuring `OverrideProvider` resolution path.                    |
| **Evaluation Path Availability** | 100% (Zero app crashes)           | Automatic fallback to delegate provider on any internal exception.               |
| **Control API Availability**     | 99.5% over 30 days (Single node)  | Blackbox HTTP probing. (SDKs fail-static during API downtime).                   |
| **Purger Refactoring Precision** | 0 incorrect removals on corpus    | Validated across supported, complex, and adversarial test repositories.          |

---

## 6. Git, Commit & Verification Guidelines

- **Conventional Commits:** Use standard prefixes (`feat(lease): ...`, `fix(sdk): ...`, `perf(api): ...`, `docs: ...`, `chore: ...`).
- **Evidence Before Claims:** Always run automated tests and benchmarks before claiming completion. Paste raw test outputs and logs in pull request descriptions.
- **Claims Policy:** Do not use buzzwords ("lock-free", "bank-grade", "50,000x faster") unless verified by a documented benchmark with date, hardware, and methodology.
- **Fail-Static Verification:** Any PR touching the SDK must demonstrate that disconnecting the Control API leaves evaluation functional and active leases strictly bounded by their TTL.
