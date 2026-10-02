# SLO & Benchmarking Invariants

1. **Latency Budgets**:
   - Native Go Engine: P99 <= 0.8 µs
   - Go OpenFeature SDK: P99 <= 2.0 µs
   - Node.js N-API SDK: P99 <= 5.0 µs
   - Intra-Cluster EEL: P99 <= 50 ms

2. **Benchmark Methodology**:
   - Continuous benchmarking must run under at least 10,000 iterations per timing capture.
   - Any PR that introduces heap allocations (`> 0 B/op`) in `pkg/engine` evaluation will fail CI.
   - Use HDR Histogram logging for tail latency verification.
