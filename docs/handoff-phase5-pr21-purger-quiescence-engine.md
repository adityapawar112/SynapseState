# SynapseState Handoff: Phase 5 PR 21 Onboarding (Purger Quiescence & Candidate Qualification Engine)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 5 (Weeks 9 – 10: Telemetry Qualification & Codebase Scanner)  
> **Current Target:** PR 21 (`feat/purger-quiescence-engine`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Branch:** `test/chaos-drills-and-postmortem` (PR 20 complete, peer-reviewed, verified, approved, and pushed to origin; ready to merge into `main` before branching `feat/purger-quiescence-engine`)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§7.1 Relational Schema, §9 Telemetry-Driven Stale Detection & Scanner, §10 Disaster Recovery & Threat Model)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 5, Deliverable 5.1 & PR 21)  
> - Architectural Decision Records: [docs/adr/0007-per-flag-storage-and-pull-based-attribution.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0007-per-flag-storage-and-pull-based-attribution.md)

---

## 1. Suggested Skills

The next agent picking up this task should call the following skills:
- `test-driven-development`: Write unit test suites with fixture matrices (single-variant steady state, multi-variant churn, silent service block, active lease block, killswitch/permanent exemption, 0-evaluation edge case) before writing the qualification logic.
- `domain-modeling`: Model the qualification domain vocabulary (`CandidateFlag`, `QualificationResult`, `DisqualificationReason`, `WinningVariant`, `ServiceConsumerStatus`) cleanly in `apps/purger/src/qualification/types.ts`.
- `verification-before-completion`: Run all quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test`) with raw command output before claiming completion.

---

## 2. Executive Summary & Monorepo State (PR 20 Completion)

**PR 20 (`test/chaos-drills-and-postmortem`)** is complete, peer-reviewed with an unconditional **`APPROVE`** verdict, polished with all review recommendations, and pushed to `origin/test/chaos-drills-and-postmortem` (`31754d6`):
- **Chaos Drill 1 (`test/drills/drill1-airgap-override.test.ts`):**
  - Proves out-of-band emergency override enforcement during total Control API outage (`ECONNREFUSED`).
  - Verifies Invariant 2 cryptographic validation (rejecting unknown keys, revoked keys, and tampered payloads).
  - Verifies deterministic ULID tie-breaking on identical `issued_at` timestamps.
  - Verifies clean fallback to delegate baseline upon TTL expiry without throws.
- **Chaos Drill 2 (`test/drills/drill2-clock-skew.test.ts`):**
  - Invariant 3 dual-clock expiry under NTP clock rewinds (-24h to +24h), forward clock jumps, anti-future skew defense, cold restart bounds, and monotonic timestamp preservation on re-ingestion.
- **Chaos Drill 3 (`test/drills/drill3-revocation-partition.test.ts`):**
  - Bounded exposure to remaining TTL during network partitions, instant in-memory eviction upon partition healing, and fast-path key revocation delivery.
- **Production Harness & Tooling:**
  - Automated bash runner (`test/drills/run-drills.sh`) with POSIX `100755` executable bit.
  - Monorepo script `pnpm run test:drills`.
  - `LeaseStore` bounded monotonic tracking (`DEFAULT_MAX_TRACKED_MONOTONIC_LEASES = 2000`) with FIFO pruning and proactive cleanup on eviction/revocation.
- **Phase 4 Milestone Code Review Hardening (Approved with Comments):**
  - **Monotonic Anchor Continuity (`packages/sdk/src/lease-store.ts`):** `addLease` falls back to live in-memory active lease `firstSeenMonoMs` if the tracking map anchor was pruned, and FIFO capacity eviction preserves active lease anchors.
  - **Fail-Closed Webhook HMAC (`apps/control-api/src/routes/webhooks.ts`):** Rejects with 500 `RAW_BODY_UNAVAILABLE` if raw buffer payload is absent, preventing false-rejection risks from non-canonical JSON re-serialization.
  - **Promotion Advisory Locking (`apps/control-api/src/routes/leases.ts`):** Uses `pg_try_advisory_xact_lock` inside `withTransaction` during lease promotion, eliminating TOCTOU concurrency races on simultaneous flag promotions.
  - **Checkpoint Signer Keyset Mount (`deploy/helm/control-api/templates/cronjob-checkpoint-signer.yaml`):** Explicitly mounts Git keyset ConfigMap and wires `--keyset /etc/synapse/keyset/keyset.json` into the CronJob container.
  - **CLI Passphrase Hygiene (`packages/cli/src/commands/audit.ts`):** Added warning on `--password` CLI argument in `synapse audit checkpoint` to protect against process table exposure, matching `synapse lease create`.
  - **Air-Gap Revocation Channel (`packages/sdk/src/emergency-scanner.ts`):** Added out-of-band support for `*-revocation.json` and `*-keyrevocation.json` files, closing the air-gapped revocation gap during total control-plane severance.
- **Verification Evidence:**
  - Chaos drills (`pnpm run test:drills`): **14/14 passed** across 3 test files in 4.53s.
  - Monorepo build (`pnpm -r run build`): 0 errors across all 7 workspace packages.
  - Monorepo linter (`pnpm run lint`): 0 errors.
  - Full test suite (`pnpm test`): **350+ tests passed** (0 failures) monorepo-wide.
- **Recent Git Commits:**
  - `31754d6`: `fix(test): address PR 20 peer review feedback on drills, lease store bounds, and postmortem`
  - `ce31c3e`: `docs: replace Phase 4 PR 20 handoff with Phase 5 PR 21 Purger quiescence engine`
  - `937160d`: `feat(test): chaos drills and formal disaster recovery postmortem (PR 20)`
  - `e20ef1c`: `Merge pull request #19 from adityapawar112/feat/audit-checkpoint-verifier`

