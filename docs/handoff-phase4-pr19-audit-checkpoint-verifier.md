# SynapseState Handoff: Phase 4 PR 19 Onboarding (Audit Checkpoint Signer & Ledger Verifier)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 4 (Weeks 7 – 8: Incident Break-Glass Loop & Git Reconciliation)  
> **Current Target:** PR 19 (`feat/audit-checkpoint-verifier` / `feat/cli-audit-verify-cronjob`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Branch:** `feat/git-promotion-reconciliation` (PR 18 complete, reviewed, all feedback addressed, ready to merge into `main` before branching PR 19)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–7, §5 SLOs, §6 Verification Guidelines)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§4.4 Audit Ledger & External Anchoring, §5 State Machine & Lifecycle, §6 Database Schema)  
> - Audit Sealer & Ledger: [`apps/control-api/src/sealer/chain.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/sealer/chain.ts), [`apps/control-api/src/sealer/sealer.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/sealer/sealer.ts)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 4, PR 18 & PR 19)  
> - Technical Specification: [docs/SpecDoc.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/SpecDoc.md) (§4.1 Control API Routes, §4.4 Audit Ledger)  
> - PR 18 Implementation: [GitHub PR #18](https://github.com/adityapawar112/SynapseState/pull/18) (Commits `4337236` → `e70909b` → `2f9c299`)

---

## 1. Executive Summary & Monorepo State (PR 18 Completion)

**PR 18 (`feat/git-promotion-reconciliation`)** is **100% complete, reviewed, verified, and submitted**:
- **Dual-Control Git Promotion Workflow:** Implemented end-to-end Git reconciliation via GitHub App reconciler, fulfilling Invariant 4 (no direct-to-main pushes; human review and merge of Git PR serves as mandatory secondary approval).
- **GitHub Reconciler (`apps/control-api/src/github/`):**
  - AST-preserving YAML document modification via `yaml` `Document`, updating `defaultVariant` while keeping comments and structure intact.
  - Charset validation enforcing `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$` on both `flag_key` and `env`, preventing path traversal (`../../etc`) and ref injection.
  - Symmetric word-boundary regex matching (`(^|[^a-z0-9-])${flagKey}($|[^a-z0-9-])`) preventing substring collisions (`pay` vs `pay-v2`).
  - Stale PR conflict detection returning HTTP 409 `STALE_PR_CONFLICT` with existing PR link.
  - Octokit 422 branch race handling ("Reference already exists") mapped cleanly to 409 conflict.
  - Promotion PRs opened with `draft: true` to prevent automated merge bots from bypassing peer review.
- **Control API Endpoints:**
  - `POST /v1/leases/:id/promote`: Authenticated via Bearer token with `operator` or `admin` role check (RBAC), strict Crockford ULID format validation (`/^[0-9A-HJKMNP-TV-Z]{26}$/`), optional request body `env` mismatch validation (HTTP 400 `ENVIRONMENT_MISMATCH`), and resilient post-creation DB persistence.
  - `POST /v1/webhooks/github`: Timing-safe HMAC SHA-256 signature verification (`x-hub-signature-256`) with `SYNAPSE_WEBHOOK_SECRET` fallback and pre-parsed raw body buffer. Source repository verification (`expectedOwner`, `expectedRepo`, `expectedBaseBranch`) with boot-time warning and fail-closed missing-repo handling. State-machine guard enforcing that `REVOKED` leases cannot be promoted (returns `ignored`). Atomic Postgres transaction updating state to `PROMOTED`, staging `GIT_MERGE` and `LEASE_PROMOTED` into `change_events` and `audit_pending`, active metric decrement, and long-polling notification.
- **SRE CLI `synapse promote <lease_id>`:**
  - Full CLI command in [`packages/cli/src/commands/promote.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/promote.ts) with ULID validation, `--env` body serialization, 30 s `AbortSignal` timeout, 403 Forbidden handling, conflict reporting, and styled terminal box.
- **Verification Evidence:**
  - Monorepo build and typecheck: 0 errors across all 7 workspace packages.
  - Linter: 0 errors, 0 warnings (`pnpm run lint`).
  - Tests: **346 tests passed** across 34 test files monorepo-wide (`pnpm test`).

---

## 2. PR 19 Scope & Deliverables (`feat/audit-checkpoint-verifier`)

The target milestone for the upcoming session is **PR 19 (`feat/audit-checkpoint-verifier`)**, completing **Phase 4 Deliverable 4.3 (External Checkpoint Anchoring) & SRE CLI `synapse audit verify`**:

```
packages/lease/src/
├── checkpoint.ts             # Checkpoint envelope schema, RFC 8785 canonicalization & signing/verification
└── checkpoint.test.ts        # Unit tests for checkpoint cryptographic verification
apps/control-api/src/
├── routes/
│   ├── audit.ts              # GET /v1/audit/events (streaming/paging sealed ledger) & GET /v1/audit/checkpoint/latest
│   └── audit.test.ts         # Route tests for audit ledger streaming and auth
packages/cli/src/
├── commands/
│   ├── audit.ts              # synapse audit verify and synapse audit checkpoint implementations
│   └── audit.test.ts         # Unit & integration tests for audit verification & tampering detection
└── index.ts                  # Register `audit` command group
deploy/helm/control-api/
└── templates/
    └── cronjob-checkpoint-signer.yaml  # Conformance & validation of Kubernetes CronJob
```

### Detailed Deliverable Breakdown:

#### 1. Checkpoint Data Model & Cryptography ([`packages/lease`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease))
- **Checkpoint Envelope Format:**
  ```json
  {
    "v": 1,
    "checkpoint_seq": 1042,
    "checkpoint_hash": "a1b2c3d4e5f6...64hex",
    "timestamp": "2026-10-16T22:45:00.000Z",
    "sealed_count": 1042,
    "kid": "audit-signer-2026-01"
  }
  ```
- **Cryptographic Envelope:** Signed with Ed25519 system or operator key.
  - Canonicalize JSON via RFC 8785 (`canonicalizeJson`).
  - Signature in envelope: `{ payload: CheckpointPayload, sig: string }`.
  - Verification: `verifyCheckpointSignature(envelope, publicKey)`.
- **Keyset Integration:** Key must have role `audit_signer` or `checkpoint_signer` in `keyset.json`.

#### 2. SRE CLI: `synapse audit verify` ([`packages/cli/src/commands/audit.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/audit.ts))
- **Core Verification Engine:** Independent re-computation of SHA-256 hash chain from genesis (`GENESIS_PREV_HASH = "0".repeat(64)`):
  - Fetches ordered sequence of sealed audit events.
  - For each event $n$:
    - Asserts sequence continuity ($seq_n = seq_{n-1} + 1$).
    - Asserts link continuity ($prev\_hash_n = hash_{n-1}$).
    - Canonicalizes event data via RFC 8785.
    - Re-computes expected hash: $H_n = \text{SHA-256}(prev\_hash_n \parallel \text{RFC8785Canonical}(event_n))$.
    - Compares computed $H_n$ against recorded $hash_n$.
  - **Zero Trust in Stored Hashes (Invariant 7):** Must never simply compare `prev_hash` to `hash` in SQL without recomputing SHA-256 hashes from raw event fields.
