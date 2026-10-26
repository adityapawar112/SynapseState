# 3. ETag Long-Polling for State Delivery and Air-Gapped Fallback

Date: 2026-10-09  
Status: Accepted

---

## Context

Emergency feature flag overrides must propagate across a cluster quickly during an incident ($p95 \le 10\text{ s}$). We evaluated four distribution mechanisms:

1. **In-Pod Sidecars over Unix Domain Sockets:** Required mutating admission webhooks, container memory bloat, and platform-specific socket clients.
2. **Short Interval Polling (5s):** Generated continuous idle request churn (~100 req/s for 500 pods) even during zero-mutation steady states.
3. **Server-Sent Events (SSE):** Streamed updates instantly, but introduced dual code paths (SSE listener + catch-up HTTP polling), complex reconnect storm handling, and state reconstruction bugs across network blips.
4. **ETag Long-Polling (`wait=30s`):** Clients issue standard HTTP requests with `If-None-Match: "<etag>"` and `wait=30s`. The server responds immediately upon state change or holds the connection up to 30 seconds before returning `304 Not Modified`.

---

## Decision

We chose **ETag long-polling** over SSE, short polling, and sidecar IPC as the single unified transport protocol for SynapseState:

1. **Unified Wire Contract:** Workload SDKs poll `GET /v1/sdk/state?env=prod&wait=30s` with header `If-None-Match: "<etag>"`.
2. **Instant Propagation (< 100ms):** When an override is created, revoked, or promoted, an internal server-side `EventEmitter` immediately wakes all waiting long-poll requests and flushes the updated state generation.
3. **Bandwidth & Request Efficiency:** Drops idle request load by ~83% compared to 5-second interval polling, while returning empty `304 Not Modified` headers when state is invariant.
4. **Single Code Path:** Eliminates the dual code paths and reconnection race conditions inherent in SSE and WebSocket transports.
5. **Air-Gapped Out-of-Band Fallback:** Because leases are self-authenticating Ed25519 envelopes, SDKs also scan `/etc/synapse/emergency-leases/*.json`. If the Control API is offline or partitioned, operators apply emergency overrides directly via `kubectl apply` without control plane dependency.

---

## Consequences

### Positive

- Sub-100ms lease distribution during incidents with an 83% reduction in idle request traffic.
- Single wire contract and single client state machine: zero streaming reconnect complexity.
- Air-gapped fallback guarantees emergency overrides succeed even during complete Control API or PostgreSQL downtime.
- Trivial to inspect, proxy, load balance, and debug using standard HTTP infrastructure.

### Negative

- Keeps HTTP keep-alive connections open on the Control API (mitigated by Node.js event-loop concurrency and low per-connection memory overhead).
