# SynapseState Handoff: Phase 2 — In-Process Audit Sealer (`apps/control-api`)

> **Target Session:** Implement PR 8 (`feat/control-api-audit-sealer`)  
> **Repository:** `synapsestate/synapsestate`  
> **Target Branch:** `feat/control-api-audit-sealer` (branch from `main` at `c312a50`)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Invariant 7 Tamper-Evident Audit Ledger)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§4.3, §7 DDL schemas, §8 Tamper-Evident Audit Ledger & Asynchronous Sealer)  
> - Technical Specification: [docs/SpecDoc.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/SpecDoc.md) (§2.1, §4.1)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 2.1 & Phase 2.2)  
> - ADR 0005 (In-Process Audit Sealer): [docs/adr/0005-in-process-audit-sealer-and-isolated-checkpointer.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0005-in-process-audit-sealer-and-isolated-checkpointer.md)  

---

## 1. Executive Summary & Monorepo State

PR 7 was reviewed, refined, approved, and merged into `main` ([PR #7](https://github.com/adityapawar112/SynapseState/pull/7), commit `c312a50`).

### Current Status:
- **Monorepo Health:** 100% green across all packages (Lint, Build, Typecheck, Test).
- **Test Suite:** 29 test files, 221 tests passing locally and in GitHub Actions CI.
- **Database Infrastructure:** PostgreSQL 16 schema migrations, pool isolation (`leasePool` and `telemetryPool`), and transaction helpers are operational in `apps/control-api/src/db/`.
- **Advisory Lock Primitives Available:**
  [`apps/control-api/src/db/transaction.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/db/transaction.ts) exports:
  - `AUDIT_SEALER_LOCK_NAME = "synapse_audit_sealer"`
  - `tryAuditSealerLock(client: PoolClient): Promise<boolean>` (uses `pg_try_advisory_xact_lock(hashtext(...))`)
  - `withAuditSealerTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<AuditSealerTransactionResult<T>>`
- **Tables Initialized:**
  `audit_pending` and `audit_events` tables are already created and verified by migration `003_create_audit_ledger.sql`.

---

## 2. Invariants & Architectural Requirements for PR 8

All code for PR 8 must strictly satisfy the following requirements:

1. **Request-Path Decoupling (ADR 0005 §1, ARCH §8.1):**
   - The emergency override ingestion path (`POST /v1/leases`) and revocation path (`POST /v1/leases/:id/revoke`) stage un-hashed rows into `audit_pending`.
   - The sealer operates asynchronously in the background. It must never block, lock, or slow down HTTP request handling.

2. **Transaction-Level Advisory Lock (ADR 0005 §2, ARCH §8.2.1):**
   - Must use `withAuditSealerTransaction(leasePool, ...)` which executes `pg_try_advisory_xact_lock(hashtext('synapse_audit_sealer'))`.
   - If another replica or worker holds the lock, it returns `{ acquired: false, result: null }` immediately without waiting.
   - **Critical Invariant:** Never use session-level advisory locks (`pg_try_advisory_lock`), which leak or fail under PgBouncer transaction pooling.

3. **Deterministic Seal Order & SHA-256 Hash Chaining (ADR 0005 §2, ARCH §8.2.3):**
   - Chain order is defined by **seal order**, not request insertion order.
   - Sequence numbers (`seq`) in `audit_events` are contiguous and assigned at seal time.
   - Unsealed events are read from `audit_pending` ordered by `created_at ASC, id ASC` with `LIMIT 100`.
   - Hash formula:
     $$\text{hash}_n = \text{SHA-256}(\text{hash}_{n-1} \parallel \text{RFC8785Canonical}(\text{event}_n))$$
   - Genesis block: For the very first event in `audit_events` (`seq = 1`), `prev_hash` is 64 zeros (`0`.repeat(64)).
   - For all subsequent events, `prev_hash` is the `hash` of event `seq - 1`.
   - RFC 8785 canonical serialization must be used for canonicalizing `event_n` (via `@synapsestate/lease`).

4. **Atomic Batch Commit & Deletion (ARCH §8.2.3):**
   - Inserting sealed rows into `audit_events` and deleting the corresponding processed rows from `audit_pending` must occur in the **exact same transaction**.

5. **Loop Hygiene & Graceful Shutdown (ADR 0005 §2, ARCH §8.2.2):**
   - Must use self-rescheduling recursive `setTimeout` with an `isSealing` in-flight guard (never `setInterval`).
   - Standard tick interval: 1000ms (configurable).
   - Top-level `try/catch` error containment: database errors or transient connection dropouts must log errors without crashing Node.js runtime.
   - Graceful shutdown (`stop()`): wait for any active in-flight sealing batch to commit before releasing connections and completing shutdown.

6. **Stall Observability (ADR 0005 §2, ARCH §8.2.4):**
   - Computes oldest pending event age in seconds and exports Prometheus gauge `synapse_audit_pending_age_seconds` via `prom-client`.
   - When `audit_pending` is empty, the gauge reports `0`.

7. **Cryptographic Checkpointer Boundary (Non-Goal for PR 8):**
   - The in-process sealer does **not** sign external S3/Git checkpoints. External checkpoint signing is strictly delegated to the independent Kubernetes CronJob (`synapse-checkpoint-signer`) in Phase 2.4.

---

## 3. Scope of Deliverables for PR 8

### Deliverables to Create in `apps/control-api/`:

```
apps/control-api/src/sealer/
├── chain.ts         # RFC 8785 canonical hashing, SHA-256 chain math & verification helpers
├── chain.test.ts    # Unit tests for hash chaining, determinism & tamper detection
├── sealer.ts        # AuditSealer class, transaction advisory lock, Prometheus metrics, loop hygiene
├── sealer.test.ts   # Integration tests with PostgreSQL (batching, lock skipping, atomicity, shutdown)
└── index.ts         # Module exports
```

### Server Wiring:
- In [`apps/control-api/src/app.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/app.ts) and [`apps/control-api/src/index.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/index.ts):
  - Add optional `auditSealer` to `ServerOptions` / `buildServer`.
  - Provide `start()` and `stop()` lifecycle hooks.
  - Keep sealer disabled by default in route unit tests to prevent test database contention, while enabling it explicitly in sealer tests and production startup.

---

## 4. Verification & Quality Gates

The implementation must pass all checks before PR creation:
```bash
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm run test:coverage
```

### Required Test Scenarios:
1. **Chain Math (`chain.test.ts`):**
   - Genesis block uses 64 zeros as `prev_hash`.
   - Hash chaining is deterministic with RFC 8785 canonical payload serialization.
   - Any payload tampering, sequence change, or timestamp mutation breaks chain verification.
2. **Sealer Loop (`sealer.test.ts`):**
   - Single replica seals pending events into `audit_events` and deletes them from `audit_pending`.
   - Batch size is capped at 100 (`LIMIT 100`).
   - When two sealers tick concurrently, only one acquires `pg_try_advisory_xact_lock`; the other skips cleanly with zero errors.
   - If a batch throws an error, the transaction rolls back cleanly, leaving `audit_pending` untouched.
   - `synapse_audit_pending_age_seconds` reports accurate lag and drops to 0 when clear.
   - Graceful shutdown (`stop()`) awaits in-flight batch completion.

---

## 5. Suggested Skills to Invoke

When picking up this handoff, activate the following skills:
- `test-driven-development`: Write failing tests for hash chaining (`chain.test.ts`) and sealer execution (`sealer.test.ts`) before writing the implementation.
- `verification-before-completion`: Run full lint, build, typecheck, and test coverage before asserting completion or submitting the PR.
- `requesting-code-review`: Craft structured review context with commit SHAs upon task completion.
- `codebase-design`: Ensure clean module boundaries and deep interface encapsulation in `apps/control-api/src/sealer/`.
