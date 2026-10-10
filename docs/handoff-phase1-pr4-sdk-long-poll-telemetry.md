# SynapseState Handoff: Phase 1 — SDK ETag Long-Polling & Zero-Context TelemetryHook (`packages/sdk`)

> **Target Session:** Implement PR 4 (`feat/sdk-long-poll-telemetry`)
> **Repository:** `synapsestate/synapsestate`
> **Base Branch:** `feat/sdk-override-provider` (Commit `9554c16`)
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: `AGENTS.md`
> - Authoritative Architecture: `docs/ARCHITECTURE.md` (Sections 5.1–5.4, 5.6)
> - Technical Specification: `docs/SpecDoc.md` (Sections 4.2, 5.1)
> - Delivery Roadmap: `docs/ROADMAP.md` (Phase 1, PR 4)
> - ADR 0001 (Delegate Evaluation): `docs/adr/0001-delegate-evaluation-to-openfeature.md`
> - ADR 0003 (State Delivery & Emergency Fallback): `docs/adr/0003-etag-long-polling-for-state-delivery.md`

---

## 1. Executive Summary & Monorepo State

### 1.1 PR 1 Completed: Cryptographic Lease Core & Schemas (`packages/lease`)

- **Delivered:** RFC 8785 canonicalization, Ed25519 signing/verification with domain prefixes (`synapsestate/lease/v1\n`, `synapsestate/revocation/v1\n`, `synapsestate/keyrevocation/v1\n`), Zod schemas, dual-clock expiry validator (`evaluateLeaseExpiry`, `isLeaseActive`), and Git-pinned keyset parser and policy verifiers.
- **Tests:** 91 passing tests in `packages/lease`.

### 1.2 PR 2 Completed: Conformance Golden Vectors & Runner (`packages/conformance`)

- **Delivered:** 14 deterministic JSON fixture files (55 test vectors), fixture generator, pure TypeScript runner enforcing keyset-policy seams, canonical failure codes, base64url malleability rejection, and single-byte mutation rejection.
- **Tests:** 22 passing tests in `packages/conformance`.

### 1.3 PR 3 Completed: SDK OverrideProvider, Keyset Watcher & Emergency Scanner (`packages/sdk`)

- **Branch:** `feat/sdk-override-provider` (Commit `9554c16`)
- **Delivered:**
  - `OverrideProvider`: Implements OpenFeature `Provider` wrapping any underlying provider, with hot-path `OVERRIDE` evaluation and double-layered Invariant 1 exception shielding.
  - `LeaseStore`: Thread-safe in-memory store enforcing Invariant 3 dual-clock expiry, deterministic conflict resolution (`issued_at DESC`, `lease_id DESC`), anti-monotonic reset, and keyset update / revocation eviction.
  - `KeysetWatcher`: 10-second SHA-256 file-hash polling on `/etc/synapse/keyset/keyset.json` (no `fs.watch`), 15-minute bounded fallback cache, and authoritative empty keyset `{}` purge.
  - `EmergencyScanner`: Air-gapped directory scanner (`/etc/synapse/emergency-leases/*.json`) verifying leases against pinned keyset and active key revocations, with hash dedup caching and opportunistic expired lease sweeping.
- **Tests:** 35 passing tests in `packages/sdk` (6 test files).
- **Monorepo Baseline:** 151/151 tests passing across monorepo, 0 build errors, 0 typecheck errors, 0 lint warnings.

---

## 2. Next Ticket: PR 4 Scope & Deliverables

- **Target Branch:** `feat/sdk-long-poll-telemetry` (branch from `feat/sdk-override-provider`)
- **Target Package:** `packages/sdk`
- **PR Title:** `feat(sdk): ETag long-polling client loop and zero-context TelemetryHook`

### Core Components to Implement

1. **`StateClient` (`packages/sdk/src/state-client.ts`):**
   - Implements ETag long-polling state synchronization client loop (ADR 0003, `docs/SpecDoc.md` §5.1).
   - Polls `GET /v1/sdk/state?env={env}&wait=30s`:
     - Sends `If-None-Match: "<current_etag>"` header.
     - Sends `Authorization: Bearer <service_token>` header if configured.
     - Handles HTTP `304 Not Modified`: updates last-sync timestamp, retains state, immediately re-issues poll.
     - Handles HTTP `200 OK`:
       - Updates stored ETag from response `ETag` header.
       - Validates response payload schema:
         ```typescript
         {
           server_time: string,
           registry_version: number,
           active_leases: LeaseEnvelope[],
           revocations: RevocationEnvelope[],
           key_revocations: KeyRevocationEnvelope[],
         }
         ```
       - Cryptographically ingests/reconciles into `LeaseStore`:
         1. Applies all `key_revocations` via `leaseStore.applyKeyRevocation(env)`.
         2. Applies all `revocations` via `leaseStore.applyRevocation(env)`.
         3. Adds valid `active_leases` via `leaseStore.addLease(env)`.
   - **Fail-Static Network Resilience (ADR 0003, ARCHITECTURE §5.4):**
     - On network failure, 5xx server errors, or timeout: does NOT clear active leases. Active leases continue until their dual-clock TTL deadlines elapse.
     - Implements exponential backoff with jitter on connection errors (e.g., 1s, 2s, 4s up to 30s max backoff).
     - Clean lifecycle: `start()` and `stop()` using `AbortController`.

