# 4. Lock-Free Atomic Reference Swapping for In-Process Configuration

Date: 2026-10-05
Status: Accepted

## Context

When configuration updates arrive from the sidecar daemon, the application SDK must update its in-memory ruleset without stalling active evaluation threads or causing data races.

Traditional concurrency patterns exhibit critical flaws in high-throughput engines:
1. **Read-write mutexes (`sync.RWMutex`):** Under 50,000+ evaluations per second across multiple CPU cores, read lock acquisition causes cache line bouncing and lock contention, adding microsecond-scale tail latency jitter.
2. **Epoch-based manual memory reclamation (`munmap` refcounting):** In shared-memory architectures, tracking reader counts with atomic integers before unmapping memory risks `SIGSEGV` if a thread stalls during garbage collection or CPU throttling.

## Decision

We chose lock-free atomic reference swapping over read-write locks and manual epoch reclamation.

The application SDK models configuration rulesets as immutable data snapshots:
1. **Evaluation (Hot Path):** Readers dereference the currently active ruleset snapshot pointer with a single atomic load. Zero lock acquisition, zero mutex contention, zero syscalls.
2. **Update (Background Path):** When the local delta stream delivers an update, the SDK compiles a new, complete, immutable ruleset snapshot in the background.
3. **Atomic Swap:** The SDK atomically swaps the active pointer to reference the new snapshot.
4. **Automatic Reclamation:** Ongoing evaluations finish cleanly against their captured snapshot reference. Once all active evaluations referencing the previous snapshot finish, the language runtime's garbage collector automatically reclaims the memory.

## Consequences

### Positive
* Pure wait-free evaluation: Hot-path evaluations never block on background updates or locks.
* Eliminates custom epoch reclamation and hazard pointer bugs.
* Guarantees memory safety: Managed language garbage collectors safely reclaim unreferenced memory frames without process-level faults.

### Negative
* Creating a new snapshot allocates heap memory during updates (though updates occur orders of magnitude less frequently than evaluations).
