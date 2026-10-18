# SynapseState Handoff: Phase 6 PR 25 Onboarding (Dashboard RBAC Controls & Action Triggers)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 6 (Weeks 11 – 12: Operations Dashboard & Optional Push Automation)  
> **Current Target:** PR 25 (`feat/dashboard-rbac-and-actions`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Base PR:** [PR #24 (`feat/dashboard-nextjs-portal`)](https://github.com/adityapawar112/SynapseState/pull/24) (Head: `39f8bdf`, open, code-reviewed, all findings resolved, ready to merge into `main` before branching `feat/dashboard-rbac-and-actions`)  
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§8 Operations Dashboard, §10 Security Threat Model)
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§6 Phase 6, Deliverable 6.1 & PR 25)
> - Design System: [design.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/design.md) (Voltage-as-Canvas, binary radius scale, solid badges with white text)
> - Glossary: [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md)

---

## 1. Suggested Skills

The next agent picking up this task should call the following skills:

- `test-driven-development`: Implement OAuth callback flow, GitHub token exchange, team-to-role mapping, session revocation, and lease promotion trigger actions test-first.
- `domain-modeling`: Model audit events emitted during dashboard operations (`DASHBOARD_LOGIN`, `DASHBOARD_REVOKE_TRIGGERED`, `DASHBOARD_PROMOTE_TRIGGERED`).
- `react-best-practices`: Review Next.js client/server boundaries, server actions, and optimistic UI transitions.
- `verification-before-completion`: Run all monorepo quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test:coverage`) before making completion claims.

---

## 2. Executive Summary & Monorepo State (PR 24 Baseline)

**PR 24 ([#24](https://github.com/adityapawar112/SynapseState/pull/24), branch `feat/dashboard-nextjs-portal`, HEAD: `39f8bdf`)** is complete, code-reviewed, and verified:

- **Next.js 15 App Router Portal (`apps/dashboard/`):**
  - Next.js 15 + React 19 operational portal implementing the **Voltage-as-Canvas** design system codified in [design.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/design.md).
  - Full-bleed voltage hero (`#ff5e1f`), warm cream (`#fffbf5`) display typography, and zero drop-shadow elevation (hairline borders `#f0f0f0` light, `#2a2a2e` dark).
  - 100% solid color fills with crisp white (`#ffffff`) text on all badges and status chips (`MESH ONLINE` `#00bd7d`, `OPERATOR` `#ff5e1f`, `ACTIVE` `#00bd7d`, `NEAR EXPIRY` `#ff5e1f`, `EXPIRED` `#727272`, `REVOKED` `#b52932`).
  - Vector iconography throughout using `react-icons/lu` (Lucide), eliminating raw emoji glyphs.
  - Persistent dark mode (`#0d0d0f` obsidian base, `#1b1b1e` cards) with FOUC-blocking inline theme script.
  - Prominently displays the architectural invariant banner: **"Read-mostly portal: Emergency break-glass leases are cryptographically signed on operator workstations. Control API and web tier never store private signing keys."**
- **Domain Modeling & View Contracts (`apps/dashboard/src/lib/`):**
  - `domain.ts` & `types.ts`: Computes dual-clock remaining seconds (`calculateLeaseExpiryView`), near-expiry detection (<300s), variant evaluation distribution percentages (`calculateVariantDistribution`), quiescence evaluation & purge candidate qualification (`evaluateFlagQuiescence`), cryptographic hash-chain continuity verification (`verifyAuditLedgerChain`), and role permission checks (`hasRolePermission`).
- **Control API Client (`apps/dashboard/src/lib/api.ts`):**
  - Consumes `GET /v1/sdk/state`, `GET /v1/changes`, `GET /v1/audit/events`, `GET /v1/audit/checkpoint/latest`, and proxies `POST /v1/leases/:id/revoke`.
  - Defensive property normalization supporting both snake_case and camelCase payloads without runtime exceptions.
- **Session Authentication & RBAC (`apps/dashboard/src/lib/auth.ts`):**
  - Edge-compatible WebCrypto HMAC session tokens (`crypto.subtle`), expiry enforcement, role resolution (`admin`, `operator`, `viewer`), CSRF double-submit token generation & validation, and dev session mock for local testing.
  - Hard-blocked direct session minting in production under all conditions (`process.env.NODE_ENV === "production"` always rejects).
  - Strict CSRF double-submit protection requiring the `x-synapse-csrf` header (cookie fallback rejected).
  - CSPRNG 256-bit entropy for OAuth state parameters via `crypto.getRandomValues`.
