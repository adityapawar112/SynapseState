# Concurrency & Memory Invariants

1. **Zero-Copy Hot Path**:
   - In `pkg/engine` and `sdk/go`, never allocate on heap during flag evaluation.
   - Return raw byte slices or string views directly in the native engine.
   - FlatBuffers memory must be accessed via direct pointer offsets.

2. **Atomic File Replacement**:
   - Never write to `/synapse/arena.bin` directly.
   - Always write to `/synapse/arena.<generation>.bin` and execute POSIX `rename(2)`.
   - The writing sidecar must run under UID 10001 (RW) and workload under UID 10002 (RO `PROT_READ`).

3. **Safe Reader Reclamation Protocol**:
   - Readers acquire `ArenaMapping` atomic refcount before evaluating, decrement immediately after.
   - On detecting a new generation via inotify/timer, update atomic global pointer.
   - Only call `munmap` on previous mapping when its `refCount == 0`.
   - Never use arbitrary `time.Sleep` or time-based unmap grace periods.