- **External Checkpoint Cross-Verification:**
  - Accepts `--checkpoint <path-or-url>` (or checks latest checkpoint).
  - Verifies Ed25519 signature on checkpoint against local trusted keyset.
  - Asserts that the verified event at `checkpoint_seq` has hash matching `checkpoint_hash`.
- **Data Source Options:**
  - `--db <connection_string>` or `DATABASE_URL`: Direct PostgreSQL query `SELECT * FROM audit_events ORDER BY seq ASC`.
  - `--api-url <url>` or `SYNAPSE_API_URL`: Fetches from Control API `GET /v1/audit/events`.
  - `--file <path>`: Verifies an exported JSON/JSONL audit log offline.
- **Reporting & Exit Codes:**
  - **Terminal Output:** Styled status box displaying total verified events, sequence span (`seq 1 → 1042`), genesis prev_hash, latest sealed hash, checkpoint anchor status (`VALIDATED` / `NO_CHECKPOINT`), and elapsed verification time.
  - `--json`: Emits structured verification report.
  - **Tampering Detection:** If any row is mutated, deleted, or reordered:
    - Prints exact sequence number of failure (`failedSeq`).
    - Reports whether error was broken link (`prev_hash mismatch`), hash corruption (`SHA-256 mismatch`), or sequence gap.
    - Exits with non-zero exit code (`1`).

