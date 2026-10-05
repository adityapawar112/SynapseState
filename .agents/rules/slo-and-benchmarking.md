# SLO & Benchmarking Invariants

1. **Target Reliability & Propagation SLOs**:
   - Lease Propagation Lag: $p95 \le 10\text{ s}$ under 5-second polling with jitter (measured via server timestamps).
   - Lease Expiry Correctness: **Zero** leases honored past `TTL + SKEW_TOLERANCE`.
   - Evaluation Path Availability: 100% (zero application crashes caused by SynapseState; automatic fallback to delegate provider).
   - Control API Availability: 99.5% over 30 days (single node).
   - Purger Refactoring Precision: Zero incorrect removals on labeled evaluation corpus.

2. **Benchmark Methodology & Claims Policy**:
   - Publish only numbers measured under documented hardware, test configurations, and dates.
   - Zero buzzwords ("lock-free", "bank-grade", "50,000x faster") without defensible single-sentence proofs.
   - Measure and publish only the wrapper overhead of `OverrideProvider` compared against bare delegate providers.
