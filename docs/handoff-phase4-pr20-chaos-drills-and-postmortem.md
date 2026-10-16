# SynapseState Handoff: Phase 4 PR 20 Onboarding (Chaos Drills & Failure Postmortem)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 4 (Weeks 7 – 8: Incident Break-Glass Loop & Git Reconciliation)  
> **Current Target:** PR 20 (`test/chaos-drills-and-postmortem`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Branch:** `feat/audit-checkpoint-verifier` (PR 19 complete, peer-reviewed, approved, and verified monorepo-wide; ready to merge into `main` before branching `test/chaos-drills-and-postmortem`)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§4.4 Audit Ledger, §5 State Machine & Lifecycle, §10 Disaster Recovery & Air-Gap)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 4, PR 19 & PR 20)  
> - Technical Specification: [docs/SpecDoc.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/SpecDoc.md) (§4 System Architecture, §6 Verification & Testing)

---

## 1. Suggested Skills

The next agent picking up this task should call the following skills:
- `test-driven-development`: Write failure drill scenarios first, observe expected red state, then implement simulation harnesses and assertions.
- `verification-before-completion`: Run all quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm test`) with fresh terminal evidence before making any completion claim.
- `systematic-debugging`: For investigating failure modes or clock skew edge cases in test isolation.

---

## 2. Executive Summary & Monorepo State (PR 19 Completion)

**PR 19 (`feat/audit-checkpoint-verifier`)** is complete, peer-reviewed with an unconditional **`APPROVE`** verdict, and pushed to `origin/feat/audit-checkpoint-verifier`:
- **Cryptographic Checkpoint Primitives (`packages/lease`):**
  - Canonical checkpoint schema (`CheckpointPayloadSchema`, `CheckpointEnvelopeSchema`) enforcing `v: 1`, `checkpoint_seq`, 64-char hex `checkpoint_hash`, ISO 8601 UTC timestamp, and `kid`.
  - Cryptographic domain separation prefix `CHECKPOINT_DOMAIN_PREFIX = "synapsestate/checkpoint/v1\n"`.
  - Ed25519 checkpoint signing and keyset verification (`signCheckpoint`, `verifyCheckpoint`, `verifyCheckpointWithKeyset`).
  - Strict keyset role authorization via `canSignCheckpoint` (`checkpoint_signer`, `audit_signer`, or `admin`).
  - Extracted shared audit ledger chain math (`GENESIS_PREV_HASH`, `canonicalizeAuditEvent`, `computeEventHash`, `verifyAuditChain`) into `@synapsestate/lease/src/chain.ts` with backwards-compatible re-exports.
  - Genesis start enforcement (`seq=1`) when verifying from genesis (C1) and reporting missing sequence numbers on gap (I7).
- **Control API Audit Export Routes (`apps/control-api/src/routes/audit.ts`):**
  - `GET /v1/audit/events`: Paginated query with strict integer validation (`parseStrictPositiveInt` rejecting floats, non-digits, exponentials) and sequence ordering.
  - `GET /v1/audit/checkpoint/latest`: Returns latest sealed sequence, hash, count, and timestamp (or genesis anchor if empty).
  - Constant-time Bearer token comparison (`crypto.timingSafeEqual`) against `SYNAPSE_API_TOKEN`.
  - Safe ISO timestamp formatting (`safeIsoString`) guarding against database corruption crashes.
- **SRE CLI `synapse audit verify` & `synapse audit checkpoint` (`packages/cli/src/commands/audit.ts`):**
  - `synapse audit verify`: Full independent SHA-256 chain recomputation from genesis against files, API, or PostgreSQL with external signed checkpoint cross-verification.
  - `synapse audit checkpoint`: Fetches latest sealed sequence, validates schema, derives public key fingerprint, enforces keyset binding with normalization across hex/base64url/PEM, signs envelope, and dual-anchors to local files and S3 with `ChecksumSHA256` and optional `ObjectLockMode: "COMPLIANCE"`. Refuses to checkpoint empty ledgers.
- **Verification Evidence:**
  - Monorepo build (`pnpm -r run build`): 0 errors across all 7 workspace packages.
  - Monorepo typecheck (`pnpm -r run typecheck`): 0 errors.
  - Monorepo linter (`pnpm run lint`): 0 errors, 0 warnings.
  - Monorepo tests (`pnpm test`): **442 tests passed** (0 failed) across all workspace test files.
- **Recent Git Commits:**
  - `f1a35d0`: `feat(cli): audit checkpoint signer CronJob and synapse audit verify (PR 19)`
  - `0e6b786`: `fix(audit): enforce genesis start, strict validation, and checkpoint key binding`
  - `160cc90`: `refactor(cli): normalize keyset public key format and polish S3 prefix handling`

---

## 3. PR 20 Scope & Deliverables (`test/chaos-drills-and-postmortem`)

The objective for Phase 4 PR 20 is to complete **Deliverable 4.4 (Failure Drills & Disaster Recovery Postmortem)** and close out Phase 4 according to [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md#L200-L206):

```
test/
└── drills/
    ├── drill1-airgap-override.test.ts      # Kill API -> apply override via air-gapped emergency leases -> verify enforcement
    ├── drill2-clock-skew.test.ts           # Clock skew injection -> verify monotonic expiry enforcement per process
    ├── drill3-revocation-partition.test.ts # Network partition during revocation -> verify bounded exposure to expires_at
    └── run-drills.sh                       # Automated runner for failure drills
