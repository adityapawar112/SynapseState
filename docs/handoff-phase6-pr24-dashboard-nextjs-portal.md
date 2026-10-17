# SynapseState Handoff: Phase 6 PR 24 Onboarding (Next.js Operations Dashboard Portal)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 6 (Weeks 11 – 12: Operations Dashboard & Optional Push Automation)  
> **Current Target:** PR 24 (`feat/dashboard-nextjs-portal`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Branch:** `feat/purger-candidate-reports` (PR 23 complete, verified, ready to merge into `main` before branching `feat/dashboard-nextjs-portal`)  
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§8 Operations Dashboard, §10 Security Threat Model)
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§6 Phase 6, Deliverable 6.1 & PR 24)
> - Glossary: [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md)

---

## 1. Suggested Skills

The next agent picking up this task should call the following skills:

- `test-driven-development`: Implement server actions, API route proxies, and RBAC authorization hooks test-first.
- `domain-modeling`: Model dashboard data contracts (`DashboardOverview`, `ActiveLeaseView`, `FlagInventoryView`, `OidcSessionUser`, `UserRole`) cleanly.
- `react-best-practices`: Review Next.js TSX components for accessibility, client/server boundary discipline, and performance.
- `verification-before-completion`: Run all monorepo quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test`) before making completion claims.

---

## 2. Executive Summary & Monorepo State (PR 23 Completion)

**PR 23 (`feat/purger-candidate-reports`)** is complete, peer-reviewed, hardened against all feedback, verified, and pushed to `origin/feat/purger-candidate-reports` (`417efe6`):

- **Domain Modeling & Reporting Surface (`apps/purger/src/reports/`):**
  - Canonical domain types in `apps/purger/src/reports/types.ts`: `CandidateReport`, `RefusalReport`, `RefusalItem`, `CallSiteReportRow`, `PiranhaConfig`, `GritQLPattern`, `PurgerAuditResult`, `PurgerAuditOptions`.
  - Added `Candidate Report` to canonical [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md).
- **Structured Candidate Reports (`apps/purger/src/reports/candidate.ts`):**
  - Ingests qualified `CandidateFlag` and static AST `ConsumerCrossReference` results.
  - Automatically infers literal variant data type (`boolean`, `string`, `number`, `object`) with strict regex and JSON validation.
  - Generates machine-readable **Uber Piranha** configurations (`piranha_arguments.json`) mapping target flags to winning variants with type-aware method bindings.
  - Generates machine-readable **GritQL** pattern query definitions (`rules.grit`) for declarative AST transformation with safe string and flag key escaping.
  - Formats GitHub-flavored Markdown issue bodies and CLI terminal summaries.
- **Structured Refusal Reports (`apps/purger/src/reports/refusal.ts`):**
  - Handles qualification refusals: `BLOCKED_BY_SILENT_SERVICE`, `ACTIVE_LEASE_EXISTS`, `MULTI_VARIANT_ACTIVE`, `INSUFFICIENT_WINDOW`, `EXCLUDED_LIFECYCLE_CLASS`, `UNREGISTERED_FLAG`, `MISSING_DEFAULT_VARIANT`.
  - Handles AST scanner / cross-reference refusals: `NON_LITERAL_FLAG_KEY`, `UNDECLARED_CONSUMER_SERVICE`, `MISSING_ARGUMENTS`, `MISSING_DEFAULT_VALUE`, `SCAN_ERROR`, `CONSISTENCY_MISMATCH`.
  - Emits copy-pasteable operator remediation commands with multi-service command chaining (`synapse service retire --service s1 && synapse service retire --service s2`).
- **Full Purger Audit Pipeline (`apps/purger/src/reports/audit.ts`):**
  - `runPurgerAudit(options)`: Connects qualification -> AST codebase scanning -> consumer cross-referencing -> candidate/refusal report emission.
  - **Refusal-by-default on 0 call sites (C1):** Flags with 0 discovered AST call sites fail closed to refusal rather than qualifying without evidence.
  - **Strict unreferenced service verification:** `allowUnreferencedServices` defaults to `false`.
  - Multi-report summary formatters: `formatPurgerAuditMarkdown(audit)` and `formatPurgerAuditCli(audit)`.
- **Purger Package Surface (`apps/purger/src/index.ts`):**
  - Full named exports for all candidate, refusal, and audit pipeline utilities and domain types.
- **Verification Evidence:**
  - Purger test suite (`pnpm --filter @synapsestate/purger test`): **93/93 passed** across 5 test files (`reports.test.ts`, `scanner.test.ts`, `queries.test.ts`, `engine.test.ts`, `index.test.ts`).
  - Monorepo linter (`pnpm run lint`): **0 errors, 0 warnings** across all packages.
  - Monorepo build (`pnpm -r run build`): **0 errors** across all workspace packages.
  - Monorepo typecheck (`pnpm run typecheck`): **0 errors** across all workspace projects, load scripts, and drill tests.
  - Full test suite (`pnpm test`): **605 passed** (0 failures).

---

## 3. PR 24 Scope & Deliverables (`feat/dashboard-nextjs-portal`)

The objective for Phase 6 PR 24 is to deliver **Deliverable 6.1 (Read-Mostly Next.js Operations Dashboard Portal)** in `apps/dashboard/`:

```
apps/dashboard/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root operations layout with navigation header & theme
│   │   ├── page.tsx                # Overview: active leases, countdowns, health metrics
│   │   ├── leases/page.tsx         # Active emergency leases list & inspect view
│   │   ├── flags/page.tsx          # Flag inventory & telemetry rollups
│   │   ├── audit/page.tsx          # Tamper-evident ledger & checkpoint audit log
│   │   └── api/auth/               # GitHub OIDC authentication route handler
│   ├── components/
│   │   ├── LeaseCard.tsx           # Active lease countdown timer & metadata
│   │   ├── RevokeModal.tsx         # Confirmation modal for lease revocation
│   │   ├── TelemetryChart.tsx      # Evaluated variant distribution summary
│   │   └── RoleBadge.tsx           # User role indicator (viewer / operator / admin)
│   ├── lib/
│   │   ├── api.ts                  # Control API client for dashboard backend proxy
│   │   ├── auth.ts                 # OIDC authentication & RBAC session validator
│   │   └── types.ts                # Dashboard view models and session types
│   └── middleware.ts               # Route protection & role-based access control
└── package.json
```

### Key Requirements for PR 24:

1. **Read-Mostly Portal with Strict Safety Boundaries:**
   - Visualizes active emergency leases with real-time monotonic countdown timers and wall-clock expiry bounds.
   - Flag inventory view showing evaluations, variant rollups, and quiescence / stale candidate status.
   - Audit trail explorer displaying hash-chained sealed records and signed checkpoints.
   - **Safety Boundary Invariant:** The dashboard **cannot create leases** (signing keys reside strictly on operator workstations). It can trigger lease revocation or view PR promotions.
2. **GitHub OIDC RBAC:**
   - Roles: `viewer` (read-only views), `operator` (can trigger revocation API calls), `admin` (can configure retention and service retirements).
   - Session validation and CSRF protection on mutation routes.
3. **Integration with Control API:**
   - Consumes `GET /v1/sdk/state`, `GET /v1/leases`, `GET /v1/audit/ledger`, and telemetry rollup endpoints.

---

## 4. Immediate Next Steps for Next Session

1. **Merge PR 23 into `main`:**
   ```bash
   git checkout main
   git merge feat/purger-candidate-reports
   git push origin main
   ```
2. **Branch PR 24:**
   ```bash
   git checkout -b feat/dashboard-nextjs-portal
   ```
3. **Scaffold / Implement Dashboard Portal:**
   - Define dashboard domain models and API client contracts.
   - Implement read-mostly Next.js pages and OIDC authentication.
   - Verify all monorepo gates (`lint`, `build`, `typecheck`, `test`).
