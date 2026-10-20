# Phase 7 Handoff: End-to-End Verification & Mutation Resilience (PRs 27–29)

> **Target Audience:** SREs, QA Engineers, Core Systems Contributors, and AI Coding Agents  
> **Mission:** Multi-layered verification establishing End-to-End browser verification (PR 27 / PR #28), mutation testing for cryptographic and fail-safe invariants (PR 28), and automated chaos/stress testing (PR 29).

---

## 1. Overview & Testing Pyramid

To guarantee incident-safety without compromising application hot paths, SynapseState structures verification into four complementary layers:

```
           / \
          /   \     E2E Testing (Playwright - PR 27 / PR #28) [COMPLETED]
         / E2E \    Browser-level user journeys, RBAC, live countdowns, promotion flow
        /-------\
       /Mutation \  Mutation Testing (Stryker Mutator - PR 28) [NEXT UP]
      /  Testing  \ Core invariant resilience: crypto, dual-clock expiry, fail-safe fallback
     /-------------\
    /  Stress/Chaos \ Automated Chaos Drills & Partition Testing (PR 29) [UPCOMING]
   /   Saturation    \ Bulkhead isolation, NTP clock jumps, revocation packet loss
  /-------------------\
 / Unit & Conformance  \ Conformance Golden Vectors, Vitest Unit Suites, Property Tests
/-----------------------\
```

### Phase 7 Status Dashboard

| Phase / PR | Branch | Focus Area | Status | Quality Gate |
|---|---|---|---|---|
| **PR 27 (PR #28)** | `test/dashboard-playwright-e2e` | Production E2E Browser Testing | **COMPLETED & APPROVED** | 16/16 tests pass, 0 route mocks, live PG + mock dual-mode |
| **PR 28** | `test/mutation-stryker-invariants` | Cryptographic & SDK Mutation Testing | **READY FOR IMPLEMENTATION (NEXT PR)** | Mutation Score Indicator (MSI) $\ge 80\%$ on `@synapsestate/lease` & `@synapsestate/sdk` |
| **PR 29** | `test/chaos-drill-automation` | CI Chaos Drills & Fault Injection | **QUEUED / UPCOMING** | 3/3 chaos drills automated in GitHub Actions |

---

## 2. PR 27: End-to-End Browser Testing (`test/dashboard-playwright-e2e`) — [COMPLETED]

### 2.1 Delivered Architecture
The Playwright E2E suite was established, reviewed, hardened, and approved across commits `c321cec` → `17eecdc`:
- **Production Build Testing:** Zero `page.route()` interception. Tests execute against a genuine production build (`next start -p 3010`) and real Control API (`:3000`) orchestrated via [`apps/dashboard/playwright.config.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/dashboard/playwright.config.ts).
- **Dual-Mode Control API Harness ([start-control-server.ts](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/dashboard/e2e/fixtures/start-control-server.ts)):**
  - **Live Mode:** TCP-probes PostgreSQL on port 5432. When detected, runs migrations, seeds deterministic test fixtures ([seed-data.ts](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/dashboard/e2e/fixtures/seed-data.ts)) with Ed25519 signed leases (`test-keyset.json`), and boots the real `@synapsestate/control-api`.
  - **Mock Mode:** Contract-compliant in-process HTTP fallback ([mock-control-server.ts](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/dashboard/e2e/fixtures/mock-control-server.ts)) with Bearer token authentication, Crockford ULID validation, and real RFC 8785 + SHA-256 hash chaining.
- **Fail-Closed Security Posture:**
  - In production (`NODE_ENV === "production"`), the Dashboard web tier strictly rejects server-side fallback signing with `400 WORKSTATION_SIGNATURE_REQUIRED`. Revocations require an operator workstation envelope (`signRevocation`).
  - Promotion simulation is strictly forbidden in production, regardless of any `SYNAPSE_DEV_AUTH` environment flags.
  - CI environment flags (`SYNAPSE_DEV_AUTH`, `SYNAPSE_MOCK_PROMOTE`) are strictly scoped to the E2E browser test step in [`.github/workflows/ci.yml`](file:///c:/Users/adity/Desktop/Projects/SynapseState/.github/workflows/ci.yml).
- **Cryptographic & Side-Effect Verification:**
  - [`audit-chain.spec.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/dashboard/e2e/tests/audit-chain.spec.ts): Independently recomputes per-event SHA-256 hashes (`computeEventHash`) from API responses, checks sequence continuity, and executes negative tampering tests.
  - [`leases-lifecycle.spec.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/dashboard/e2e/tests/leases-lifecycle.spec.ts): Verifies monotonic countdown decrements (`Xh Ym Zs`), submits signed revocation envelopes, and polls `/v1/leases`, `/v1/sdk/state`, and `/v1/audit/events` for side-effect proof.
  - [`promote-flow.spec.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/dashboard/e2e/tests/promote-flow.spec.ts): Verifies reconciliation diff preview, submits Draft PR, and validates duplicate promotion conflict (`409 STALE_PR_CONFLICT`).
  - [`auth-rbac.spec.ts`](file:///c:/Users/adity/Desktop/Projects/SynapseState/apps/dashboard/e2e/tests/auth-rbac.spec.ts): Tests unauthenticated redirects, viewer read-only protection, operator modal authorization, CSRF double-submit protection, and tampered session rejection (`401`).

### 2.2 Execution Command
```bash
pnpm --filter @synapsestate/dashboard test:e2e
# Output: 16 passed (all 5 specs green)
```

---

## 3. PR 28: Mutation Testing with Stryker Mutator — [NEXT UP: READY FOR IMPLEMENTATION]

> **Branch:** `test/mutation-stryker-invariants`  
> **Base Branch:** `main` (after merging PR #28)  
> **Objective:** Prove the fault-tolerance and resilience of security-critical and hot-path evaluation code against synthetic mutant injections.

### 3.1 Targeted Packages & Invariant Boundary

Mutation testing must be strictly confined to core evaluation and cryptographic packages. Do **not** run Stryker on `apps/dashboard`, `apps/purger`, or `packages/cli` to avoid CI bloat.

#### Target 1: `packages/lease` (Cryptographic Trust Root & Canonicalization)
- **Files to Mutate:**
  - `packages/lease/src/canonicalize.ts` — RFC 8785 JSON Canonicalization Scheme (JCS).
  - `packages/lease/src/crypto.ts` — Ed25519 envelope signing, key resolution, and signature verification.
  - `packages/lease/src/chain.ts` — RFC 8785 + SHA-256 audit ledger hash chaining and continuity verification.
  - `packages/lease/src/keyset.ts` — Keyset parsing, role mapping (`lease_signer`), and key status enforcement.
- **Excluded:** `src/index.ts`, `src/**/*.test.ts`, `dist/**`.

#### Target 2: `packages/sdk` (In-Process Hot Path & Evaluation Invariants)
- **Files to Mutate:**
  - `packages/sdk/src/lease-store.ts` — Dual-clock auto-expiry calculation: $\min(\text{mono\_expiry}, \text{wall\_expiry})$.
  - `packages/sdk/src/provider.ts` — Fail-safe hot path delegation fallback to delegate provider on any internal error.
  - `packages/sdk/src/telemetry-hook.ts` — Zero-context tuple aggregation (`flag_key, variant, reason`) with zero context attributes.
- **Excluded:** `src/index.ts`, `src/**/*.test.ts`, `benchmarks/**`, `dist/**`.

---

### 3.2 Non-Negotiable Invariants to Kill (Pass/Fail Rubric)

Your test suites must kill 100% of mutants attempting to break these architectural invariants:

| Invariant | Targeted Mutation Scenario | Expected Test Catch / Kill |
|---|---|---|
| **Invariant 1: Fail-Safe Delegation** | Mutator removes `try { ... } catch { return this.delegate.resolve... }` or replaces fallback with `throw err`. | `provider.test.ts` fails because evaluation must NEVER crash application traffic. |
| **Invariant 2: Pinned Keyset Trust Root** | Mutator mutates `verifySignature()` to return `true`, flips signature checks, or ignores `key.status === "active"`. | `crypto.test.ts` and `keyset.test.ts` fail immediately on forged or revoked keys. |
| **Invariant 3: Dual-Clock Expiry** | Mutator replaces `Math.min(monoExpiry, wallCeiling)` with `Math.max(...)`, removes `SKEW_TOLERANCE`, or drops monotonic clock checks. | `lease-store.test.ts` and fast-check property tests catch expired leases surviving. |
| **Invariant 4: Dual-Control Reconciliation** | Mutator removes Draft PR branch prefix or skips secondary approval requirement. | Conformance and CLI promote unit tests fail. |
| **Invariant 5: Zero-Context Telemetry** | Mutator injects `evaluationContext` or user targeting attributes into aggregated telemetry records. | `telemetry-hook.test.ts` assertions on tuple keys fail. |
| **Invariant 7: Tamper-Evident Ledger** | Mutator swaps SHA-256 with MD5, skips canonicalization, or ignores `prev_hash` comparison. | `chain.test.ts` and `audit.test.ts` detect broken chains. |

---

### 3.3 Implementation Blueprint for PR 28

#### Step 1: Install Dependencies
Install Stryker Mutator core and runner plugins in both target packages:
```bash
# In packages/lease
pnpm --filter @synapsestate/lease add -D @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker

# In packages/sdk
pnpm --filter @synapsestate/sdk add -D @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker
```

#### Step 2: Configure `packages/lease/stryker.config.json`
Create [`packages/lease/stryker.config.json`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease/stryker.config.json):
```json
{
  "$schema": "../../node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "testRunnerNodeArgs": ["--experimental-vm-modules"],
  "coverageAnalysis": "perTest",
  "mutate": [
    "src/canonicalize.ts",
    "src/crypto.ts",
    "src/chain.ts",
    "src/keyset.ts"
  ],
  "vitest": {
    "configFile": "vitest.config.ts"
  },
  "reporters": ["html", "clear-text", "progress"],
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "thresholds": {
    "high": 90,
    "low": 80,
    "break": 80
  },
  "tempDirName": ".stryker-tmp"
}
```

#### Step 3: Configure `packages/sdk/stryker.config.json`
Create [`packages/sdk/stryker.config.json`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk/stryker.config.json):
```json
{
  "$schema": "../../node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "pnpm",
  "testRunner": "vitest",
  "testRunnerNodeArgs": ["--experimental-vm-modules"],
  "coverageAnalysis": "perTest",
  "mutate": [
    "src/lease-store.ts",
    "src/provider.ts",
    "src/telemetry-hook.ts"
  ],
  "vitest": {
    "configFile": "vitest.config.ts"
  },
  "reporters": ["html", "clear-text", "progress"],
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "thresholds": {
    "high": 90,
    "low": 80,
    "break": 80
  },
  "tempDirName": ".stryker-tmp"
}
```

#### Step 4: Add Package Scripts
Update [`packages/lease/package.json`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/lease/package.json):
```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "vitest run",
  "test:mutation": "stryker run",
  "test:mutation:fast": "stryker run --since origin/main",
  "typecheck": "tsc --noEmit"
}
```

Update [`packages/sdk/package.json`](file:///c:/Users/adity/Desktop/Projects/SynapseState/packages/sdk/package.json):
```json
"scripts": {
  "bench": "tsx benchmarks/run.ts",
  "bench:vitest": "vitest bench --run",
  "build": "tsc -p tsconfig.json",
  "test": "vitest run",
  "test:mutation": "stryker run",
  "test:mutation:fast": "stryker run --since origin/main",
  "typecheck": "tsc --noEmit && tsc -p tsconfig.bench.json --noEmit"
}
```

Update root [`package.json`](file:///c:/Users/adity/Desktop/Projects/SynapseState/package.json):
```json
"scripts": {
  "test:mutation": "pnpm --filter @synapsestate/lease run test:mutation && pnpm --filter @synapsestate/sdk run test:mutation",
  "test:mutation:fast": "pnpm --filter @synapsestate/lease run test:mutation:fast && pnpm --filter @synapsestate/sdk run test:mutation:fast"
}
```

#### Step 5: Add CI Job in `.github/workflows/ci.yml`
Add a dedicated, non-blocking or blocking mutation testing job:
```yaml
  mutation-tests:
    name: Mutation Testing (Stryker)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js 22.x
        uses: actions/setup-node@v4
        with:
          node-version: 22.x
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build packages
        run: pnpm run build

      - name: Run Stryker Mutation Testing (Core Invariants)
        run: pnpm run test:mutation:fast
```

#### Step 6: Step-by-Step Implementation Workflow
1. **Branch Out:** `git checkout main && git pull && git checkout -b test/mutation-stryker-invariants`.
2. **Install & Configure:** Add the dependencies and create the configuration files as defined above.
3. **Execute Initial Run:** Run `pnpm --filter @synapsestate/lease test:mutation` to establish the baseline Mutation Score Indicator (MSI).
4. **Identify Surviving Mutants:** Inspect the generated `reports/mutation/mutation.html` report for surviving mutants.
5. **Add Targeted Unit Tests:** For any surviving mutant touching invariant logic (dual-clock bounds, signature verification, canonicalization ordering), add unit tests to kill the mutant.
6. **Achieve Minimum Threshold:** Ensure MSI $\ge 80\%$ on both packages.
7. **Full Monorepo Validation:** Ensure `pnpm run lint`, `pnpm run typecheck`, and `pnpm run test` remain 100% green.
8. **Submit PR:** Open PR titled `test(mutation): establish Stryker mutator testing for lease and sdk invariants (PR 28)`.

---

## 4. PR 29: Automated Chaos & Fault-Injection Pipeline — [QUEUED]

### 4.1 Scope & Automated Harness
Automate the 3 existing chaos failure drills ([test/drills/](file:///c:/Users/adity/Desktop/Projects/SynapseState/test/drills/)) into a continuous CI drill matrix:
1. **Drill 1: Air-Gapped Override Channel (`drill1-airgap-override.test.ts`):** Complete Control API network partition; SDK evaluates signed emergency override loaded from local disk mount without crashing or stalling.
2. **Drill 2: Host Clock Skew & NTP Rollback (`drill2-clock-skew.test.ts`):** Injects $\pm 120\text{ s}$ monotonic and wall-clock skew; verifies zero leases survive past deadline ($\min(\text{mono}, \text{wall})$).
3. **Drill 3: Network Partition During Revocation (`drill3-revocation-partition.test.ts`):** Partitions lease revocation stream; confirms exposure is strictly bounded by remaining TTL with immediate fallback to delegate provider upon expiry.

### 4.2 CI Execution Command
```bash
pnpm vitest run test/drills/
# Target SLO: 3/3 drills pass with zero app crashes and zero past-deadline evaluations
```

---

## 5. Phase 7 Deliverables & Kill Criteria

All Phase 7 pull requests must satisfy these quantitative kill criteria prior to merge:

| Metric | Target | Failure / Kill Criterion |
|---|---|---|
| **E2E Pass Rate (PR 27 / PR #28)** | 100% (16/16 tests passing) | Any flake, route-interception mock, or unasserted reset failure. |
| **Mutation Score - Lease (PR 28)** | $\text{MSI} \ge 80\%$ | $\text{MSI} < 80\%$ or surviving mutant in Ed25519 verification. |
| **Mutation Score - SDK (PR 28)** | $\text{MSI} \ge 80\%$ | $\text{MSI} < 80\%$ or surviving mutant in dual-clock expiry calculation. |
| **Chaos Failure Drills (PR 29)** | 100% pass (3/3 drills) | Single unhandled exception or lease surviving past TTL bound. |
| **Hot-Path Overhead Impact** | 0 ns added to `OverrideProvider` | Any regression in hot-path benchmark resolution. |
