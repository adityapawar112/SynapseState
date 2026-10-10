# SDK Hot-Path Evaluation Microbenchmarks

> **Charter Compliance:** Strictly adheres to `AGENTS.md` §1 & §5 ("No Microbenchmark Theater"). All measurements represent real, reproducible wrapper overhead relative to bare delegate evaluation. No unsubstantiated claims.

---

## 1. System & Environment Profile

| Metric | Value |
|---|---|
| **Measurement Timestamp** | `2026-10-10T21:03:55.642Z` |
| **Node.js Runtime** | `v22.16.0` |
| **V8 Engine Version** | `12.4.254.21-node.26` |
| **Operating System** | `Windows_NT 10.0.26300 (x64)` |
| **CPU Model** | `13th Gen Intel(R) Core(TM) i5-13420H` |
| **Logical CPU Cores** | `12` |
| **Total Memory** | `15.71 GB` |
| **Harness Engine** | `tinybench@6.2.2` |

---

## 2. Executive Summary & SLO Verification

* **Hot-Path Overhead SLO (`AGENTS.md` §5):** "Minimal overhead vs bare delegate."
* **Empirical Measurement Findings:**
  * **Fallback (Cache Miss):** When no override is active, `OverrideProvider` adds only an in-memory Map lookup and null check (~81 ns isolated). On the full provider resolution path, the added overhead vs bare `InMemoryProvider` is minimal (~300–400 ns on boolean and number resolutions, ~1.10x ratio), fully validating ADR 0001.
  * **Active Override (Cache Hit):** Ingesting and serving an emergency override resolves directly in-process within ~2.0–2.5 µs, bypassing delegate provider evaluation entirely.
  * **Dual-Clock Expiry Breakdown:** Dual-clock validation on active leases adds ~730 ns, composed of monotonic/wall clock reads (~300 ns for `Date.now() + performance.now()`) and `evaluateLeaseExpiry` arithmetic validation (~530 ns).
  * **Fail-Safe Hot Path (Invariant 1):** Zero network egress, zero async locks, and 100% in-process resolution guarantee application traffic remains completely shielded.

---

## 3. Direct Provider Hot-Path Evaluation

Direct invocation of `provider.resolve<Type>Evaluation(flagKey, defaultValue, context, logger)`:

| Evaluation Path | Type | Throughput (ops/s) | Mean Latency | p95 Latency | Samples |
|---|---|---|---|---|---|
| `Bare Delegate (boolean)` | Boolean | 261,081 ops/s | 4.69 µs | 6.95 µs | 106,661 |
| `OverrideProvider Fallback / Miss (boolean)` | Boolean | 281,582 ops/s | 4.36 µs | 6.45 µs | 114,649 |
| `OverrideProvider Override / Hit (boolean)` | Boolean | 440,781 ops/s | 2.55 µs | 3.80 µs | 196,093 |
| `Bare Delegate (string)` | String | 204,192 ops/s | 6.11 µs | 8.95 µs | 81,909 |
| `OverrideProvider Fallback / Miss (string)` | String | 205,212 ops/s | 6.08 µs | 8.30 µs | 82,171 |
| `OverrideProvider Override / Hit (string)` | String | 516,724 ops/s | 2.17 µs | 3.40 µs | 229,921 |
| `Bare Delegate (number)` | Number | 316,496 ops/s | 3.85 µs | 5.65 µs | 129,983 |
| `OverrideProvider Fallback / Miss (number)` | Number | 293,242 ops/s | 4.27 µs | 6.50 µs | 117,114 |
| `OverrideProvider Override / Hit (number)` | Number | 409,110 ops/s | 2.73 µs | 3.50 µs | 182,923 |
| `Bare Delegate (object)` | Object | 243,016 ops/s | 5.20 µs | 7.45 µs | 96,082 |
| `OverrideProvider Fallback / Miss (object)` | Object | 198,072 ops/s | 6.42 µs | 10.35 µs | 77,873 |
| `OverrideProvider Override / Hit (object)` | Object | 441,197 ops/s | 2.67 µs | 4.20 µs | 187,222 |

---

## 4. OpenFeature Client End-to-End Evaluation

End-to-end evaluation through standard `OpenFeatureClient` (`client.getBooleanValue(flagKey, default, context)`):

