# SynapseState Handoff: Phase 1 — SDK OverrideProvider, Keyset Watcher & Emergency Scanner (`packages/sdk`)

> **Target Session:** Implement PR 3 (`feat/sdk-override-provider`)
> **Repository:** `synapsestate/synapsestate`
> **Primary Charter & Specs:**
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md)
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md)
> - Technical Specification: [docs/SpecDoc.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/SpecDoc.md)
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md)
> - ADR 0001 (Delegate Evaluation): [docs/adr/0001-delegate-evaluation-to-openfeature.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0001-delegate-evaluation-to-openfeature.md)
> - ADR 0003 (State Delivery & Emergency Fallback): [docs/adr/0003-etag-long-polling-for-state-delivery.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0003-etag-long-polling-for-state-delivery.md)

---

## 1. Executive Summary & Monorepo State

### 1.1 PR 1 Completed: Cryptographic Lease Core & Schemas (`packages/lease`)
- **Branch:** `feat/lease-crypto-schemas`
- **PR URL:** [https://github.com/adityapawar112/SynapseState/pull/1](https://github.com/adityapawar112/SynapseState/pull/1) (Merged to `main`)
- **Delivered:** RFC 8785 canonicalization, Ed25519 signing/verification with domain prefixes, Zod schemas, dual-clock expiry validator (`evaluateLeaseExpiry`, `isLeaseActive`), and Git-pinned keyset parser and policy verifiers (`parseKeysetJson`, `verifyLeaseWithKeyset`, `verifyRevocationWithKeyset`, `verifyKeyRevocationWithKeyset`, `canRevokeKey`).
- **Tests:** 91 unit and property tests passing in `packages/lease`.

### 1.2 PR 2 Completed: Conformance Golden Vectors & Runner (`packages/conformance`)
- **Branch:** `feat/conformance-golden-vectors`
- **PR URL:** [https://github.com/adityapawar112/SynapseState/pull/2](https://github.com/adityapawar112/SynapseState/pull/2)
- **Delivered:** 14 deterministic JSON fixture files (55 test vectors) under [`fixtures/`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/conformance/fixtures), reproducible fixture generator [`generate-fixtures.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/conformance/scripts/generate-fixtures.ts), pure TypeScript runner [`runner.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/conformance/src/runner.ts) enforcing authoritative keyset-policy seams, canonical failure codes (`SIGNATURE_INVALID`, `UNKNOWN_KEY`, `UNAUTHORIZED_SIGNER`), canonical base64url malleability rejection, unknown-`kid` rejection, and single-byte payload mutation rejection.
- **Tests:** 3 test files, 22 passing tests in `packages/conformance` with 0 superficial checks.
- **Whole Monorepo Verification:** 117/117 tests passing, 0 build errors, 0 typecheck errors, 0 lint warnings.

---

## 2. Next Ticket: PR 3 Scope & Deliverables

- **Target Branch:** `feat/sdk-override-provider` (branch from `feat/conformance-golden-vectors` or `main` if merged)
- **Target Package:** [`packages/sdk`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk)
- **PR Title:** `feat(sdk): implement OverrideProvider, keyset watcher, and emergency directory scanner`

### Core Components to Implement

1. **`OverrideProvider` ([`packages/sdk/src/provider.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk/src/provider.ts)):**
   - Implements OpenFeature `Provider` interface (`@openfeature/server-sdk`).
   - Wraps any underlying delegate OpenFeature provider (e.g. `InMemoryProvider`, `flagd`, JSON file provider).
   - Hot-path evaluation methods:
     - `resolveBooleanEvaluation(flagKey, defaultValue, context, logger)`
     - `resolveStringEvaluation(flagKey, defaultValue, context, logger)`
     - `resolveNumberEvaluation(flagKey, defaultValue, context, logger)`
     - `resolveObjectEvaluation(flagKey, defaultValue, context, logger)`
   - **Hot-Path Logic:**
     1. Queries `LeaseStore.getActiveLease(flagKey)`.
     2. If active lease exists with matching type: returns override immediately with:
        - `reason: "OVERRIDE"`
        - `variant: String(activeLease.value)`
        - `flagMetadata: { "synapse.override": true, "synapse.lease_id": activeLease.leaseId, "synapse.issued_by": activeLease.kid, "synapse.effective_expiry": activeLease.effectiveExpiry.toISOString() }`
     3. If no active lease or expired: immediately delegates to `this.delegate.resolve*Evaluation(...)`.
     4. **Invariant 1 Exception Shielding:** Wrap all lookup and extraction in `try/catch`. On *any* error, log a warning, increment an internal error metric, and fall back to `this.delegate.resolve*Evaluation(...)`. Application traffic must NEVER crash or be blocked.

2. **`LeaseStore` ([`packages/sdk/src/lease-store.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk/src/lease-store.ts)):**
   - In-memory store holding active, verified leases indexed by `flag_key`.
   - Methods:
     - `addLease(envelope: LeaseEnvelope, keyset: Keyset): boolean`
     - `getActiveLease(flagKey: string): ActiveLease | undefined`
     - `applyRevocation(envelope: RevocationEnvelope, keyset: Keyset): boolean`
     - `applyKeyRevocation(envelope: KeyRevocationEnvelope, keyset: Keyset): boolean`
     - `evictExpiredLeases(): number`
     - `handleKeysetUpdate(newKeyset: Keyset): void`
   - **Expiry Invariant 3:** Whenever `getActiveLease` is called (or during periodic eviction), evaluate `evaluateLeaseExpiry` / `isLeaseActive` using current wall clock and monotonic clock (`performance.now()`). If expired, evict and return `undefined`.
   - **Keyset Eviction:** When `handleKeysetUpdate` is called, inspect all in-memory leases. If any lease was signed by a `kid` that was removed from `newKeyset` or revoked by key revocations, immediately evict that lease from memory.

3. **`KeysetWatcher` ([`packages/sdk/src/keyset-watcher.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk/src/keyset-watcher.ts)):**
   - Hot-reload watcher monitoring a mounted Git-pinned keyset file at `/etc/synapse/keyset/keyset.json` (configurable for testing).
   - **Invariant ([ARCHITECTURE.md:311-312](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L311)):** Polls file hash (`SHA-256(fileContent)`) every **10 seconds** (configurable). **Explicitly prohibits `fs.watch`** (which fails on Kubernetes symlink atomic swaps) and prohibits `subPath` mounts (which never receive ConfigMap updates).
   - Parses content via `parseKeysetJson` from `@synapsestate/lease`.
   - Authoritative empty keyset `{}`: immediately acts as "revoke all keys" directive.
   - Bounded staleness fallback: If file read fails or becomes temporarily unreadable during Kubernetes ConfigMap projection, retain in-memory keyset for up to 15 minutes before failing static.
   - Emits change events / invokes callback on `LeaseStore` to evict invalidated keys.
   - Clean lifecycle: `start()` and `stop()` to release timers/watchers.

4. **`EmergencyScanner` ([`packages/sdk/src/emergency-scanner.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk/src/emergency-scanner.ts)):**
   - Out-of-band air-gapped emergency override channel (ADR 0003).
   - Scans directory (default: `/etc/synapse/emergency-leases/`, configurable for testing).
   - Reads all `*.json` files.
   - Parses each file as a `LeaseEnvelopeSchema`.
   - **Authoritative Keyset-Policy Seam:** Cryptographically verifies each envelope against the currently active trusted keyset using `verifyLeaseWithKeyset(envelope, keyset)` from `@synapsestate/lease` (strictly enforcing pinned-key membership, active key status, `lease_signer` permission, `max_ttl_seconds` policy ceiling, and Ed25519 signature validity).
   - **Key-Revocation Denial:** Confirms the signing key has not been explicitly invalidated by active signed key revocations via `!isKeyRevoked(kid, keyRevocations)`.
   - Prohibit using raw `verifyLease` directly for keyset validation (raw `verifyLease` accepts only a raw public key and bypasses membership, status, role, and TTL policies).
   - Ingests valid unexpired leases into `LeaseStore`.
   - Runs on startup and on periodic poll / directory change.
   - Ignores corrupted or invalid files without crashing (logs warnings).

5. **SDK Options & Public Surface ([`packages/sdk/src/index.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk/src/index.ts)):**
   - Clean export of `OverrideProvider`, `LeaseStore`, `KeysetWatcher`, `EmergencyScanner`, and SDK configuration options.

---

## 3. Invariants & Guardrails for PR 3

| Invariant | Non-Negotiable Rule | Verification Check |
|---|---|---|
| **Invariant 1: Fail-Safe Hot Path** | Any internal error in `OverrideProvider` MUST catch and delegate to underlying provider. Zero app crashes. | Simulate throwing exceptions inside `LeaseStore.getActiveLease` and verify delegate returns baseline value. |
| **Invariant 2: Pinned Keyset Trust Root** | Keyset is strictly mounted from Git/disk at `/etc/synapse/keyset/keyset.json`. Control API never touches it. Empty keyset `{}` evicts all leases. | Test empty keyset immediately disables all active overrides. |
| **Invariant 3: Dual-Clock Expiry** | Leases evaluated with both monotonic time and wall clock bounds. Expired leases must never return override. | Inject time past TTL / clock skew and verify fallback to delegate. |
| **Invariant 5: Zero-Context Privacy** | Provider methods receive `EvaluationContext`, but `OverrideProvider` and `LeaseStore` must NEVER log or egress it. | Inspect all provider method implementations to ensure `context` is passed strictly to `delegate`. |
| **Air-Gapped Out-of-Band Fallback** | SREs applying signed leases into `/etc/synapse/emergency-leases/` must activate overrides without Control API. | Test `EmergencyScanner` ingesting signed fixture files into `LeaseStore`. |

---

## 4. Suggested Skills for the Next Agent

Invoke these skills in the following order:
1. `test-driven-development`: Write failing tests in `packages/sdk/src/*.test.ts` before writing each component (`provider.test.ts`, `lease-store.test.ts`, `keyset-watcher.test.ts`, `emergency-scanner.test.ts`).
2. `codebase-design`: Ensure `OverrideProvider` is a deep module that hides storage, verification, and file polling complexity behind the standard OpenFeature `Provider` interface.
3. `verification-before-completion`: Run `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm run lint`, and `pnpm test` across the monorepo before committing and claiming completion.

---

## 5. Step-by-Step Implementation Checklist for Next Agent

- [ ] **Step 1:** Create branch `feat/sdk-override-provider` from `feat/conformance-golden-vectors`.
- [ ] **Step 2:** Define types in `packages/sdk/src/types.ts` (`ActiveLease`, `SdkOptions`, `LeaseStoreMetrics`).
- [ ] **Step 3 (TDD):** Implement `LeaseStore` and `lease-store.test.ts`:
  - In-memory storage, dual-clock expiry checks, keyset revocation eviction, duplicate resolution.
- [ ] **Step 4 (TDD):** Implement `OverrideProvider` and `provider.test.ts`:
  - Wrap OpenFeature `Provider` interface, test boolean, string, number, and object evaluations.
  - Test fail-safe exception shielding (simulated internal errors falling through to delegate).
- [ ] **Step 5 (TDD):** Implement `KeysetWatcher` and `keyset-watcher.test.ts`:
  - 10s file-hash polling on `/etc/synapse/keyset/keyset.json` (prohibiting `fs.watch`), hash change detection, empty `{}` handling, fallback cache staleness ceiling.
- [ ] **Step 6 (TDD):** Implement `EmergencyScanner` and `emergency-scanner.test.ts`:
  - Directory scanning of `*.json`, keyset policy verification via `verifyLeaseWithKeyset` + `isKeyRevoked`, ingestion into `LeaseStore`.
- [ ] **Step 7:** Export all APIs from `packages/sdk/src/index.ts`.
- [ ] **Step 8:** Run full monorepo verification: `pnpm test`, `pnpm -r run build`, `pnpm -r run typecheck`, and `pnpm run lint`.
- [ ] **Step 9:** Commit using conventional commit format (`feat(sdk): implement OverrideProvider, keyset watcher, and emergency directory scanner`) and push to `origin/feat/sdk-override-provider`.
