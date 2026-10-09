# 1. Delegate Evaluation to Existing OpenFeature Providers

Date: 2026-10-06  
Status: Accepted  

---

## Context

Feature flag management platforms traditionally require proprietary evaluation engines, custom rule DSLs, and bespoke percentage rollout algorithms (e.g. MurmurHash3). Building and maintaining a custom evaluator across multiple language runtimes requires massive engineering effort while competing directly with established CNCF standards (OpenFeature) and mature evaluation engines (such as flagd, Unleash, and Flipt).

Re-implementing evaluation adds no novel value: the critical unsolved problems for engineering teams are **incident safety** (attributable, time-bounded, self-reverting emergency overrides) and **lifecycle governance** (safe, telemetry-driven flag retirement).

---

## Decision

We chose to delegate all baseline flag evaluation to standard [OpenFeature](https://openfeature.dev) providers rather than implementing a custom evaluation engine.

SynapseState provides an `OverrideProvider` wrapper and a `TelemetryHook`:
1. **`OverrideProvider`:** Implements the OpenFeature `Provider` interface. It checks an in-process, thread-safe map of active, cryptographically verified emergency leases. If an unexpired lease matches the flag key, it returns the override value. Otherwise, it delegates resolution directly to the underlying OpenFeature provider (such as flagd file-source, JSON provider, or Unleash).
2. **`TelemetryHook`:** Implements OpenFeature evaluation hooks (`after`/`finally`) to aggregate `(flag_key, variant, reason)` evaluation counts in memory without inspecting context or user attributes.
3. **Fail-Open Fallback:** If any exception occurs within SynapseState's override logic, the wrapper catches the error, increments error metrics, and immediately falls through to the delegate provider. SynapseState must never disrupt application traffic.

---

## Consequences

### Positive
* Eliminates the need to build, test, and maintain custom targeting DSLs, rule segmenters, and hash engines.
* Provides native, vendor-neutral interoperability with the entire OpenFeature provider ecosystem.
* Keeps the hot-path SDK lightweight, completely memory-safe, and verifiable.
* Guarantees that internal governance errors cannot crash application processes or block flag resolution.

### Negative
* Baseline evaluation performance is bounded by the delegate provider, plus minimal wrapper lookup overhead (a single Map lookup and null check).
