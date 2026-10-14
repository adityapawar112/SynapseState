# SynapseState Handoff: Phase 4 PR 17 Onboarding (Incident Log & Attribution Ranker)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 4 (Weeks 7 – 8: Incident Break-Glass Loop & Git Reconciliation)  
> **Current Target:** PR 17 (`feat/cli-incident-log-ranker`)  
> **Repository:** `synapsestate/synapsestate`  
> **Current Branch:** `feat/cli-lease-lifecycle` (PR 16 approved & merged / ready for PR 17 branch `feat/cli-incident-log-ranker`)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–7, §5 SLOs, §6 Verification Guidelines)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§11.4 Incident Attribution Engine)  
> - Incident Attribution Decision: [docs/adr/0007-per-flag-storage-and-pull-based-attribution.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/adr/0007-per-flag-storage-and-pull-based-attribution.md)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 4, PR 16 & PR 17)  
> - PR 16 Implementation: [GitHub PR #16](https://github.com/adityapawar112/SynapseState/pull/16) (Commits `d184e0b` → `d40e487` → `b413156`)

---

## 1. Executive Summary & Monorepo State (PR 16 Completion)

**PR 16 (`feat/cli-lease-lifecycle`)** is **100% complete, reviewed, approved, and verified**:
- **Signed Lease Lifecycle:** Implemented `synapse lease create`, `synapse lease list`, `synapse lease revoke`, and `synapse lease emergency-apply` in [`packages/cli/src/commands/lease.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/lease.ts).
- **Hardened Cryptographic Delegations:**
  - Standardized all CLI signing onto shared `@synapsestate/lease` helpers: [`signLeaseWithSigner`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease/src/crypto.ts) and [`signRevocationWithSigner`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease/src/crypto.ts).
  - RFC 8785 canonical JSON formatting with domain separation prefix (`synapsestate/lease/v1\n` and `synapsestate/revocation/v1\n`).
- **Deterministic Dual-Clock Expiry (Invariant 3 Upheld):**
  - Clock synchronization measures RTT ($t_1 - t_0$), compensates by $\lfloor\text{rtt}/2\rfloor$, enforces 5s RTT budget, and hard-aborts if clock skew exceeds 30s (`--allow-skew`).
  - Table-based `lease list` displays authoritative status using `evaluateLeaseExpiry` with monotonic bounds and 30s skew tolerance.
  - Air-gapped `emergency-apply` emits explicit operational warning that workstation clock drift $>30\text{ s}$ causes workloads to reject leases as `FUTURE_DATED`.
- **Crockford Base32 Monotonic ULID:**
  - Implemented 80-bit big-endian counter increment on same-millisecond collision and backward clock drift clamping in [`packages/lease/src/ulid.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease/src/ulid.ts).
- **Rollout Polling & Safety:**
  - Polling loop detects terminal HTTP states (`400`, `401`, `403`), uses `AbortController` timeouts, and sets `process.exitCode = 2` on rollout confirmation timeout.
- **Verification Evidence:**
  - Monorepo build and typecheck: 0 errors across all 7 packages.
  - Linter: 0 errors, 0 warnings.
  - 158 tests passing across `@synapsestate/lease` (99) and `@synapsestate/cli` (59).
  - Validated Kubernetes ConfigMap client dry-run formatting.

---

## 2. PR 17 Scope & Deliverables (`feat/cli-incident-log-ranker`)

The target milestone for the upcoming session is **PR 17 (`feat/cli-incident-log-ranker`)**, implementing the pull-based incident investigation tool (`synapse log`) and the pure suspect attribution engine (`rankSuspects`):

```
packages/cli/src/
├── index.ts                # Register `synapse log` command
├── ranker.ts               # Pure rankSuspects function & scoring logic
├── ranker.test.ts          # Unit tests for ranking determinism, decay, and suggestion typing
└── commands/
    ├── key.ts              # synapse key generate & export-public (PR 15)
    ├── lease.ts            # synapse lease create, list, revoke, emergency-apply (PR 16)
    ├── log.ts              # synapse log implementation (PR 17)
    └── log.test.ts         # Tests for online API querying, table formatting, and offline fallback
```

### Deliverable Breakdown:

#### 1. Pure Attribution Ranker ([`packages/cli/src/ranker.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/ranker.ts))
Implement the authoritative ranking interface defined in [docs/ARCHITECTURE.md §11.4](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L734):

```typescript
export interface ChangeEvent {
  id: number;
  event_type: "LEASE_CREATED" | "LEASE_REVOKED" | "LEASE_SUPERSEDED" | "LEASE_EXPIRED" | "LEASE_PROMOTED" | "GIT_MERGE" | string;
  env: string;
  flag_key: string | null;
  actor: string;
  occurred_at: string; // ISO-8601
  payload: Record<string, unknown>;
}

export interface FlagEvaluationRecord {
  flag_key: string;
  variant: string;
  eval_count: number;
}

export interface RankedSuspect {
  flag_key: string;
  score: number; // 0 to 100 normalized suspect confidence score
  recency_score: number;
  volume_score: number;
  event_type: string;
  occurred_at: string;
  actor: string;
  eval_count: number;
  current_variant?: string;
  suggested_action: {
    command: string; // ready-to-run: synapse lease create --flag ...
    suggested_value: boolean | number | string;
    reason: string;
  };
}

export function rankSuspects(
  events: ChangeEvent[],
  evaluations: FlagEvaluationRecord[],
  targetService: string,
  nowMs: number = Date.now(),
): RankedSuspect[];
```

#### 2. Pure Scoring Model & Type-Aware Mitigation
- **Recency Decay:** Events closer in time to `nowMs` receive exponentially higher recency weight (e.g. exponential half-life decay over 30 minutes: $\text{decay} = \exp(-\Delta t / \tau)$ where $\tau = 15\text{ min}$).
- **Evaluation Volume Weighting:** Correlate flags evaluated frequently by `targetService` (from `flag_usage_daily` evaluations) vs idle flags. A flag with 50,000 evaluations per minute in the affected service is significantly more suspect than an untouched flag.
- **Event Weighting:** Active modifications (`LEASE_CREATED`, `GIT_MERGE`, `LEASE_SUPERSEDED`) rank higher than background expirations.
- **Type-Aware Suggested Value:**
  - Do NOT hardcode boolean `false`.
  - If previous variant was `"true"` or `true`, suggest `false`.
  - If previous variant was `"on"`, suggest `"off"` (or vice-versa).
  - If numeric (`1`), suggest `0`.
  - If multi-variant string (e.g. `"canary"`, `"v2"`, `"control"`), inspect historical evaluation records in `evaluations` and suggest the baseline/control variant with highest count or the non-canary variant.

#### 3. CLI Command `synapse log` ([`packages/cli/src/commands/log.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/cli/src/commands/log.ts))
- **CLI Options:**
  - `--service <name>`: Target service experiencing degradation (mandatory in table mode, or prompts).
  - `--env <env>`: Target environment (`production` by default or `SYNAPSE_ENV`).
  - `--since <duration>`: Duration window (e.g. `15m`, `30m`, `2h`, `1d`; default: `30m`).
  - `--flag <key>`: Optional filter for a specific feature flag.
  - `--limit <num>`: Max events to retrieve (default: 50, clamped 1..200).
  - `--offline`: Air-gapped fallback mode when Control API is unreachable (see below).
  - `--json`: Emit machine-readable JSON containing raw query, events, evaluations, and ranked suspects.
  - `--api-url <url>`: Control API URL (defaults to `http://localhost:3000` or `SYNAPSE_API_URL`).
- **Online Execution Flow:**
  1. Calls `GET /v1/changes?env=<env>&since=<since>&service=<service>&limit=<limit>`.
  2. Parses JSON response `{ query, events, evaluations }` (already implemented in [`apps/control-api/src/routes/changes.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/control-api/src/routes/changes.ts)).
  3. Passes events and evaluations to `rankSuspects`.
  4. Renders output either as JSON (`--json`) or as a stylized, colored table (`cli-table3` + `picocolors`).
- **Offline Fallback Flow (`--offline`):**
  - Inspects local Git repository commits: executes `git log -n <limit> --since=<since> --pretty=format:... flags/<env>/`.
  - Inspects local emergency lease files: reads `/etc/synapse/emergency-leases/*.json` and `~/.synapse/emergency-leases/*.json`.
  - Constructs synthetic `ChangeEvent[]` from local git commits and lease files, then executes `rankSuspects` with zero evaluations (`evaluations = []`).
  - Outputs warning indicating offline mode is active without telemetry volume weighting.

---

## 3. Architectural Invariants to Uphold in PR 17

1. **Fail-Safe Air-Gapped Fallback (Invariant 1 & ADR 0007):**
   - Incident attribution must never become a single point of failure. If the Control API is down during the incident, `--offline` reads from local Git and emergency lease directories so operators can still investigate "what changed?".
2. **Zero-Context Telemetry (Invariant 5):**
   - Incident log processing operates exclusively on aggregated `(flag_key, variant, eval_count)` and Git/lease change metadata. It must **never** inspect or handle user targeting keys, attributes, or evaluation context.
3. **Pure-Function Separation (ARCH §11.4):**
   - `rankSuspects` MUST be a pure, deterministic function with no direct network, file system, or clock side effects. All timestamps and data must be passed as arguments. This allows headless reuse by Slack bots, Alertmanager webhooks, or dashboard extensions without duplication.
4. **Type-Safe Mitigation Ergonomics:**
   - Mitigations generated by `synapse log` must be directly executable `synapse lease create ...` commands that respect the flag's variant type.

---

## 4. Suggested Skills for Next Agent

The next agent should call the `Skill` tool for:
- `test-driven-development`: Write tests in `ranker.test.ts` verifying recency decay, volume weighting, deterministic tie-breaking, and type-aware suggestion generation before implementing the ranker.
- `verification-before-completion`: Run `pnpm run lint`, `pnpm -r run build`, `pnpm -r run typecheck`, and test suites before claiming task completion.
- `codebase-design`: Keep `ranker.ts` completely decoupled from Commander / CLI I/O so it remains a pure domain utility.
- `domain-modeling`: Align terminology with `ChangeEvent`, `FlagEvaluationRecord`, and `RankedSuspect` from [docs/ARCHITECTURE.md §11.4](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L734).

---

## 5. Verification Commands for Monorepo Gates

```bash
# 1. Monorepo Quality Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck

# 2. Package Unit Tests
pnpm --filter @synapsestate/cli run test
pnpm --filter @synapsestate/lease run test
pnpm --filter @synapsestate/sdk run test
pnpm --filter @synapsestate/conformance run test

# 3. Clean Tree Check
git status
```
