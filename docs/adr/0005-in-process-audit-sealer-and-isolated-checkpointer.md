# 5. In-Process Audit Sealer with Transaction Locks and Isolated Checkpointer

Date: 2026-10-09  
Status: Accepted

---

## Context

Audit compliance and non-repudiation require tamper-evident logging of all feature flag overrides and lifecycle events:

1. **Request-Path Bottleneck:** Computing sequential SHA-256 hash chains synchronously in PostgreSQL requires acquiring global transaction locks (e.g. `pg_advisory_xact_lock`), serializing administrative operations and risking write starvation during multi-incident emergencies.
2. **Daemon Operational Overhead:** Running an independent long-running sealer daemon process increases container count, Helm manifest complexity, and failure monitoring overhead.
3. **Connection Pooling Hazards:** Session-level advisory locks (`pg_try_advisory_lock`) break under connection poolers like PgBouncer in transaction mode, leading to duplicate sealers or abandoned locks upon connection recycling.
4. **Trust Anchor Compromise Risk:** Running the external checkpoint signer inside the API process exposes external anchoring credentials to web compromise.

---

## Decision

We chose an **asynchronous in-process audit sealer** combined with **transaction-level advisory locking** and an **isolated external Kubernetes CronJob checkpointer**:

1. **Request-Path Decoupling:**
   - In the same short database transaction as any administrative state change (lease creation, revocation, or Git promotion webhook), the Control API inserts an un-hashed record into `audit_pending` and `change_events`. No advisory lock is acquired on the request path.
2. **In-Process Single-Writer Sealer:**
   - The sealing loop runs directly within `apps/control-api`.
   - **Transaction-Level Advisory Locking:** The sealer executes:
     ```sql
     SELECT pg_try_advisory_xact_lock(hashtext('synapse_audit_sealer'));
     ```
     inside each transaction. If another replica holds the lock, the call returns `false` and the tick skips cleanly without waiting. This is completely safe with PgBouncer in transaction pooling mode.
   - **Loop Hygiene:** Uses recursive `setTimeout` with an `isSealing` in-flight guard (never `setInterval`), capped at 100 events per batch (`LIMIT 100`), wrapped in `try/catch` error containment, with graceful `SIGTERM` handling that commits the active in-flight batch before shutdown.
   - **Chain Order by Seal Time:** Sequence numbers `seq` and SHA-256 hashes are assigned at seal time by the sealer, not request insertion time, ensuring unbroken hash chain continuity despite concurrent out-of-order commits.
   - **Stall Observability:** Exports `synapse_audit_pending_age_seconds` with an alert rule (>30s) to detect stalled sealers.
3. **Decoupled External Checkpoint Signer:**
   - Checkpoint signing is strictly forbidden inside the API process.
   - It runs as an independent Kubernetes CronJob (`synapse-checkpoint-signer`) with dedicated, restricted Ed25519 anchoring keys and a write-only IAM role on the immutable external store (AWS S3 Object Lock in Compliance Mode or protected Git branch).
   - Even a total compromise of the Control API container or database cannot forge historical checkpoints.

---

## Consequences

### Positive

- Completely eliminates database lock contention from the emergency override creation path.
- Runs in-process without daemon overhead while remaining 100% compatible with PgBouncer transaction pooling.
- External anchoring keys remain cryptographically isolated from the network-exposed API process.
- Ledger integrity can be verified independently from genesis via `synapse audit verify`.

### Negative

- Audit events experience a slight sealing lag (≈ 1 second), during which unsealed records reside in `audit_pending` before entering `audit_events`.