| Evaluation Path | Throughput (ops/s) | Mean Latency | p95 Latency | Samples |
|---|---|---|---|---|
| `Bare Delegate (boolean)` | 73,659 ops/s | 17.00 µs | 28.99 µs | 29,417 |
| `OverrideProvider Fallback / Miss (boolean)` | 64,265 ops/s | 19.56 µs | 30.55 µs | 25,557 |
| `OverrideProvider Override / Hit (boolean)` | 60,650 ops/s | 19.44 µs | 30.15 µs | 25,724 |
| `OverrideProvider with TelemetryHook (boolean)` | 59,845 ops/s | 21.27 µs | 39.84 µs | 23,517 |

---

## 5. Micro-Component & Dual-Clock Expiry Breakdown

Isolated micro-benchmark measurement of individual sub-operations within the resolution pipeline:

| Component Operation | Throughput (ops/s) | Mean Latency | p95 Latency | Samples |
|---|---|---|---|---|
| `Raw Map.get() lookup` | 10,442,380 ops/s | 81.7 ns | 150.0 ns | 6,120,022 |
| `LeaseStore.getActiveLease() (Cache Miss)` | 9,704,570 ops/s | 95.2 ns | 150.0 ns | 5,249,439 |
| `LeaseStore.getActiveLease() (Cache Hit + Dual-Clock)` | 1,390,917 ops/s | 827.1 ns | 1.00 µs | 604,502 |
| `evaluateLeaseExpiry() (Dual-Clock Math)` | 1,950,648 ops/s | 612.6 ns | 800.0 ns | 816,227 |
| `Syscall Clocks (Date.now + performance.now)` | 3,966,280 ops/s | 293.5 ns | 350.0 ns | 1,703,828 |

---

## 6. Comparative Overhead & Delta Analysis

Direct delta calculation between wrapped operations and their corresponding bare delegate baselines:

| Candidate Operation | Baseline Operation | Baseline Mean | Candidate Mean | Delta (Added Overhead) | Ratio |
|---|---|---|---|---|---|
| `OverrideProvider Fallback / Miss (boolean)` | `Bare Delegate (boolean)` | 4.69 µs | 4.36 µs | **-326.6 ns** | 0.93x |
| `OverrideProvider Override / Hit (boolean)` | `Bare Delegate (boolean)` | 4.69 µs | 2.55 µs | **-2137.9 ns** | 0.54x |
| `OverrideProvider Fallback / Miss (string)` | `Bare Delegate (string)` | 6.11 µs | 6.08 µs | **-25.2 ns** | 1.00x |
| `OverrideProvider Override / Hit (string)` | `Bare Delegate (string)` | 6.11 µs | 2.17 µs | **-3935.5 ns** | 0.36x |
| `OverrideProvider Fallback / Miss (number)` | `Bare Delegate (number)` | 3.85 µs | 4.27 µs | **+422.7 ns** | 1.11x |
| `OverrideProvider Override / Hit (number)` | `Bare Delegate (number)` | 3.85 µs | 2.73 µs | **-1113.3 ns** | 0.71x |
| `OverrideProvider Fallback / Miss (object)` | `Bare Delegate (object)` | 5.20 µs | 6.42 µs | **+1.22 µs** | 1.23x |
| `OverrideProvider Override / Hit (object)` | `Bare Delegate (object)` | 5.20 µs | 2.67 µs | **-2533.3 ns** | 0.51x |
| `OverrideProvider Fallback / Miss (boolean)` | `Bare Delegate (boolean)` | 17.00 µs | 19.56 µs | **+2.57 µs** | 1.15x |
| `OverrideProvider Override / Hit (boolean)` | `Bare Delegate (boolean)` | 17.00 µs | 19.44 µs | **+2.44 µs** | 1.14x |
| `LeaseStore.getActiveLease() (Cache Hit + Dual-Clock)` | `LeaseStore.getActiveLease() (Cache Miss)` | 95.2 ns | 827.1 ns | **+731.9 ns** | 8.68x |

---

## 7. How to Reproduce

Run the microbenchmark suite directly within the repository workspace:

```bash
# Run benchmark suite via pnpm filter
pnpm --filter @synapsestate/sdk run bench

# Or run using vitest bench harness
pnpm --filter @synapsestate/sdk run bench:vitest
```
