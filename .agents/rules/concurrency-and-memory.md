# Concurrency & Memory Invariants

1. **Zero-Hop Hot Path**:
   - In `pkg/engine`, `sdk/go`, and `sdk/node`, evaluations must run entirely in-process against local heap memory.
   - Zero network syscalls, zero IPC roundtrips, and zero mutex locks on the evaluation path.

2. **Immutable Snapshot Swaps**:
   - Never mutate active ruleset maps or objects in place.
   - When delta updates arrive over the local IPC stream, compile the new ruleset into an immutable snapshot and atomically swap the active pointer.
   - Ongoing evaluations finish against their captured snapshot without lock contention.

3. **Safe Memory Reclamation**:
   - Rely on language runtime garbage collection for superseded snapshot reclamation.
   - No manual OS virtual memory mapping (`mmap`) or unmapping (`munmap`) in application runtimes.
   - Zero risk of `SIGSEGV` or `SIGBUS` process terminations from memory reclamation races.
