# SynapseState Handoff: Phase 1 — SDK Hot-Path Microbenchmarks (`packages/sdk`)

> **Target Session:** Implement PR 5 (`perf/sdk-microbenchmarks`)
> **Repository:** `synapsestate/synapsestate`
> **Base Branch:** `feat/sdk-long-poll-telemetry`
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: `AGENTS.md` (Sections 1, 5 — No Microbenchmark Theater)
> - Authoritative Architecture: `docs/ARCHITECTURE.md` (Sections 5.1–5.4, 5.6)
> - Technical Specification: `docs/SpecDoc.md` (Section 4.1)
> - Delivery Roadmap: `docs/ROADMAP.md` (Phase 1, PR 5)
> - ADR 0001 (Delegate Evaluation): `docs/adr/0001-delegate-evaluation-to-openfeature.md`

---

## 1. Executive Summary & Monorepo State

### 1.1 PR 1 Completed: Cryptographic Lease Core & Schemas (`packages/lease`)
- **Delivered:** RFC 8785 canonicalization, Ed25519 signing/verification with domain separation (`synapsestate/lease/v1\n`, `synapsestate/revocation/v1\n`, `synapsestate/keyrevocation/v1\n`), Zod schemas, dual-clock expiry validator (`evaluateLeaseExpiry`, `isLeaseActive`), and Git-pinned keyset parser and policy verifiers.
- **Tests:** 91 passing tests in `packages/lease`.

### 1.2 PR 2 Completed: Conformance Golden Vectors & Runner (`packages/conformance`)
- **Delivered:** 14 deterministic JSON fixture files (55 test vectors), fixture generator, pure TypeScript runner enforcing keyset-policy seams, canonical failure codes, base64url malleability rejection, and single-byte mutation rejection.
- **Tests:** 22 passing tests in `packages/conformance`.

### 1.3 PR 3 Completed: SDK OverrideProvider, Keyset Watcher & Emergency Scanner (`packages/sdk`)
- **Delivered:** `OverrideProvider`, `LeaseStore` (dual-clock expiry, conflict resolution, anti-monotonic protection), `KeysetWatcher` (10s file-hash polling on `/etc/synapse/keyset/keyset.json`), and `EmergencyScanner` (air-gapped `/etc/synapse/emergency-leases/*.json`).
- **Tests:** 35 passing tests in `packages/sdk`.

### 1.4 PR 4 Completed: ETag Long-Polling & Zero-Context TelemetryHook (`packages/sdk`)
- **Delivered:**
  - `StateClient`: ETag long-polling client loop (`GET /v1/sdk/state?env={env}&wait=30s`) with 304 caching, cryptographic reconciliation into `LeaseStore` (`key_revocations -> revocations -> active_leases`), and exponential backoff fail-static offline resilience.
  - `TelemetryHook`: Zero-context OpenFeature `Hook` (Invariant 5) collecting strictly `(flag_key, variant, reason)` tuples, ring-buffer bulkhead capacity protection, deterministic sorting, and periodic HTTP export (`POST /v1/telemetry/batches`).
  - `generateUlid`: 26-character Crockford Base32 ULID generator.
  - End-to-end integration: `OverrideProvider` wires `StateClient` and `TelemetryHook` into provider options, lifecycle hooks, and evaluation flow.
- **Tests:** 53 passing tests in `packages/sdk` (9 test files).
- **Monorepo Baseline:** 169/169 passing tests, 0 build errors, 0 typecheck errors, 0 lint warnings.

---

## 2. Next Ticket: PR 5 Scope & Deliverables

- **Target Branch:** `perf/sdk-microbenchmarks` (branch from `feat/sdk-long-poll-telemetry`)
- **Target Package:** `packages/sdk`
- **PR Title:** `perf(sdk): microbenchmarks measuring OverrideProvider overhead vs bare delegate`

### Core Components to Implement
1. **Benchmark Suite (`packages/sdk/benchmarks/`):**
   - Measure `OverrideProvider` hot-path overhead across evaluation paths:
     - Baseline fallback to delegate (cache miss / no active lease).
     - Active override match (cache hit in `LeaseStore`).
     - Delegate comparison: Bare `InMemoryProvider` or mock delegate vs wrapped `OverrideProvider`.
     - Dual-clock evaluation overhead per resolution.
   - Benchmark script runner in `packages/sdk/package.json` (`pnpm --filter @synapsestate/sdk run bench`).
2. **Charter Claims Policy (`AGENTS.md` §1 & §6):**
   - Strictly avoid unsubstantiated claims ("zero-latency", "50,000x faster").
   - Publish measured numbers with date, Node.js version, OS, and hardware environment.
   - Confirm minimal wrapper overhead relative to bare delegate evaluation.

---

## 3. Verification Commands for PR 5
```bash
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm test
pnpm --filter @synapsestate/sdk run bench
```