2. **`TelemetryHook` (`packages/sdk/src/telemetry-hook.ts`):**
   - Implements OpenFeature `Hook` interface (`@openfeature/server-sdk`).
   - Hooks:
     - `after(hookContext, details)`: extracts `(flagKey, variant, reason)` and records count in memory.
     - `error(hookContext, error)`: records `(flagKey, "error", "ERROR")`.
   - **Invariant 5 (Zero-Context Privacy):**
     - **MUST NEVER** access, inspect, or serialize `hookContext.context`.
     - Zero user IDs, targeting keys, or PII can ever enter telemetry buffers.
   - **In-Memory Ring Buffer & Aggregator:**
     - Aggregates counts by composite key `(flag_key, variant, reason)`.
     - Flushes periodically (default: 5 minutes / 300_000ms, configurable) via HTTP `POST /v1/telemetry/batches`.
     - Payload schema per `docs/SpecDoc.md` §5.1:
       ```typescript
       {
         instance_id: string,
         batch_id: string, // ULID
         window_start: string, // ISO 8601
         window_end: string, // ISO 8601
         metrics: [
           { flag_key: string, variant: string, reason: string, count: number }
         ],
         propagation_lag_ms?: number,
       }
       ```
     - Sorts metrics by `flag_key ASC, variant ASC, reason ASC` before sending.
     - Buffer bulkhead: caps max distinct tuples in memory (e.g. max 5,000 keys) to prevent unbounded memory growth if high-cardinality flags are evaluated.
     - Drops batch cleanly on shutdown via `flush()`.

3. **SDK Options & Provider Wiring (`packages/sdk/src/provider.ts` & `index.ts`):**
   - Wire `StateClient` and `TelemetryHook` into `OverrideProviderOptions`:
     - `controlApiUrl?: string` (e.g., `"http://localhost:3000"`)
     - `serviceToken?: string`
     - `env?: string` (default: `"prod"`)
     - `longPollWaitSeconds?: number` (default: `30`)
     - `telemetryFlushIntervalMs?: number` (default: `300_000` = 5 min)
     - `enableLongPolling?: boolean` (default: `false` unless `controlApiUrl` is provided)
     - `enableTelemetry?: boolean` (default: `false` unless `controlApiUrl` is provided)
   - Lifecycle:
     - `provider.initialize()`: starts `StateClient` if enabled.
     - `provider.onClose()`: flushes `TelemetryHook` and stops `StateClient`.
     - Provider exposes `getTelemetryHook()` to easily register with OpenFeature client: `client.addHooks(provider.getTelemetryHook())` or registers automatically on client.

---

## 3. Invariants & Guardrails for PR 4

| Invariant                             | Non-Negotiable Rule                                                                   | Verification Check                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Invariant 5: Zero-Context Privacy** | `TelemetryHook` MUST NEVER inspect, read, or export `context`.                        | Unit test passing sensitive PII (`targetingKey`, `ssn`, `email`) and asserting flushed batch contains strictly 0 PII. |
| **Fail-Static Offline Resilience**    | Disconnecting Control API leaves existing leases valid until TTL expires. No crashes. | Test mocking fetch network rejection; assert leases remain active in `LeaseStore`.                                    |
| **Tamper-Proof Keyset Seam**          | Control API state cannot introduce unverified or unauthorized keys.                   | State payload leases and revocations are verified against pinned `Keyset` before entering `LeaseStore`.               |
| **Bulkhead Memory Safety**            | Telemetry aggregator ring buffer must have a hard bound.                              | Test flooding with 10,000 distinct flag keys; verify memory does not grow unboundedly.                                |

---

## 4. Suggested Skills for the Next Agent

Invoke these skills in order:

1. `test-driven-development`: Write failing tests in `state-client.test.ts` and `telemetry-hook.test.ts` before writing production code.
2. `codebase-design`: Design deep modules that cleanly encapsulate HTTP long-polling and telemetry flushing.
3. `verification-before-completion`: Run all 4 verification commands (`pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm test`) before claiming completion.

---

## 5. Step-by-Step Implementation Checklist for Next Agent

- [ ] **Step 1:** Create branch `feat/sdk-long-poll-telemetry` from `feat/sdk-override-provider`.
- [ ] **Step 2:** Define types in `packages/sdk/src/types.ts` (`StateClientOptions`, `TelemetryHookOptions`, `StateSyncPayload`, `TelemetryBatchPayload`).
- [ ] **Step 3 (TDD):** Implement `TelemetryHook` and `telemetry-hook.test.ts`:
  - OpenFeature `after` / `error` hook implementation.
  - Zero-context recording of `(flag_key, variant, reason)`.
  - In-memory aggregation and sorted batch flushing.
  - Buffer limit bulkhead protection.
- [ ] **Step 4 (TDD):** Implement `StateClient` and `state-client.test.ts`:
  - `GET /v1/sdk/state?env=prod&wait=30s` with `If-None-Match` and `304` handling.
  - Ingestion of `active_leases`, `revocations`, and `key_revocations` into `LeaseStore`.
  - Exponential backoff and fail-static offline behavior.
- [ ] **Step 5:** Wire `StateClient` and `TelemetryHook` into `OverrideProvider` and `OverrideProviderOptions`.
- [ ] **Step 6:** Export public symbols from `packages/sdk/src/index.ts`.
- [ ] **Step 7:** Run full monorepo verification: `pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm test`.
- [ ] **Step 8:** Commit with conventional commit format (`feat(sdk): implement ETag long-polling client and zero-context TelemetryHook`) and push to `origin/feat/sdk-long-poll-telemetry`.
