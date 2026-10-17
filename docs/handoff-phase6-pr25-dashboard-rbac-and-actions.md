# SynapseState Handoff: Phase 6 PR 25 Onboarding (Dashboard RBAC Controls & Action Triggers)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 6 (Weeks 11 – 12: Operations Dashboard & Optional Push Automation)  
> **Current Target:** PR 25 (`feat/dashboard-rbac-and-actions`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Branch:** `feat/dashboard-nextjs-portal` (PR 24 complete, verified, ready to merge into `main` before branching `feat/dashboard-rbac-and-actions`)  
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§8 Operations Dashboard, §10 Security Threat Model)
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§6 Phase 6, Deliverable 6.1 & PR 25)
> - Glossary: [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md)

---

## 1. Suggested Skills

The next agent picking up this task should call the following skills:

- `test-driven-development`: Implement OAuth callback flow, GitHub token exchange, session revocation, and lease promotion trigger actions test-first.
- `domain-modeling`: Model audit events emitted during dashboard operations (`DASHBOARD_LOGIN`, `DASHBOARD_REVOKE_TRIGGERED`, `DASHBOARD_PROMOTE_TRIGGERED`).
- `react-best-practices`: Review Next.js client/server boundaries, server actions, and optimistic UI transitions.
- `verification-before-completion`: Run all monorepo quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test`) before making completion claims.

---

## 2. Executive Summary & Monorepo State (PR 24 Completion)

**PR 24 (`feat/dashboard-nextjs-portal`)** is complete, verified, and ready to merge into `main`:

- **Next.js 15 App Router Portal (`apps/dashboard/`):**
  - Next.js 15 + React 19 operational portal with glassmorphic design and zero TailwindCSS dependency.
  - Dark mode with live status indicators, environment selector (`prod`, `staging`, `dev`), and responsive layouts.
  - Prominently displays the architectural invariant banner: **"Read-mostly portal: Emergency break-glass leases are cryptographically signed on operator workstations. Control API and web tier never store private signing keys."**
- **Domain Modeling & View Contracts (`apps/dashboard/src/lib/`):**
  - `domain.ts` & `types.ts`: Computes dual-clock remaining seconds (`calculateLeaseExpiryView`), near-expiry detection (<300s), variant evaluation distribution percentages (`calculateVariantDistribution`), quiescence evaluation & purge candidate qualification (`evaluateFlagQuiescence`), cryptographic hash-chain continuity verification (`verifyAuditLedgerChain`), and role permission checks (`hasRolePermission`).
- **Control API Client (`apps/dashboard/src/lib/api.ts`):**
  - Consumes `GET /v1/sdk/state`, `GET /v1/changes`, `GET /v1/audit/events`, `GET /v1/audit/checkpoint/latest`, and proxies `POST /v1/leases/:id/revoke`.
- **Session Authentication & RBAC (`apps/dashboard/src/lib/auth.ts`):**
  - Compact signed session tokens (`base64url(payload).hmac_signature`), expiry enforcement, role resolution (`admin`, `operator`, `viewer`), CSRF token generation & validation, and dev session mock for local testing.
- **Route Protection Middleware (`apps/dashboard/src/middleware.ts`):**
  - Guards page and API routes; redirects unauthenticated users to `/login`; rejects unauthorized mutation attempts with HTTP 403 Forbidden.
- **Interactive Operations Components (`apps/dashboard/src/components/`):**
  - `LeaseCard.tsx`: Real-time dual-clock countdown timer with visual near-expiry and expired states.
  - `RevokeModal.tsx`: Accessible confirmation modal with reason prompt, audit ledger notice, and workstation CLI alternative command.
  - `TelemetryChart.tsx`: Pure CSS variant evaluation distribution bar highlighting winning variants.
  - `RoleBadge.tsx`: Visual badge for user role (`viewer`, `operator`, `admin`).
- **Operations Pages (`apps/dashboard/src/app/`):**
  - `/`: Overview with live stat cards, active overrides list, and SRE incident runbook cheat sheet.
  - `/leases`: Active and historic leases explorer with status and environment filters.
  - `/flags`: Feature flag inventory with variant telemetry rollups, quiescence markers, and purge candidate tags.
  - `/audit`: Tamper-evident ledger explorer with real-time SHA-256 hash-chain verification and sequence pagination.
  - `/login`: OIDC portal and development role switcher.
- **Verification Evidence:**
  - Dashboard test suite (`pnpm --filter @synapsestate/dashboard test`): **36/36 passed** across 4 test files (`auth.test.ts`, `domain.test.ts`, `api.test.ts`, `middleware.test.ts`).
  - Monorepo linter (`pnpm run lint`): **0 errors, 0 warnings** across the workspace.
  - Monorepo build (`pnpm -r run build`): **0 errors** across all 8 workspace projects.
  - Monorepo typecheck (`pnpm run typecheck`): **0 errors** across all workspace packages and apps.
  - Full test suite (`pnpm test`): **599 passed** (0 failures).

---

## 3. PR 25 Scope & Deliverables (`feat/dashboard-rbac-and-actions`)

The objective for Phase 6 PR 25 is to deliver **Deliverable 6.2 (RBAC Controls and Action Triggers)**:

1. **GitHub OAuth / OIDC Live Integration:**
   - Implement real GitHub OAuth app redirect (`/api/auth/github`) and token exchange callback (`/api/auth/callback`).
   - Query GitHub API for user organization memberships and team memberships (`/user/teams` or `/orgs/:org/teams`).
   - Map GitHub team slugs to SynapseState roles via `SYNAPSE_ADMIN_TEAMS` and `SYNAPSE_OPERATOR_TEAMS`.
2. **Lease Promotion Trigger Seam (`/api/actions/promote`):**
   - Connect dashboard "Promote to Git" action to Control API `POST /v1/leases/:id/promote`.
   - Displays real-time GitHub PR creation status and link to the generated Draft Pull Request.
3. **Session Management & Audit Logging:**
   - Log dashboard administrative actions to Control API audit ledger.
   - User profile dropdown with session expiry countdown and explicit logout trigger.

---

## 4. Immediate Next Steps for Next Session

1. **Merge PR 24 into `main`:**
   ```bash
   git checkout main
   git merge feat/dashboard-nextjs-portal
   git push origin main
   ```
2. **Branch PR 25:**
   ```bash
   git checkout -b feat/dashboard-rbac-and-actions
   ```
3. **Implement Live OIDC Integration & Promotion Action Triggers:**
   - Implement GitHub OAuth route handlers in `apps/dashboard/src/app/api/auth/`.
   - Implement `/api/actions/promote/route.ts` with promotion status tracking.
   - Verify all monorepo gates (`lint`, `build`, `typecheck`, `test`).