---

## 3. PR 21 Scope & Deliverables (`feat/purger-quiescence-engine`)

The objective for Phase 5 PR 21 is to deliver **Deliverable 5.1 (Quiescence & Candidate Qualification Engine)** in `apps/purger/` according to [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md#L217-L228) and [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L593-L635).

```
apps/purger/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── index.test.ts
    └── qualification/
        ├── types.ts              # Domain models (CandidateFlag, QualificationResult, RefusalReason)
        ├── queries.ts            # SQL rollups querying flag_usage_daily, services, flags, leases
        ├── engine.ts             # Pure qualification rules evaluator
        ├── engine.test.ts        # Comprehensive unit tests with fixture matrices
        └── queries.test.ts       # Query generation & parameterized SQL validation tests
```

### Detailed Deliverable Breakdown:

#### 1. Domain Types (`apps/purger/src/qualification/types.ts`)
- `FlagLifecycleClass`: `"release" | "killswitch" | "permanent"`
- `ServiceStatus`: `"ACTIVE" | "SILENT" | "RETIRED"`
- `QualificationStatus`: `"QUALIFIED" | "DISQUALIFIED"`
- `DisqualificationReason`:
  - `EXCLUDED_LIFECYCLE_CLASS`: Flag class is `killswitch` or `permanent` (only `release` flags qualify).
  - `MULTI_VARIANT_ACTIVE`: More than one variant was evaluated within the quiescence window.
  - `INSUFFICIENT_WINDOW`: Window of recorded telemetry is shorter than the configured threshold (e.g. 35 days).
  - `BLOCKED_BY_SILENT_SERVICE`: At least one evaluating consumer service has status `SILENT` (no heartbeat for >14 days). Must include the list of offending service names.
  - `ACTIVE_LEASE_EXISTS`: An emergency lease is currently `ACTIVE` or undergoing Git promotion for this flag.
  - `UNREGISTERED_FLAG`: Flag is not found in the flag registry.
- `CandidateFlag`:
  ```typescript
  export interface CandidateFlag {
    flagKey: string;
    env: string;
    winningVariant: string;
    totalEvaluations: number;
    evaluatingServices: string[];
    windowDays: number;
    firstSeen: string;
    lastSeen: string;
  }
  ```
- `QualificationResult`:
  ```typescript
  export interface QualificationResult {
    flagKey: string;
    env: string;
    status: QualificationStatus;
    candidate?: CandidateFlag;
    reasons: DisqualificationReason[];
    blockingServices?: string[];
  }
  ```

#### 2. SQL Rollup Engine (`apps/purger/src/qualification/queries.ts`)
- Queries Postgres tables defined in [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L489-L500):
  - `flags` (`key`, `env`, `class`, `owner`, `description`)
  - `flag_usage_daily` (`flag_key`, `env`, `service`, `variant`, `usage_date`, `eval_count`)
  - `services` (`name`, `env`, `status`, `last_seen`, `silent_since`)
  - `leases` (`flag_key`, `env`, `state`)
- Aggregates daily telemetry across the evaluation window (configurable default: 35 days, up to 45 days):
  - Groups by `(flag_key, env, variant)` and counts evaluations.
  - Identifies distinct consumer services per flag.
  - Cross-references service statuses from `services`.
  - Checks for active leases (`leases.state = 'ACTIVE'`).

#### 3. Pure Qualification Engine (`apps/purger/src/qualification/engine.ts`)
- Strict separation between I/O and domain evaluation:
  - `evaluateCandidateQuiescence(snapshot: FlagTelemetrySnapshot, options?: QualificationOptions): QualificationResult`
- **Authoritative Rule Matrix ([docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) §9.1):**
  1. **Lifecycle Class:** Must be `class === 'release'`. `killswitch` and `permanent` are strictly disqualified.
  2. **Invariance Window:** Must serve a single variant continuously for $\ge 35\text{ days}$ (or 0 evaluations across entire window).
  3. **Per-Flag Consumer Coverage:** 100% of evaluating consumer services within the window must have status $\in \{\text{ACTIVE}, \text{RETIRED}\}$. If any service is `SILENT`, the flag is blocked and lists the silent services.
  4. **Lease Quiescence:** Zero active emergency leases or un-finalized promotions.
- Batch evaluation support:
  - `qualifyFlagTelemetryBatch(snapshots: FlagTelemetrySnapshot[], options?: QualificationOptions): QualificationResult[]`

#### 4. Automated Tests (`apps/purger/src/qualification/*.test.ts`)
- **Unit Tests (`engine.test.ts`):**
  - Standard qualified release flag (single variant for 35 days, all services ACTIVE) -> `QUALIFIED`.
  - Multi-variant traffic (e.g. 95% variant A, 5% variant B) -> `DISQUALIFIED` (`MULTI_VARIANT_ACTIVE`).
  - Killswitch flag with single variant -> `DISQUALIFIED` (`EXCLUDED_LIFECYCLE_CLASS`).
  - Permanent flag -> `DISQUALIFIED` (`EXCLUDED_LIFECYCLE_CLASS`).
  - Active emergency lease exists -> `DISQUALIFIED` (`ACTIVE_LEASE_EXISTS`).
  - Evaluating service has `SILENT` status -> `DISQUALIFIED` (`BLOCKED_BY_SILENT_SERVICE`) with service name attached.
  - Evaluating service has `RETIRED` status while others `ACTIVE` -> `QUALIFIED` (retired services do not block).
  - 0-evaluations across entire window -> `QUALIFIED` with default variant.
  - Insufficient history (<35 days) -> `DISQUALIFIED` (`INSUFFICIENT_WINDOW`).
- **Query Tests (`queries.test.ts`):**
  - Verify SQL query syntax, parameter bindings, date math (`NOW() - INTERVAL '35 days'`), and group-by aggregations.

---

## 4. Invariants & Boundaries for PR 21

1. **Invariant 6 (Read-Only Codebase Scanner):** The qualification engine acts as a pure read-only analyzer. It must not execute code, alter flag definitions, or modify database state.
2. **Invariant 8 (Ecosystem & Library-First Primitive Reuse):** Use standard TypeScript types, Zod schemas for input validation, and established database query patterns matching `apps/control-api`.
3. **Deterministic Seam:** Keep the core qualification logic pure (zero database handles or network calls inside `engine.ts`) to enable fast, zero-flakiness property testing and unit testing.

---

## 5. Immediate Next Steps for Next Session

1. **Merge PR 20 into `main`:**
   ```bash
   git checkout main
   git merge test/chaos-drills-and-postmortem
   git push origin main
   ```
2. **Branch PR 21:**
   ```bash
   git checkout -b feat/purger-quiescence-engine
   ```
3. **Implement Domain Types & Pure Qualification Engine:**
   - Create `apps/purger/src/qualification/types.ts`
   - Create `apps/purger/src/qualification/engine.ts`
   - Create `apps/purger/src/qualification/queries.ts`
4. **Implement Test Suites:**
   - Create `apps/purger/src/qualification/engine.test.ts`
   - Create `apps/purger/src/qualification/queries.test.ts`
5. **Verify Monorepo Gates:**
   - Run `pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test`.
