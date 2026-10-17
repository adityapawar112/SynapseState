# SynapseState Handoff: Phase 5 PR 22 Onboarding (Purger Read-Only ts-morph AST Scanner)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 5 (Weeks 9 – 10: Telemetry Qualification & Codebase Scanner)  
> **Current Target:** PR 22 (`feat/purger-ts-morph-scanner`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Branch:** `feat/purger-quiescence-engine` (PR 21 complete, verified, pushed to origin; ready to merge into `main` before branching `feat/purger-ts-morph-scanner`)  
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§9 Telemetry-Driven Stale Detection & Scanner, §10 Security Threat Model)
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 5, Deliverable 5.2 & PR 22)
> - Glossary: [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md)

---

## 1. Suggested Skills

The next agent picking up this task should call the following skills:

- `test-driven-development`: Write failing tests with sample TypeScript source fixtures (literal keys, dynamic expressions, OpenFeature helper calls, non-boolean variants) before writing scanner logic.
- `domain-modeling`: Model scanner domain structures (`CallSite`, `ScanResult`, `ScannerOptions`, `RefusalMarker`) cleanly in `apps/purger/src/scanner/types.ts`.
- `verification-before-completion`: Run all monorepo quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test`) with raw command output before claiming completion.

---

## 2. Executive Summary & Monorepo State (PR 21 Completion)

**PR 21 (`feat/purger-quiescence-engine`)** is complete, peer-reviewed, hardened against all feedback, verified, and pushed to `origin/feat/purger-quiescence-engine` (`33c2c40`):

- **Domain Modeling (`apps/purger/src/qualification/types.ts`):**
  - Canonical domain types: `FlagLifecycleClass`, `ServiceStatus`, `QualificationStatus`, `DisqualificationReason`, `CandidateFlag`, `QualificationResult`, `FlagTelemetrySnapshot`, and `Queryable`.
  - Disqualification reasons: `EXCLUDED_LIFECYCLE_CLASS`, `MULTI_VARIANT_ACTIVE`, `INSUFFICIENT_WINDOW`, `BLOCKED_BY_SILENT_SERVICE`, `ACTIVE_LEASE_EXISTS`, `UNREGISTERED_FLAG`, `MISSING_DEFAULT_VARIANT`.
  - Updated [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md) with `Silent Service` (>14 days threshold) and `Winning Variant`.
- **Pure Qualification Engine (`apps/purger/src/qualification/engine.ts`):**
  - Pure function `evaluateCandidateQuiescence(snapshot, options)` adhering to Invariant 6 (zero external I/O or database handles).
  - Evaluates lifecycle class, active unexpired emergency leases, consumer coverage, observation window, and variant invariance.
  - **C1 Span Validation:** Verifies telemetry span spans $\ge \text{minWindowDays}$; flags with short evaluation spans (e.g. 2 days) fail with `INSUFFICIENT_WINDOW`.
  - **C2 Fail-Closed Winning Variant:** Fails closed on 0-evaluation flags with `MISSING_DEFAULT_VARIANT` when no default is configured, eliminating arbitrary variant guessing.
  - **I1 Sentinel Omission:** Candidate models omit `firstSeen`/`lastSeen` on 0-evaluation flags rather than emitting deceptive 1970-01-01 epoch strings.
  - Batch evaluation support: `qualifyFlagTelemetryBatch(snapshots, options)` with verified input immutability.
- **SQL Rollup Engine (`apps/purger/src/qualification/queries.ts`):**
  - Parameterized SQL query `buildQuiescenceRollupQuery(options)` scanning `flag_usage_daily`, `flags`, `services`, and `leases`.
  - Idiomatic interval date math: `usage_date >= CURRENT_DATE - make_interval(days => $1::int)`.
  - Active lease liveness check: `WHERE state = 'ACTIVE' AND expires_at > NOW()`.
  - Quoted reserved columns (`f."key"`, `f."class"`, `f."created_at"`).
  - Service status resolution with fallback to `SILENT` for unregistered consumer services.
  - Subquery JSON aggregation preventing cartesian product duplication between variants and services; redundant outer `GROUP BY` eliminated.
  - Pure row mapper `mapRowToFlagTelemetrySnapshot(row, windowDays)` with `safeIsoString` error shielding and data-derived effective `windowDays`.
  - Retrieval helper `fetchFlagTelemetrySnapshots(db, options)`.
- **Package Surface (`apps/purger/src/index.ts`):**
  - Explicit named exports for types, functions, and query utilities.
- **Verification Evidence:**
  - Purger test suite (`pnpm --filter @synapsestate/purger run test`): **31/31 passed** across 3 test files (`engine.test.ts`, `queries.test.ts`, `index.test.ts`).
  - Monorepo linter (`pnpm run lint`): **0 errors, 0 warnings** across all packages.
  - Monorepo build (`pnpm -r run build`): **0 errors** across all 7 workspace packages.
  - Monorepo typecheck (`pnpm run typecheck`): **0 errors** across all packages.
  - Monorepo test suite (`pnpm test`): **405+ tests passed** (0 failures).

---

## 3. PR 22 Scope & Deliverables (`feat/purger-ts-morph-scanner`)

The objective for Phase 5 PR 22 is to deliver **Deliverable 5.2 (Read-Only TypeScript Scanner)** in `apps/purger/src/scanner/` according to [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md#L220-L224) and [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L605-L612).

```
apps/purger/
└── src/
    ├── qualification/        # PR 21 (Complete)
    ├── scanner/              # PR 22 Target
    │   ├── types.ts          # Scanner models (CallSite, ASTFlagReference, RefusalMarker, ScanReport)
    │   ├── scanner.ts        # Pure read-only ts-morph AST scanner
    │   ├── scanner.test.ts   # Comprehensive test suite with ts-morph in-memory fixtures
    │   └── index.ts          # Scanner exports
    └── index.ts
