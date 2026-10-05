# Concurrency & Memory Invariants

1. **Fail-Safe Hot Path Evaluation**:
   - In `packages/sdk`, `OverrideProvider` checks an in-memory map of active, verified emergency leases.
   - Zero network syscalls, zero IPC roundtrips, and zero mutex locks on the evaluation path.
   - Any internal exception caught inside the wrapper must immediately fall through to the delegate OpenFeature provider without disrupting application traffic.

2. **In-Memory Lease Map Swaps**:
   - Never mutate active lease maps or objects in place.
   - When updated state arrives via HTTP polling (`GET /v1/sdk/state`), verify cryptographic signatures and compile the new active lease set into an immutable map reference.
   - Swap the active map reference atomically; ongoing evaluations finish cleanly without lock contention.

3. **Safe Memory Management**:
   - Rely on language runtime garbage collection for superseded lease map reclamation.
   - Pure TypeScript with zero native compilation dependencies, zero `mmap` virtual memory allocations, and zero crash hazards.