#### 3. SRE CLI: `synapse audit checkpoint` ([`packages/cli/src/commands/audit.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/audit.ts))
- **Checkpoint Creator for Scheduled CronJob:**
  - Connects to database or Control API, queries latest sealed event (`SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1`).
  - Constructs canonical checkpoint payload.
  - Signs payload using `CHECKPOINT_SIGNING_KEY` / `EncryptedKeyfileSigner`.
  - Uploads / anchors to write-once storage:
    - S3 upload: `--s3-bucket`, `--s3-region`, `--s3-prefix` (writes `checkpoints/<seq>.json` and `checkpoint-latest.json`).
    - Local file fallback: `--out <path>`.

#### 4. Control API Audit Export Routes ([`apps/control-api/src/routes/audit.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/routes/audit.ts))
- **Endpoints:**
  - `GET /v1/audit/events`: Paginated query of `audit_events` (`from_seq`, `to_seq`, `limit`), streaming sealed records for remote verification.
  - `GET /v1/audit/checkpoint/latest`: Returns latest sealed sequence and hash.
- **Authentication:** Bearer token check requiring `operator`, `admin`, or `audit_reader` role.

#### 5. Kubernetes CronJob Verification ([`deploy/helm/control-api/templates/cronjob-checkpoint-signer.yaml`](file:///c:/Users/adity/Desktop/Projects/SynapseState/deploy/helm/control-api/templates/cronjob-checkpoint-signer.yaml))
- Validated via Helm template tests in `packages/conformance/src/observability.test.ts` (or dedicated Helm test suite):
  - Renders `CronJob` with command `synapse audit checkpoint --s3-bucket $(S3_BUCKET) ...`.
  - Enforces container security contexts: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `seccompProfile: { type: RuntimeDefault }`.
  - Injects `tmp` volume (`emptyDir`) for ephemeral working directory.

---

## 3. Architectural Invariants to Uphold in PR 19

1. **Tamper-Evident Audit Ledger (Invariant 7):**
   - Independent verification must re-compute SHA-256 hashes from genesis without trusting database-computed hashes.
   - Any modification to `ts`, `actor`, `event_type`, or `payload` must invalidate the entire downstream chain.
2. **Pinned Keyset Trust Root (Invariant 2):**
   - External checkpoint signatures must verify against locally pinned Ed25519 keys in Git (`keyset.json`), never against Control API or remote servers.
3. **Fail-Safe Hot Path Delegation (Invariant 1):**
   - Audit verification and checkpointing occur out-of-band. Even if checkpoint storage is unavailable, flag evaluation and lease lifecycle proceed uninterrupted.
4. **Zero-Context Telemetry & Data Privacy (Invariant 5):**
   - Audit records store operational governance actions (`LEASE_CREATED`, `LEASE_REVOKED`, `LEASE_PROMOTED`, `GIT_MERGE`, `KEY_REVOKED`). Never record end-user identifiers or targeting attributes.

---

## 4. Suggested Skills for Next Agent

The next agent should invoke the following skills:
- `test-driven-development`: Write failing tests in `packages/cli/src/commands/audit.test.ts` for clean verification, sequence gap detection, hash corruption detection, and checkpoint validation before writing implementation code.
- `verification-before-completion`: Execute `pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, and full monorepo `pnpm test` before asserting readiness.
- `codebase-design`: Reuse existing `verifyAuditChain` and `computeEventHash` from [`apps/control-api/src/sealer/chain.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/sealer/chain.ts) or extract into `@synapsestate/lease` to avoid code duplication across `apps/control-api` and `packages/cli`.
- `systematic-debugging`: In case of SHA-256 hash discrepancies, inspect RFC 8785 canonicalization format, Date ISO strings, and integer sequence types.

---

## 5. Verification Commands for Monorepo Gates

```bash
# 1. Monorepo Quality Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck

# 2. Package Unit & Integration Tests
pnpm --filter @synapsestate/lease run test
pnpm --filter @synapsestate/cli run test
pnpm --filter @synapsestate/control-api run test
pnpm --filter @synapsestate/conformance run test

# 3. Full Monorepo Test Run
pnpm test

# 4. Clean Tree Check
git status
```