docs/
└── postmortems/
    └── 2026-10-drill-postmortem.md         # Formal postmortem report with root cause analysis & action items
```

### Detailed Deliverable Breakdown:

#### 1. Drill 1: Air-Gapped Emergency Lease Application
- **Scenario:** Control API is completely offline (crashed, partitioned, or 503).
- **Execution:** Operator applies a pre-signed emergency lease directly via local air-gapped directory/ConfigMap (`/etc/synapse/emergency-leases/` or test temp dir).
- **Verification:** SDK in application detects lease file, verifies Ed25519 signature against locally pinned `keyset.json`, evaluates override in-process without Control API, and falls back cleanly to the delegate provider when TTL expires.

#### 2. Drill 2: Clock-Skew Injection & Dual-Clock Expiry (Invariant 3)
- **Scenario:** System wall-clock jumps backwards or forwards (NTP failure, VM live-migration freeze, operator tamper).
- **Execution:** Test harness injects artificial wall-clock skews ($\pm 300\text{ s}$, $\pm 86400\text{ s}$).
- **Verification:** Assert that `evaluateLeaseExpiry` / SDK enforces monotonic process deadline (`first_seen_mono + ttl_seconds`). No lease survives past $\min(\text{wall\_expiry}, \text{mono\_expiry})$.

#### 3. Drill 3: Network Partition During Lease Revocation
- **Scenario:** Control API receives and seals emergency revocation, but network partition isolates client SDK from long-polling state sync.
- **Execution:** Simulate severed long-polling connection during revocation.
- **Verification:** SDK continues serving override safely in-memory strictly bounded by `ttl_seconds`, and automatically expires as soon as monotonic/wall clock passes expiration deadline. Once partition heals, revocation immediately drops the override.

#### 4. Drill 4: Production-Grade Postmortem Report
- Document located at `docs/postmortems/2026-10-drill-postmortem.md` conforming to SRE incident response standards:
  - Incident Summary & Timeline (90-second scenario)
  - Impact & Root Cause Analysis
  - Invariant Verification Results (Invariants 1–8)
  - Concrete Action Items & Hardening Measures

---

## 4. Immediate Next Steps for Next Session

1. **Merge PR 19 into `main`:**
   ```bash
   git checkout main
   git merge feat/audit-checkpoint-verifier
   git push origin main
   ```
2. **Branch PR 20:**
   ```bash
   git checkout -b test/chaos-drills-and-postmortem
   ```
3. **Implement Drills in `test/drills/` using TDD:**
   - Create `test/drills/drill1-airgap-override.test.ts`
   - Create `test/drills/drill2-clock-skew.test.ts`
   - Create `test/drills/drill3-revocation-partition.test.ts`
   - Create `test/drills/run-drills.sh` (or npm script `pnpm run test:drills`)
4. **Draft Postmortem:**
   - Create `docs/postmortems/2026-10-drill-postmortem.md`
5. **Verify Monorepo Gates:**
   - Run `pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm test`.
