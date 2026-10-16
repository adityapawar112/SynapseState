# SynapseState Handoff: Phase 4 PR 20 Onboarding (Chaos Drills & Failure Postmortem)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 4 (Weeks 7 – 8: Incident Break-Glass Loop & Git Reconciliation)  
> **Current Target:** PR 20 (`test/chaos-drills-and-postmortem`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Branch:** `feat/audit-checkpoint-verifier` (PR 19 complete, tested, verified monorepo-wide, ready to merge into `main` before branching PR 20)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–7, §5 SLOs, §6 Verification Guidelines)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§4.4 Audit Ledger, §5 State Machine & Lifecycle, §10 Disaster Recovery & Air-Gap)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 4, PR 19 & PR 20)  
> - Technical Specification: [docs/SpecDoc.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/SpecDoc.md) (§4 System Architecture, §6 Verification & Testing)

---

## 1. Executive Summary & Monorepo State (PR 19 Completion)

**PR 19 (`feat/audit-checkpoint-verifier`)** is **100% complete, tested, and verified monorepo-wide**:
- **Tamper-Evident Checkpoint Cryptography (`packages/lease`):**
  - Canonical checkpoint schema (`CheckpointPayloadSchema`, `CheckpointEnvelopeSchema`) enforcing `v: 1`, `checkpoint_seq`, 64-char hex `checkpoint_hash`, ISO 8601 UTC timestamp, and `kid`.
  - Cryptographic domain separation prefix `synapsestate/checkpoint/v1\n`.
  - Ed25519 signing and verification (`signCheckpoint`, `verifyCheckpoint`, `signCheckpointWithSigner`, `verifyCheckpointWithKeyset`).
  - Keyset integration with `canSignCheckpoint` enforcing active status and roles (`checkpoint_signer`, `audit_signer`, or `admin`).
  - Extracted shared audit ledger chain math (`GENESIS_PREV_HASH`, `canonicalizeAuditEvent`, `computeEventHash`, `verifySingleEvent`, `verifyAuditChain`) into `@synapsestate/lease/src/chain.ts` with backwards-compatible re-exports in `control-api`.
  - Robust `resolvePrivateKey` supporting 32-byte raw hex, 32-byte base64url, 32-byte buffer, 48-byte PKCS#8 DER, and PEM strings.
- **Control API Audit Export Routes (`apps/control-api/src/routes/audit.ts`):**
  - `GET /v1/audit/events`: Paginated query of `audit_events` with strict sequence ordering, `from_seq`, `to_seq`, and `limit` guards.
  - `GET /v1/audit/checkpoint/latest`: Returns latest sealed sequence, hash, count, and timestamp (or genesis anchor if empty).
  - RBAC: Authenticated via Bearer token with `operator`, `admin`, or `audit_reader` roles.
- **SRE CLI `synapse audit verify` & `synapse audit checkpoint` (`packages/cli/src/commands/audit.ts`):**
  - `synapse audit verify`: Full independent SHA-256 chain recomputation from genesis against files (JSON/JSONL), Control API (`/v1/audit/events`), or PostgreSQL (`audit_events`). Cross-verifies signed checkpoints against trusted keyset (`keyset.json`), detecting sequence gaps, hash corruption, broken links, and checkpoint discrepancies with colored terminal boxes and `--json` support.
  - `synapse audit checkpoint`: Fetches latest sealed sequence, generates canonical payload, signs via `CHECKPOINT_SIGNING_KEY` or `EncryptedKeyfileSigner`, and anchors to local files (`--out`) or write-once S3 (`--s3-bucket`, `--s3-region`, `--s3-prefix`).
- **Kubernetes CronJob Validation (`packages/conformance`):**
  - Helm template conformance tests verifying `deploy/helm/control-api/templates/cronjob-checkpoint-signer.yaml` renders `CronJob` and non-automounting `ServiceAccount` with `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, and `RuntimeDefault` seccomp profile when `cronjob.enabled=true`.
- **Verification Evidence:**
  - Monorepo build (`pnpm -r run build`): 0 errors across all 7 workspace packages.
  - Monorepo typecheck (`pnpm -r run typecheck`): 0 errors.
  - Monorepo linter (`pnpm run lint`): 0 errors, 0 warnings.
  - Monorepo tests (`pnpm test`): **380+ tests passed** across 37 test files monorepo-wide.

---

## 2. PR 20 Scope & Deliverables (`test/chaos-drills-and-postmortem`)

The target milestone for the upcoming session is **PR 20 (`test/chaos-drills-and-postmortem`)**, completing **Phase 4 Deliverable 4.4 (Failure Drills & Disaster Recovery Postmortem)** and closing out Phase 4:

```
test/
└── drills/
    ├── drill1-airgap-override.test.ts    # Kill API -> apply override via air-gapped emergency leases -> verify enforcement
    ├── drill2-clock-skew.test.ts         # Clock skew injection -> verify monotonic expiry enforcement per process
    ├── drill3-revocation-partition.test.ts # Network partition during revocation -> verify bounded exposure to expires_at
    └── run-drills.sh                     # Automated runner for failure drills
docs/
└── postmortems/
    └── 2026-10-drill-postmortem.md       # Formal postmortem report with root cause analysis & action items
```

### Detailed Deliverable Breakdown:

#### 1. Drill 1: Air-Gapped Emergency Lease Application
- **Scenario:** Control API is completely down (crash / network outage / 503).
- **Execution:** SRE uses `synapse lease emergency-apply` to write signed lease directly to air-gapped emergency directory/ConfigMap (`/etc/synapse/emergency-leases/`).
- **Verification:** SDK in demo application detects emergency lease file, verifies Ed25519 signature against locally pinned `keyset.json`, applies override in-process without Control API, and falls back cleanly when TTL expires.

#### 2. Drill 2: Clock-Skew Injection & Dual-Clock Expiry (Invariant 3)
- **Scenario:** System wall-clock jumps into the past or future (NTP sync failure, hypervisor freeze, deliberate tamper).
- **Execution:** Test harness injects artificial wall-clock skews ($\pm 300\text{ s}$, $\pm 86400\text{ s}$).
- **Verification:** Assert that `evaluateLeaseExpiry` / SDK enforces monotonic process deadline (`first_seen_mono + ttl_seconds`). No lease survives past $\min(\text{wall\_expiry}, \text{mono\_expiry})$.

#### 3. Drill 3: Network Partition During Lease Revocation
- **Scenario:** Control API receives and seals emergency revocation, but network partition isolates client SDK from long-polling state sync.
- **Execution:** Simulate disconnected `StateClient`.
- **Verification:** SDK continues serving override safely in-memory strictly bounded by `ttl_seconds`, and automatically expires as soon as monotonic/wall clock passes expiration deadline. Once partition heals, revocation immediately drops the override.

#### 4. Drill 4: Production-Grade Postmortem Report
- Format conforming to SRE incident response standards:
  - Incident Summary & Timeline
  - Impact & Root Cause Analysis
  - Invariant Verification Results (Fail-Safe Delegation, Pinned Keyset, Dual-Clock Expiry, Zero-Context Telemetry)
  - Action Items & Hardening Measures

---

## 3. Verification Commands for Monorepo Gates

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
