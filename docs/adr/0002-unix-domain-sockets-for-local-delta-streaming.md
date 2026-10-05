# 2. Unix Domain Sockets for Local Delta Streaming

Date: 2026-10-05
Status: Superseded by [ADR 0006](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0006-http-polling-with-etag-over-sidecar-ipc.md)

## Context

The `synapse-agent` sidecar must deliver configuration deltas to application processes running inside the same Kubernetes pod.

Possible inter-process communication mechanisms include:
1. **Loopback TCP (`127.0.0.1`):** Incurs full network stack processing (TCP handshakes, checksum calculations, port management) and can exhaust ephemeral ports under high connection churn.
2. **POSIX shared memory files:** Requires complex filesystem orchestration, atomic rename tracking, inotify watches, and file permissions across container boundaries.
3. **Unix Domain Sockets (UDS):** Bypasses network routing and TCP stack processing. The kernel transfers data directly between socket buffers without network card emulation. On Windows development environments, named pipes provide equivalent local IPC semantics.

Furthermore, existing tools like flagd use Unix domain sockets for per-evaluation request-response RPCs, incurring 150 to 400 microseconds of latency on every flag check.

## Decision

We chose Unix domain sockets (`/var/run/synapse/synapse.sock`) strictly as a push-based delta streaming bus, rather than a per-evaluation query interface.

The application SDK establishes a persistent connection to the sidecar socket upon startup:
1. The SDK receives a full generation snapshot during the initial handshake.
2. The sidecar keeps the socket connection open and pushes incremental Protobuf deltas only when configuration changes occur upstream.
3. Flag evaluation never queries the socket. All evaluations resolve directly against the in-process heap cache.

## Consequences

### Positive
* High-throughput, low-overhead push transport: Deltas propagate from sidecar to application SDKs in under 1 millisecond.
* Eliminates socket contention on the evaluation path: Sockets are touched only during configuration updates, leaving the hot path entirely in memory.
* Clean container isolation: An intra-pod `emptyDir` volume provides the socket mount without needing elevated privileges or memory-backed tmpfs configurations.

### Negative
* Requires local socket client implementations across SDK languages.
* Requires fallbacks (such as Windows named pipes) for local development on non-POSIX hosts.
