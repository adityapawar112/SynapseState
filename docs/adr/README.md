# Architectural Decision Records (ADRs)

This directory maintains the authoritative decision log for SynapseState. Following pre-implementation architecture consolidation, all legacy exploratory notes and intermediate amendments have been unified into eight definitive, active Architectural Decision Records.

---

## 1. Decision Registry

| ADR # | Title | Date | Status | Scope & Core Decision |
|---|---|---|---|---|
| **[0000](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0000-pre-pivot-architectural-rejections.md)** | Record of Pre-Pivot Architectural Rejections | 2026-10-06 | **Accepted (Historical)** | Formally records the rejection of POSIX shared memory (`mmap`), in-pod sidecar daemons (`synapse-agent`), Unix domain socket streaming, custom rollout DSLs, and polyglot Go/TypeScript maintenance. |
| **[0001](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0001-delegate-evaluation-to-openfeature.md)** | Delegate Evaluation to Existing OpenFeature Providers | 2026-10-06 | **Accepted** | Delegates steady-state flag evaluation to standard OpenFeature providers via `OverrideProvider` wrapper and `TelemetryHook`; fail-open fallback prevents disruption. |
| **[0002](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0002-typescript-monorepo-unification.md)** | TypeScript Monorepo Unification | 2026-10-06 | **Accepted** | Unifies entire ecosystem onto TypeScript/Node.js; eliminates native C/Rust compilation hazards across SDK, CLI, Control API, Purger, and Dashboard. |
| **[0003](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0003-etag-long-polling-for-state-delivery.md)** | ETag Long-Polling for State Delivery and Air-Gapped Fallback | 2026-10-09 | **Accepted** | Implements `GET /v1/sdk/state?wait=30s` long-polling on a single wire contract (dropping idle load 83% while delivering <100ms updates); adds air-gapped ConfigMap override directory fallback. |
| **[0004](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0004-operator-signed-leases-with-pluggable-signer-and-pinned-keyset.md)** | Operator-Signed Leases with Pluggable Signer, Pinned Keyset, and Bounded Caching | 2026-10-09 | **Accepted** | Establishes operator Ed25519 signatures, pluggable `Signer` with encrypted keyfile default (`~/.synapse/keys/<kid>.key`), Git-pinned keyset with 10s hash polling, signed key revocations, 15m bounded fallback cache, and dual-clock expiry. |
| **[0005](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0005-in-process-audit-sealer-and-isolated-checkpointer.md)** | In-Process Audit Sealer with Transaction Locks and Isolated Checkpointer | 2026-10-09 | **Accepted** | Decouples request transactions via `audit_pending`; in-process sealer runs with `pg_try_advisory_xact_lock` (PgBouncer-safe); seal order defines `seq`; checkpoint signer isolated to external CronJob. |
| **[0006](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0006-read-only-scanner-for-code-retirement.md)** | Read-Only Scanner and Per-Flag Consumer Coverage for Code Retirement | 2026-10-09 | **Accepted** | Re-scopes `synapse-purger` to a strictly read-only AST scanner and candidate qualifier; enforces per-flag evaluated consumer coverage and refusal-by-default; zero untrusted code execution in credentialed containers. |
| **[0007](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0007-per-flag-storage-and-pull-based-attribution.md)** | Per-Flag Directory Storage and Pull-Based Incident Attribution | 2026-10-09 | **Accepted** | Flag definitions live in `flags/<env>/<flag_key>.yaml` with build-time merge for single-file delegates; promotion in v1 scoped to Git-backed providers; pull-based `synapse log` attribution with pure ranker and type-aware suggestions. |

---

## 2. Subsystem Lineage & Specification Map

| Subsystem / Concern | Consolidated ADR | Primary Technical Specification | Key Invariants |
|---|---|---|---|
| **Flag Evaluation** | [ADR 0001](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0001-delegate-evaluation-to-openfeature.md) | [docs/ARCHITECTURE.md §1](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L11-L40) | In-process memory lookup; fail-open fallback to delegate provider on any internal exception. |
| **Monorepo Ecosystem** | [ADR 0002](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0002-typescript-monorepo-unification.md) | [docs/ARCHITECTURE.md §3](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L99-L130) | Pure TypeScript/Node.js; zero native C dependencies (`node-gyp`). |
| **State Delivery & Transport** | [ADR 0003](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0003-etag-long-polling-for-state-delivery.md) | [docs/ARCHITECTURE.md §4.1](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L145-L188) | ETag long-polling (`wait=30s`); air-gapped `/etc/synapse/emergency-leases/` fallback. |
| **Trust Root, Signing & Expiry** | [ADR 0004](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0004-operator-signed-leases-with-pluggable-signer-and-pinned-keyset.md) | [docs/ARCHITECTURE.md §5](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L260-L382) | Ed25519 signatures; pluggable `Signer` (encrypted keyfile default); Git-pinned keyset with 10s polling; 15m bounded fallback cache; dual-clock expiry. |
| **Tamper-Evident Audit Ledger** | [ADR 0005](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0005-in-process-audit-sealer-and-isolated-checkpointer.md) | [docs/ARCHITECTURE.md §8](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L549-L590) | Asynchronous staging in `audit_pending`; in-process sealer using `pg_try_advisory_xact_lock`; isolated Kubernetes CronJob checkpointer. |
| **Lifecycle Scanner (`purger`)** | [ADR 0006](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0006-read-only-scanner-for-code-retirement.md) | [docs/ARCHITECTURE.md §9](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L592-L633) | Read-only scanner; zero untrusted code execution (`npm test`); per-flag consumer coverage; refusal reports. |
| **Flag Storage & Attribution** | [ADR 0007](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0007-per-flag-storage-and-pull-based-attribution.md) | [docs/ARCHITECTURE.md §4.3 & §11.3](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L216-L248) | `flags/<env>/<flag_key>.yaml` per-flag storage; v1 promotion scoped to Git-backed providers; pull-based `synapse log` with pure ranker. |

---

## 3. How to Propose a New ADR

1. Create a new markdown file: `docs/adr/0008-<short-title>.md` using sequential numbering.
2. Structure the document with standard sections: Title, Date, Status, Context, Decision, Consequences (Positive/Negative).
3. If the ADR supersedes or amends an existing decision, update the previous ADR's `Status` line and reference it in the new ADR.
4. Update this `README.md` file to reflect the new entry in the registry and the subsystem lineage map.