```

### Key Requirements for PR 22:

1. **AST Call Site Detection (`apps/purger/src/scanner/scanner.ts`):**
   - Parse TypeScript source files using `ts-morph` in-memory project.
   - Detect OpenFeature client method calls:
     - `client.getBooleanValue('flag-key', defaultValue)`
     - `client.getStringValue('flag-key', defaultValue)`
     - `client.getNumberValue('flag-key', defaultValue)`
     - `client.getObjectValue('flag-key', defaultValue)`
   - Extract caller context:
     - File path, 1-indexed line number, column number.
     - Enclosing function/method name and class name (if applicable).
     - Default value expression text.
2. **Refusal by Default on Non-Literal Keys (Security & Precision Gate):**
   - If the first argument (`flagKey`) is NOT a string literal (e.g. ternary `cond ? 'a' : 'b'`, variable reference `myFlag`, identifier, or expression), tag the call site with a `RefusalMarker` (`NON_LITERAL_FLAG_KEY`).
   - Purger must never guess or use heuristics on dynamic expressions.
3. **Consumer Cross-Referencing:**
   - Map discovered call sites to enclosing service package/directory.
   - Cross-reference AST consumer references against runtime evaluated services from PR 21 candidate flags.
   - Detect and flag undeclared callers (AST call sites found in services with 0 recorded evaluations).
4. **Security & Boundary Invariants (Invariant 6):**
   - Strictly read-only AST parser. Zero execution of `npm test`, `eval()`, or build scripts.

---

## 4. Immediate Next Steps for Next Session

1. **Merge PR 21 into `main`:**
   ```bash
   git checkout main
   git merge feat/purger-quiescence-engine
   git push origin main
   ```
2. **Branch PR 22:**
   ```bash
   git checkout -b feat/purger-ts-morph-scanner
   ```
3. **Implement Scanner TDD Cycle:**
   - Define types in `apps/purger/src/scanner/types.ts`.
   - Write failing unit tests in `apps/purger/src/scanner/scanner.test.ts` with in-memory code snippets.
   - Implement read-only AST visitor in `apps/purger/src/scanner/scanner.ts`.
   - Verify all tests pass, run all monorepo gates (`lint`, `build`, `typecheck`, `test`).
