# 5. Delegate Evaluation to Existing OpenFeature Providers

Date: 2026-10-06  
Status: Accepted  
Supersedes: [ADR 0001](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0001-in-process-heap-cache-with-sidecar-delta-streaming.md), [ADR 0004](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0004-lock-free-atomic-reference-swapping.md)

## Context

Previous iterations of SynapseState designed a custom in-process evaluation engine, custom binary wire protocols, and custom percentage rollout bucketing (MurmurHash3). This introduced substantial development overhead, required cross-runtime reimplementation, and competed directly with established standards like OpenFeature, flagd, Unleash, and Flipt.

Re-implementing flag evaluation adds no novel value: the primary unsolved challenges for production teams are **emergency incident safety (fast, attributable, self-reverting overrides)** and **lifecycle cleanup (retiring dead flags safely)**.

## Decision

We chose to delegate all baseline flag evaluation to standard [OpenFeature](https://openfeature.dev) providers rather than implementing a custom evaluation engine.

SynapseState provides an `OverrideProvider` wrapper and a `TelemetryHook`:
1. **`OverrideProvider`:** Intercepts evaluations. If an active, cryptographically verified emergency lease exists in memory for the flag, it returns the override value. Otherwise, it delegates resolution directly to the underlying OpenFeature provider (such as flagd file-source, JSON provider, or Unleash).
2. **`TelemetryHook`:** Collects `(flag_key, variant, reason)` evaluation counts in memory for lifecycle analysis without inspecting evaluation context.
3. **Fail-Open Fallback:** If any error occurs within the wrapper, it catches the error and immediately delegates to the underlying provider, ensuring SynapseState never breaks application traffic.

## Consequences

### Positive
* Eliminates the need to design, test, and maintain custom targeting DSLs, rule matchers, and rollout hashing algorithms.
* Provides vendor-neutral interoperability with existing OpenFeature ecosystems.
* Greatly reduces the surface area of the data plane, keeping the SDK lightweight and verifiable.
* Guarantees that evaluation never crashes the host process.

### Negative
* Evaluation latency is bounded by the performance of the delegate provider. SynapseState adds a minor wrapper lookup overhead.
