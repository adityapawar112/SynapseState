# 1. In-Process Heap Cache with Sidecar Delta Streaming over POSIX Shared Memory

Date: 2026-10-05
Status: Accepted

## Context

High-throughput microservices evaluate dozens of feature flags per incoming transaction. Feature flag evaluation architectures typically center around two extremes:
1. **Loopback socket sidecars (e.g. flagd over UDS):** Evaluates flags inside a sidecar process. Incurs 150 to 400 microseconds of latency per evaluation due to kernel context switches, socket queue contention, and IPC serialization.
2. **POSIX shared memory engines (`mmap` + FlatBuffers):** Maps binary state from `/dev/shm` into application processes. While native compiled languages (Go, Rust, C) achieve 15 to 45 nanosecond reads, managed polyglot runtimes suffer severe penalties:
   - In Node.js, crossing the Foreign Function Interface (FFI) boundary via N-API adds 30 to 60 nanoseconds per call. Total evaluation takes 45 to 95 nanoseconds, which is 2x to 4x slower than a native V8 JavaScript Map lookup (10 to 25 nanoseconds).
   - Cold-start page faults: Virtual memory pages are mapped lazily, causing minor page fault latency spikes on initial reads and file generation swaps.
   - Fatal crash hazards: Truncation, bad pointer offsets, or unmap race conditions trigger uncatchable `SIGSEGV` or `SIGBUS` hardware signals that kill the entire OS process immediately.

## Decision

We chose an in-process language heap cache fed by local sidecar delta streaming over POSIX shared memory.

A dedicated Kubernetes native sidecar (`synapse-agent`) maintains the upstream connection to the control plane, validates cryptographic signatures, and caches configuration state. The sidecar streams incremental delta updates over a local Unix domain socket to application SDKs only when state changes.

Application SDKs compile updates into an immutable, language-native data structure (such as a V8 Map in Node.js or `sync.Map` in Go) and execute all flag evaluations directly within process memory.

## Consequences

### Positive
* Sub-microsecond evaluation latency: 10 to 25 nanoseconds in Node.js and < 0.5 microseconds in Go with zero network syscalls on the evaluation path.
* Complete elimination of `SIGSEGV` and `SIGBUS` process crash hazards. Application runtimes operate in 100% memory-safe user space.
* Zero native compilation friction: SDKs require no C/Rust toolchains, `node-gyp`, or platform-specific ABI binaries (musl vs glibc).
* Full cross-platform portability across Linux, macOS, and Windows developer environments without requiring memory-backed tmpfs volume mounts.

### Negative
* Modest memory duplication: Each worker process on a pod maintains its own in-memory copy of the compiled ruleset (typically 1 to 5 MB per process).
