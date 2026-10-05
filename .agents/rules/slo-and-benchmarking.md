# SLO & Benchmarking Invariants

1. **Latency Budgets**:
   - Native Go Engine: P99 <= 0.5 µs
   - Go OpenFeature SDK: P99 <= 1.0 µs
   - Node.js OpenFeature SDK: P99 <= 1.0 µs
   - Intra-Cluster EEL: P99 <= 50 ms

2. **Benchmark Methodology**:
   - Continuous benchmarking must run under at least 10,000 iterations per timing capture.
   - Any PR that introduces network calls, mutex locks, or per-evaluation socket IPC will fail CI.
   - Use HDR Histogram logging for tail latency verification.
