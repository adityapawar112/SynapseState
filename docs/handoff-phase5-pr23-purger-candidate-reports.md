# SynapseState Handoff: Phase 5 PR 23 Onboarding (Candidate Extraction & Refusal Reports)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 5 (Weeks 9 – 10: Telemetry Qualification & Codebase Scanner)  
> **Current Target:** PR 23 (`feat/purger-candidate-reports`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Branch:** `feat/purger-ts-morph-scanner` (PR 22 complete, verified, pushed to origin; ready to merge into `main` before branching `feat/purger-candidate-reports`)  
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§9 Telemetry-Driven Stale Detection & Scanner, §10 Security Threat Model)
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 5, Deliverable 5.3 & PR 23)
> - Glossary: [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md)

---

## 1. Suggested Skills

The next agent picking up this task should call the following skills:

- `test-driven-development`: Write failing tests with sample candidate flags, scan results, and refusal scenarios before implementing report generation logic.
- `domain-modeling`: Model report structures (`CandidateReport`, `RefusalReport`, `PiranhaConfig`, `ReportFormatOptions`) cleanly in `apps/purger/src/reports/types.ts`.
- `verification-before-completion`: Run all monorepo quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test`) with raw command output before claiming completion.

---

## 2. Executive Summary & Monorepo State (PR 22 Completion)

**PR 22 (`feat/purger-ts-morph-scanner`)** is complete, peer-reviewed, hardened, verified, and pushed to `origin/feat/purger-ts-morph-scanner`:

- **Domain Modeling (`apps/purger/src/scanner/types.ts`):**
  - Canonical domain types: `OpenFeatureEvalMethod`, `ScannerRefusalReason`, `SourceLocation`, `EnclosingScope`, `RefusalMarker`, `CallSite`, `ASTFlagReference`, `ConsumerCrossReference`, `CodebaseScanResult`, `ScannerOptions`, `CrossReferenceOptions`.
  - Defined `OPENFEATURE_EVAL_METHODS` (`getBooleanValue`, `getStringValue`, `getNumberValue`, `getObjectValue` and their respective `*Details` variants).
  - Updated [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md) with `Call Site` and `Undeclared Caller`.
- **Pure Read-Only AST Scanner (`apps/purger/src/scanner/scanner.ts`):**
  - Read-only AST parser using `ts-morph` adhering strictly to Invariant 6 (zero untrusted code execution; never runs `npm test`, `eval()`, or repository build scripts).
  - **Refusal by Default on Non-Literal Keys:** Fails closed and tags call sites with `RefusalMarker` (`NON_LITERAL_FLAG_KEY`) on dynamic binary concatenations (`prefix + key`), variable identifiers, ternary expressions, interpolated template literals, function calls, and property accesses.
  - **Static Literal Extraction:** Correctly identifies literal strings and static template literals without substitutions (`` `static-key` ``).
  - **Argument Validation:** Fails closed with structured refusal markers on 0-argument calls (`MISSING_ARGUMENTS`) and 1-argument calls (`MISSING_DEFAULT_VALUE`).
  - **Scope & Context Extraction:** Extracts 1-indexed line/column coordinates, enclosing function name (including arrow functions assigned to variables), and enclosing class name.
  - **Service Resolution:** `defaultServiceResolver` maps repository file paths (`apps/*`, `packages/*`, `services/*`) using innermost component matching for workspace compatibility, with custom resolver override support.
  - **Flag Caller Indexing:** Aggregates call sites by flag key, computing caller counts and consumer services.
  - **Consumer Cross-Referencing (`crossReferenceConsumers`):** Cross-references candidate flags from PR 21 telemetry against AST consumers, accurately flagging undeclared callers (`UNDECLARED_CONSUMER_SERVICE`) and unreferenced services.
- **Package Surface (`apps/purger/src/index.ts`):**
  - Named exports for all scanner types, constants, and functions (`scanSourceFiles`, `scanSourceTexts`, `scanCodebase`, `crossReferenceConsumers`, `defaultServiceResolver`, `OPENFEATURE_EVAL_METHODS`).
- **Verification Evidence:**
  - Purger test suite (`pnpm --filter @synapsestate/purger test`): **57/57 passed** across 4 test files (`scanner.test.ts`, `engine.test.ts`, `queries.test.ts`, `index.test.ts`).
  - Monorepo linter (`pnpm run lint`): **0 errors, 0 warnings** across entire repository.
  - Monorepo build (`pnpm -r run build`): **0 errors** across all 7 workspace packages.
  - Monorepo typecheck (`pnpm run typecheck`): **0 errors** across all workspace projects, load scripts, and drill tests.
  - Monorepo test suite (`pnpm test`): **569 passed** (0 failures).

---

## 3. PR 23 Scope & Deliverables (`feat/purger-candidate-reports`)

The objective for Phase 5 PR 23 is to deliver **Deliverable 5.3 (Structured Candidate & Refusal Reports)** in `apps/purger/src/reports/` according to [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md#L225-L235) and [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md#L613-L633).

```
apps/purger/
└── src/
    ├── qualification/        # PR 21 (Complete)
    ├── scanner/              # PR 22 (Complete)
    ├── reports/              # PR 23 Target
    │   ├── types.ts          # Report domain models (CandidateReport, RefusalReport, ToolConfig)
    │   ├── candidate.ts      # Structured candidate report generator (Markdown, JSON, Uber Piranha / GritQL configs)
    │   ├── refusal.ts        # Structured refusal report generator (Blocking services, dynamic AST reasons)
    │   ├── reports.test.ts   # Comprehensive test suite for report formatting and tool configurations
    │   └── index.ts          # Report module exports
    └── index.ts
```

### Key Requirements for PR 23:

1. **Structured Candidate Reports (`apps/purger/src/reports/candidate.ts`):**
   - Ingest qualified candidates (from PR 21 `CandidateFlag`) and AST cross-reference results (from PR 22 `ConsumerCrossReference`).
   - Format human-readable Markdown issue bodies / CLI output containing:
     - Exact `(flag_key, winning_variant)` tuples.
     - Call site table: file path, line numbers, enclosing function/method, and current default value.
     - Summary of evaluating services and telemetry observation span.
   - Format machine-readable output:
     - Uber Piranha configuration / properties mapping flag key to target winning boolean / string variant.
     - GritQL query / pattern definition for automated AST transformation.
2. **Structured Refusal Reports (`apps/purger/src/reports/refusal.ts`):**
   - Format human-readable and structured refusal reports for disqualified flags or AST scan mismatches:
     - Non-literal dynamic keys (exact file, line, column, and code snippet).
     - Silent service blockers (service name, days silent $> 14$).
     - Undeclared consumer services (AST caller with 0 telemetry evaluations).
     - Missing default values or un-finalized promotions / active leases.
   - Actionable remediation advice for operators (e.g., `synapse service retire --service <name>` or refactoring dynamic key to literal string).
3. **Purger Entrypoint Integration (`apps/purger/src/index.ts`):**
   - High-level orchestration function `runPurgerAudit(options)` or pipeline connecting qualification -> AST scan -> candidate/refusal report emission.

---

## 4. Immediate Next Steps for Next Session

1. **Merge PR 22 into `main`:**
   ```bash
   git checkout main
   git merge feat/purger-ts-morph-scanner
   git push origin main
   ```
2. **Branch PR 23:**
   ```bash
   git checkout -b feat/purger-candidate-reports
   ```
3. **Implement Report Generation TDD Cycle:**
   - Define domain models in `apps/purger/src/reports/types.ts`.
   - Write failing unit tests in `apps/purger/src/reports/reports.test.ts`.
   - Implement candidate report formatter and refusal report formatter.
   - Verify all tests pass, run all monorepo gates (`lint`, `build`, `typecheck`, `test`).
