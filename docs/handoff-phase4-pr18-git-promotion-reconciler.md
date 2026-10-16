# SynapseState Handoff: Phase 4 PR 18 Onboarding (Git Promotion & Merge Reconciliation)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 4 (Weeks 7 – 8: Incident Break-Glass Loop & Git Reconciliation)  
> **Current Target:** PR 18 (`feat/git-promotion-reconciliation` / `feat/control-api-github-reconciler`)  
> **Repository:** `synapsestate/synapsestate`  
> **Current Branch:** `feat/cli-incident-log-ranker` (PR 17 complete, reviewed, all feedback addressed, ready to merge into `main` before branching PR 18)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–7, §5 SLOs, §6 Verification Guidelines)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§4.3 Git Reconciliation & Promotion Flow, §5 State Machine & Lifecycle, §6 Database Schema)  
> - Per-Flag Storage Decision: [docs/adr/0007-per-flag-storage-and-pull-based-attribution.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0007-per-flag-storage-and-pull-based-attribution.md)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 4, PR 17 & PR 18)  
> - Technical Specification: [docs/SpecDoc.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/SpecDoc.md) (§4.1 Control API Routes, `POST /v1/leases/:id/promote`)  
> - PR 17 Implementation: [GitHub PR #17](https://github.com/adityapawar112/SynapseState/pull/17) (Commits `31b4e52` → `d5fea24`)

---

## 1. Executive Summary & Monorepo State (PR 17 Completion)

**PR 17 (`feat/cli-incident-log-ranker`)** is **100% complete, reviewed, verified, and submitted**:
- **Pull-Based Incident Log Command:** Implemented `synapse log` in [`packages/cli/src/commands/log.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/log.ts) with online Control API query (`GET /v1/changes`) and air-gapped `--offline` fallback inspecting local Git history (`flags/<env>/<flag_key>.yaml`) and local emergency lease files (`/etc/synapse/emergency-leases/*.json`).
- **Pure Attribution Ranker Engine:** Implemented deterministic, zero-side-effect `rankSuspects` in [`packages/cli/src/ranker.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/ranker.ts):
  - Recency exponential decay ($\tau = 15\text{ min}$, $t_{1/2} \approx 10.4\text{ min}$).
  - Evaluation volume weighting correlating affected service throughput from `flag_usage_daily`.
  - Severity event weighting (`LEASE_CREATED` > `GIT_MERGE` > `LEASE_SUPERSEDED` > `LEASE_EXPIRED`).
  - Strict determinism with codepoint tie-breaking on `flag_key`.
- **Review Feedback Hardened (Commit `d5fea24`):**
  - **B1 (Invalid Date NaN Poisoning):** Guarded `Number.isFinite(occurredAtMs)`; clamps unparseable timestamps to `deltaMs = Infinity`, `decay = 0`, `recency_score = 0`.
  - **B2 (Unknown Flag Type in Git Suspects):** Never fabricates naive boolean `false` for non-boolean flags. Inspects local YAML `defaultVariant` or emits `<TYPE>` placeholder with schema inspection instructions.
  - **B3 (Shell Quoting / Injection):** Enforces `FLAG_KEY_REGEX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/` on incoming keys; escapes shell command parameters via `quoteShellArg`.
  - **Polish Items:** Scoped `maxVolume` to candidate suspects; case-insensitive boolean string parsing; 5xx offline hints; negative synthetic IDs (`-1000`, `-5000`); bounded `--since` input.
- **Verification Evidence:**
  - Monorepo build and typecheck: 0 errors across all 7 packages.
  - Linter: 0 errors, 0 warnings.
  - 31 unit tests passing across `ranker.test.ts` (19) and `log.test.ts` (12); 91 tests passing in `@synapsestate/cli`; 299 tests passing monorepo-wide.

---

## 2. PR 18 Scope & Deliverables (`feat/git-promotion-reconciliation`)

The target milestone for the upcoming session is **PR 18 (`feat/git-promotion-reconciliation`)**, completing the emergency override lifecycle loop through automated GitHub App Pull Request creation, dual-control human peer review, and webhook merge reconciliation:

```
apps/control-api/src/
├── github/
│   ├── types.ts            # GitHubClient interface, PR & webhook types
│   ├── client.ts           # Octokit / GitHub App authenticated client with injectable factory
│   ├── reconciler.ts       # Flag YAML modifier, branch creation, stale PR conflict detection
│   └── reconciler.test.ts  # Unit tests with mock GitHub client
├── routes/
│   ├── leases.ts           # Wire POST /v1/leases/:id/promote
│   ├── webhooks.ts         # POST /v1/webhooks/github (HMAC SHA-256 verification, merge sync)
│   └── webhooks.test.ts    # Tests for webhook signatures, PR merge transitions, audit staging
packages/cli/src/
├── index.ts                # Register `synapse promote` command
└── commands/
    ├── promote.ts          # synapse promote <lease_id> implementation
    └── promote.test.ts     # CLI tests for promotion invocation, conflict handling, and output
```

### Deliverable Breakdown:

#### 1. Dual-Control Git Promotion Workflow (ARCHITECTURE §4.3)
```
Operator runs: synapse promote <lease_id>
             │
             ▼
Control API: POST /v1/leases/:id/promote
             │
             ▼
GitHub App Reconciler (apps/control-api/src/github/):
  - Checks for existing open PRs on flags/<env>/<flag_key>.yaml
  - If open PR exists with divergent baseline: rejects with STALE_PR_CONFLICT
  - Creates branch: synapse/promote-lease-<lease_id>
  - Updates flags/<env>/<flag_key>.yaml (sets defaultVariant to override value)
  - Opens GitHub Pull Request with lease ID, operator kid, incident reason
  - Records promote_pr_url on leases table
             │
             ▼
GitHub CODEOWNERS & Branch Protection:
  - Requires independent peer review and approval
  - Human review acts as the formal second approval (Dual-Control Invariant 4)
             │
             ▼
PR Merged into default branch
             │
             ▼
GitHub Webhook: POST /v1/webhooks/github
  - Validates x-hub-signature-256 HMAC SHA-256
  - Detects pull_request.closed with merged == true
  - Transitions lease state to PROMOTED
  - Emits signed lease revocation (or reconciles temporary override)
  - Inserts GIT_MERGE and LEASE_PROMOTED into change_events and audit_pending
  - Wakes active long-polling SDKs via stateManager.notifyChange(env) (<100ms)
```

#### 2. GitHub App Reconciler ([`apps/control-api/src/github/`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/github))
- **Decoupled Architecture:** Define a clean `GitHubClient` interface in `types.ts` so all GitHub interactions (branch creation, file commit, pull request creation, open PR search) can be mocked cleanly in tests without live network calls.
- **Per-Flag Storage Standard (ADR 0007):** Target file is strictly `flags/<env>/<flag_key>.yaml`.
  - Validate flag key matches `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`.
  - Parse existing YAML preserving registry metadata (`class`, `owner`, `description`, `variants`).
  - Update `defaultVariant` to match the override variant from the lease payload.
- **Stale PR & Conflict Detection:**
  - Query GitHub for existing open PRs targeting `flags/<env>/<flag_key>.yaml`.
  - If an open PR already exists for the flag, return HTTP 409 with error code `STALE_PR_CONFLICT` and URL of existing PR.
- **PR Metadata & Dual-Control Auditability:**
  - Branch name: `synapse/promote-lease-<lease_id>`.
  - PR Title: `feat(flags): promote override for <flag_key> in <env> (lease <lease_id>)`.
  - PR Body: Comprehensive markdown detailing:
    - Target flag: `<flag_key>` in `<env>`
    - Original emergency lease: `<lease_id>`
    - Authorized operator: `<kid>`
    - Incident reason: `<reason>`
    - Issued timestamp and duration
    - Explicit note: *"Merging this PR will reconcile the Git baseline and transition emergency lease <lease_id> to PROMOTED via webhook."*

#### 3. Control API Promotion Route ([`apps/control-api/src/routes/leases.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/routes/leases.ts))
- **Endpoint:** `POST /v1/leases/:id/promote` (SpecDoc §4.1).
- **Authentication:** Bearer token check (`req.headers.authorization`).
- **State Validation:**
  - Fetches lease from database.
  - Lease must exist (404 Not Found).
  - Lease must be `ACTIVE` or `EXPIRED` (409 Conflict if already `PROMOTED` or `REVOKED` or `SUPERSEDED`).
- **Execution:**
  - Calls `githubReconciler.promoteLease(lease)`.
  - Updates `leases.promote_pr_url = prUrl` in database.
  - Returns `202 Accepted` with `{ lease_id: lease.lease_id, pr_url: prUrl, branch: branchName }`.

#### 4. GitHub Webhook Handler ([`apps/control-api/src/routes/webhooks.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/routes/webhooks.ts))
- **Endpoint:** `POST /v1/webhooks/github`.
- **HMAC Verification:** Validate `x-hub-signature-256` header against `GITHUB_WEBHOOK_SECRET` using `crypto.createHmac("sha256", secret)`. Reject with 401 if missing or invalid.
- **Event Filter:** Process `pull_request` event when `action === "closed"` and `merged === true`.
- **Lease Reconciliation Transaction:**
  - Match branch name `synapse/promote-lease-(?<lease_id>[0-9A-HJKMNP-TV-Z]{26})` or search `leases.promote_pr_url`.
  - If matched:
    - Atomically transition lease `state` to `PROMOTED` in PostgreSQL.
    - If lease was already `EXPIRED`, record `after_expiry = true` in payload (ARCH §5 Table).
    - Insert `GIT_MERGE` and `LEASE_PROMOTED` into `change_events` table (Invariant 7).
    - Stage `LEASE_PROMOTED` into `audit_pending` table for asynchronous hash chaining.
    - If lease was still `ACTIVE`, issue signed revocation or record revocation transition so workloads release override.
    - Increment Prometheus metrics (`leaseTransitionsTotal.inc({ from: "ACTIVE", to: "PROMOTED" })`).
    - Wake long-polling connections via `stateManager.notifyChange(env)` (<100ms lag).
  - Return `200 OK` with `{ status: "reconciled", lease_id }`.

#### 5. CLI Command `synapse promote` ([`packages/cli/src/commands/promote.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/promote.ts))
- **Command Syntax:** `synapse promote <lease_id> [options]`.
- **Options:**
  - `--env <env>`: Target environment (`production` by default or `SYNAPSE_ENV`).
  - `--api-url <url>`: Control API URL (defaults to `SYNAPSE_API_URL` or `http://localhost:3000`).
  - `--token <token>`: Operator API token (defaults to `SYNAPSE_API_TOKEN`).
  - `--json`: Output machine-readable JSON (`{ lease_id, pr_url, branch }`).
- **Output:** Styled terminal box displaying:
  - Success banner with PR link
  - Branch name created
  - Next step instructions reminding operator that peer review and merge serves as secondary approval.

---

## 3. Architectural Invariants to Uphold in PR 18

1. **Fail-Safe Hot Path Delegation (Invariant 1):**
   - GitHub API outages or webhook delays must never disrupt application flag evaluation. Evaluation continues using active leases or falls back to delegate providers.
2. **Git Reconciliation as Dual Control (Invariant 4):**
   - **Zero Autonomous Direct-to-Main Merges:** The Control API opens Pull Requests only. It **must never** push directly to `main` or auto-merge PRs. Human peer review and merge of that PR is the non-negotiable secondary approval.
3. **Zero-Context Telemetry & Audit Integrity (Invariants 5 & 7):**
   - Promotion and webhook events in `change_events` and `audit_pending` must contain strictly `(flag_key, env, actor, occurred_at, payload)` with metadata (PR URL, merge commit SHA, lease ID). Zero user targeting context.
4. **Per-Flag Storage & Charset Invariant (ADR 0007):**
   - Target path must strictly follow `flags/<env>/<flag_key>.yaml`. Flag keys must validate against `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`.

---

## 4. Suggested Skills for Next Agent

The next agent should invoke the following skills:
- `test-driven-development`: Write tests in `reconciler.test.ts` and `webhooks.test.ts` before writing implementation code. Mock GitHub API client responses and verify signature validation edge cases (missing signature, bad secret, malformed payload).
- `verification-before-completion`: Run `pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, and test suites before making completion claims.
- `codebase-design`: Decouple Octokit/GitHub API interactions behind a testable `GitHubClient` interface so business logic is unit-testable without external network dependencies.
- `domain-modeling`: Align terminology with `LEASE_PROMOTED`, `GIT_MERGE`, `STALE_PR_CONFLICT`, and `PROMOTED` state transitions in [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md).

---

## 5. Verification Commands for Monorepo Gates

```bash
# 1. Monorepo Quality Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck

# 2. Package Unit Tests
pnpm --filter @synapsestate/control-api run test
pnpm --filter @synapsestate/cli run test
pnpm --filter @synapsestate/lease run test
pnpm --filter @synapsestate/sdk run test

# 3. Clean Tree Check
git status
```
