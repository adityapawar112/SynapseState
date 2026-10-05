# 6. HTTP Polling with ETag over In-Pod Sidecar IPC

Date: 2026-10-06  
Status: Accepted  
Supersedes: [ADR 0001](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0001-in-process-heap-cache-with-sidecar-delta-streaming.md), [ADR 0002](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0002-unix-domain-sockets-for-local-delta-streaming.md)

## Context

SynapseState previously specified an in-pod Go sidecar daemon (`synapse-agent`) deployed via Kubernetes mutating admission webhooks, streaming binary deltas over intra-pod Unix Domain Sockets (`/var/run/synapse/synapse.sock`).

While this avoided direct external connections, it introduced major operational friction:
1. Mutating admission webhooks are notoriously difficult to configure, debug, and secure in enterprise Kubernetes clusters.
2. Sidecars add startup latency, probe complexity (`/readyz` synchronization), and non-trivial memory overhead per pod.
3. IPC over Unix sockets required language-specific socket clients and fallback logic for Windows development environments.
4. The target propagation SLO ($p95 \le 10\text{ s}$) does not require sub-millisecond local streaming.

## Decision

We chose direct HTTP polling with `ETag` conditional caching from the application SDK to the central Control API, eliminating the in-pod sidecar daemon and Unix domain socket IPC entirely.

1. **Protocol:** Workload SDKs poll `GET /v1/sdk/state?env=prod` with `If-None-Match: <etag>` at an interval of 5 seconds with random jitter.
2. **Bandwidth Efficiency:** When state is unchanged, the server returns `304 Not Modified` with zero serialization or allocation overhead.
3. **Fail-Static Semantics:** If the Control API is offline or partitioned, the SDK continues honoring previously verified active leases until their individual deadlines elapse.
4. **Scope Isolation:** Flag definitions themselves do not travel through this endpoint; only signed active leases and revocations are delivered.

## Consequences

### Positive
* Completely eliminates the mutating admission webhook, sidecar container overhead, and intra-pod volume mounts.
* Greatly simplifies local development: works identically on Linux, macOS, and Windows without socket emulation or named pipes.
* Trivial to test, inspect, and trace using standard HTTP observability tools.
* Meets the $p95 \le 10\text{ s}$ propagation SLO under realistic k6 workloads.

### Negative
* Higher network connection overhead than local socket IPC (mitigated by HTTP keep-alive, connection pooling, and `304 Not Modified` responses).
* Revocation under network partition is delayed until lease TTL expiration.