- **Route Protection Middleware (`apps/dashboard/src/middleware.ts`):**
  - Edge Middleware guards page and API routes; redirects unauthenticated requests to `/login`; rejects unauthorized mutation attempts with HTTP 403 Forbidden.
- **Interactive Operations Components (`apps/dashboard/src/components/`):**
  - `LeaseCard.tsx`: Real-time dual-clock countdown timer with visual near-expiry and expired states; conditional "Revoke Override" action visible only to `operator`/`admin`.
  - `RevokeModal.tsx`: Accessible confirmation modal with reason prompt, audit ledger notice, and workstation CLI alternative command.
  - `TelemetryChart.tsx`: Variant evaluation distribution bar highlighting winning variants.
  - `RoleBadge.tsx`: Solid badge for user role (`viewer`, `operator`, `admin`) with white typography and white status indicator dot.
- **Operations Pages (`apps/dashboard/src/app/`):**
  - `/`: Overview with live stat cards, active overrides list, and SRE incident runbook cheat sheet.
  - `/leases`: Active and historic leases explorer with status and environment filters.
  - `/flags`: Feature flag inventory with variant telemetry rollups, quiescence markers, and purge candidate tags.
  - `/audit`: Tamper-evident ledger explorer with real-time SHA-256 hash-chain verification, sequence pagination, and allowlisted payload column formatting.
  - `/login`: OIDC portal and development role switcher.
- **Verification Evidence:**
  - Dashboard test suite (`pnpm --filter @synapsestate/dashboard test`): **51/51 passed** across 6 test files (`auth.test.ts`, `domain.test.ts`, `api.test.ts`, `middleware.test.ts`, `auth/route.test.ts`, `revoke/route.test.ts`).
  - Monorepo linter (`pnpm run lint`): **0 errors, 0 warnings** across the workspace.
  - Monorepo build (`pnpm --filter @synapsestate/dashboard run build`): **0 errors, 0 warnings** across all 12 static/dynamic routes.
  - Monorepo typecheck (`pnpm run typecheck`): **0 errors** across all 8 workspace packages and apps.
  - Full test & coverage suite (`pnpm run test:coverage`): **64 test files / 675+ passed**, coverage computed cleanly.
  - Browser E2E verification: End-to-end verified across all 5 routes, modal interactions, and dark mode transitions.

---

## 3. PR 25 Scope & Deliverables (`feat/dashboard-rbac-and-actions`)

The objective for Phase 6 PR 25 is to deliver **Deliverable 6.2 (RBAC Controls and Action Triggers)**:

1. **GitHub OAuth / OIDC Live Integration:**
   - Complete GitHub OAuth app redirect (`/api/auth/github`) and token exchange callback (`/api/auth/callback`).
   - Query GitHub API for user organization memberships and team memberships (`/user/teams` or `/orgs/:org/teams`).
   - Map GitHub team slugs to SynapseState roles via `SYNAPSE_ADMIN_TEAMS` and `SYNAPSE_OPERATOR_TEAMS`.
   - Store access tokens securely or discard after team resolution, retaining only signed SynapseState session tokens.
2. **Lease Promotion Trigger Seam (`/api/actions/promote`):**
   - Connect dashboard "Promote to Git" action to Control API `POST /v1/leases/:id/promote`.
   - Displays real-time GitHub PR creation status and link to the generated Draft Pull Request.
   - Enforce operator/admin role check and CSRF header verification on `/api/actions/promote`.
3. **Session Management & Audit Logging:**
   - Log dashboard administrative actions (`REVOKE_TRIGGERED`, `PROMOTE_TRIGGERED`) to Control API audit ledger.
   - User profile dropdown with session expiry countdown and explicit logout trigger.

---

## 4. Immediate Next Steps for Next Session

1. **Merge PR 24 into `main`:**
   ```bash
   git checkout main
   git pull origin main
   git merge feat/dashboard-nextjs-portal
   git push origin main
   ```
2. **Branch PR 25:**
   ```bash
   git checkout -b feat/dashboard-rbac-and-actions
   ```
3. **Implement Live OIDC Integration & Promotion Action Triggers:**
   - Implement GitHub OAuth callback exchange in `apps/dashboard/src/app/api/auth/callback/route.ts`.
   - Implement `/api/actions/promote/route.ts` with promotion status tracking.
   - Verify all monorepo gates (`lint`, `build`, `typecheck`, `test:coverage`).
