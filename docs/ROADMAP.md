# Wayfinder roadmap: SynapseState

This document charts the delivery map for SynapseState. It breaks the project into sequenced milestones, decision tickets, and knowledge checkpoints.

## Destination

A functional, self-hosted runtime configuration engine where a Node.js microservice evaluates feature flags in under 25 nanoseconds in pure TypeScript, backed by a sidecar delta streaming bus, GitOps configuration, and guarded stale-flag cleanup.

## Notes

* Primary development language for SDK: Pure TypeScript (Node.js) with zero native compilation dependencies, alongside native Go.
* Core engine: In-process hash map lookup with unsigned 32-bit MurmurHash3 bucketing and atomic reference swapping.
* Local developer environment: Windows workstation using local named pipes or loopback sockets, with Linux containers for full-stack integration verification.
* Guiding charter: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md)
* Architecture overview: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md)
* Domain terms: [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md)

## Decisions so far

* [ADR 0001](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0001-in-process-heap-cache-with-sidecar-delta-streaming.md): In-process language heap cache chosen over raw POSIX shared memory to eliminate N-API FFI overhead and process crash hazards.
* [ADR 0002](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0002-unix-domain-sockets-for-local-delta-streaming.md): Local Unix domain sockets chosen for push-based delta streaming from sidecar to application SDKs.
* [ADR 0003](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0003-tiered-emergency-leases.md): Tiered emergency leases (single-operator break-glass with short TTL plus dual-control promotion) chosen over strict dual-control to prevent 2 AM outage lockouts.
* [ADR 0004](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0004-lock-free-atomic-reference-swapping.md): Lock-free atomic reference swapping chosen over custom epoch unmapping to rely on native language runtime garbage collection.

## Phased milestones

### Milestone 1: The in-process data plane core (immediate frontier)

Goal: A Node.js application connects to a local delta stream, caches rules in V8 memory, and evaluates feature flags in under 25 nanoseconds.

* **1.1 Canonical rule and delta schema (`pkg/protocol`)**
  * Define strongly typed message schemas for flags, variants, targeting rules, rollout splits, and delta patches.
  * Generate Go structs and TypeScript definitions.
* **1.2 Deterministic in-process evaluation engine**
  * O(1) flag lookup by key.
  * Priority-ordered targeting rule matching (operators: Equals, NotEquals, In, GreaterThan, LessThan, SemverGte).
  * Unsigned 32-bit MurmurHash3 bucketing (0 to 9,999) for percentage rollouts.
  * Thread-safe atomic reference swapping on rule updates.
* **1.3 Local IPC delta client (`sdk/node/src/client`)**
  * Unix domain socket client on Linux, falling back to local named pipes on Windows.
  * Handshake protocol: request full generation snapshot on connect, listen for incremental deltas.
  * Automatic reconnection with exponential backoff and generation synchronization.
* **1.4 Node.js OpenFeature provider (`sdk/node`)**
  * Pure TypeScript implementation of the OpenFeature `Provider` interface.
  * Zero native addons, zero node-gyp or Rust toolchain requirements.
  * Benchmark evaluation path to verify sub-microsecond latency.
* **1.5 Golden test conformance suite**
  * Validate 50+ test vectors covering all rule operators, bucketing boundaries, and fallback behavior.
  * Cross-runtime consistency checks between Go and Node.js engines.

### Milestone 2: The sidecar daemon and local streaming hub

Goal: A companion daemon maintains upstream cluster sync and streams delta updates to local application SDKs.

* **2.1 Sidecar delta stream server (`cmd/synapse-agent`)**
  * Listen on local Unix domain socket (`/var/run/synapse/synapse.sock`).
  * Broadcast generation deltas to all connected pod processes.
* **2.2 Pod startup and handshake protocol**
  * Serve full snapshot on client initialization, followed by streaming diffs.
  * Handle concurrent client connects and disconnects cleanly.
* **2.3 Local disk snapshot fallback**
  * Persist periodic snapshots to local container storage.
  * Provide instant offline bootstrap if upstream control plane is unreachable on pod boot.

### Milestone 3: Control plane and tiered emergency CLI

Goal: Changes merged into Git stream to all connected sidecars across the cluster, with break-glass incident overrides.

* **3.1 PostgreSQL audit ledger**
  * Relational schema for flag definitions, generation history, and audit records.
  * Trigger-based lightweight `LISTEN`/`NOTIFY` event bus.
* **3.2 Upstream gRPC delta streaming**
  * Long-lived HTTP/2 gRPC streaming connections between control plane and sidecars.
  * Reconnection handling and generation acknowledgment tracking.
* **3.3 Tiered break-glass CLI (`synapse-cli`)**
  * Single-operator emergency lease command with mandatory 30-minute TTL and Ed25519 signing.
  * Dual-control promotion workflow to extend leases or promote to Git PR.
  * Monotonic expiration deadline verification.

### Milestone 4: Kubernetes operator and sidecar injection

Goal: Automatic sidecar injection into application pods using Kubernetes native manifests.

* **4.1 Kubernetes CRD definitions**
  * Define `FeatureFlagGroup` and `EmergencyLease` Custom Resource Definitions.
* **4.2 Mutating admission webhook**
  * Automatically inject `synapse-agent` native sidecar and intra-pod IPC volume into target pods.
  * Configure `/readyz` and `/healthz` container probes.

### Milestone 5: Guarded quiescence and code pruning

Goal: Stale release flags are safely removed from application source code without breaking builds or tests.

* **5.1 OpenTelemetry telemetry collector**
  * Aggregate flag evaluation counts by key, variant, and reason code.
* **5.2 Quiescence calculation engine**
  * Track 30-day invariance ($Q = 1.0$) across production pods.
  * Filter candidates strictly by flag lifecycle (`release` and `experiment` only; ignore `killswitch`).
* **5.3 TypeScript AST refactoring worker (`synapse-purger`)**
  * Parse codebase using `ts-morph`.
  * Inline winning branch and delete dead conditional branches.
  * Run pre-flight compiler check (`tsc --noEmit`) and repository test suite.
  * Submit verified Draft Pull Request on GitHub with telemetry proofs.

## Out of scope

* Client-side web browser and mobile SDKs.
* Graphical web administrative dashboard.
* Serverless platforms without background sidecar lifecycles.
* Autonomous direct-to-main code merging without human review.
