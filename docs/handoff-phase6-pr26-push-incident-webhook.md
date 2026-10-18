# SynapseState Handoff: Phase 6 PR 26 Onboarding (Push Incident Automation Webhook)

> **Document Status:** Active Engineering Baseline  
> **Milestone:** Phase 6 (Weeks 11 – 12: Operations Dashboard & Optional Push Automation)  
> **Current Target:** PR 26 (`feat/push-incident-webhook`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Current Base PR:** PR #25 (`feat/dashboard-rbac-and-actions`)  
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§8 Operations Dashboard, §10 Security Threat Model)
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§6 Phase 6, Deliverable 6.2 & PR 26)
> - Design System: [design.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/design.md)
> - Glossary: [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md)

---

## 1. Suggested Skills

The next agent picking up this task should invoke the following skills:

- `test-driven-development`: Implement Alertmanager webhook listener, Grafana annotations integration, and Slack/channel suggestion formatting test-first.
- `domain-modeling`: Model Alertmanager alert schema, incident suspected flag ranking, and Grafana annotation events.
- `systematic-debugging`: Validate error handling for malformed alert payloads, Grafana downtime, and missing change telemetry.
- `verification-before-completion`: Run all monorepo quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test:coverage`) before making completion claims.

---

## 2. Executive Summary & Monorepo State (PR 25 Baseline)

**PR 25 (`feat/dashboard-rbac-and-actions`)** has delivered:

- **GitHub OAuth Live Integration (`apps/dashboard/src/app/api/auth/`):**
  - Live OAuth redirect (`/api/auth/github`) with 256-bit CSPRNG state and HttpOnly cookie binding.
  - Token exchange callback (`/api/auth/callback`) querying `/user`, `/user/teams`, and `/user/orgs` defensively.
  - Team-to-role mapping via `SYNAPSE_ADMIN_TEAMS` and `SYNAPSE_OPERATOR_TEAMS`.
  - Immediate disposal of GitHub access token; only signed SynapseState HMAC tokens (`crypto.subtle`) are retained in secure cookies.
- **Lease Promotion Trigger Seam (`/api/actions/promote`):**
  - Connected dashboard "Promote to Git" action to Control API `POST /v1/leases/:id/promote`.
  - Enforced operator/admin role check and CSRF header verification (`x-synapse-csrf`).
  - Staged `LEASE_PROMOTE_REQUESTED` and `DASHBOARD_PROMOTE_TRIGGERED` to `audit_pending` for cryptographic sealing.
  - Handles `STALE_PR_CONFLICT` with clickable links to existing PRs.
- **UI Operations Modals & User Profile (`apps/dashboard/src/components/`):**
  - `PromoteModal.tsx`: Accessible dialog adhering to Voltage design system, explaining Dual-Control Invariant 4, and displaying live Draft PR link.
  - `LeaseCard.tsx`: Integrated "Promote to Git" action button when no promotion PR exists.
  - `UserProfileDropdown.tsx`: Real-time session countdown timer ticking down to `expiresAt`, mapped teams pill badges, role permissions explanation, and explicit logout trigger.
- **Control API Audit Event Staging (`POST /v1/audit/events`):**
  - Secured endpoint for staging administrative events (`DASHBOARD_LOGIN`, `DASHBOARD_REVOKE_TRIGGERED`, `DASHBOARD_PROMOTE_TRIGGERED`) into `audit_pending` for asynchronous sealing by `AuditSealer`.

---

## 3. PR 26 Scope & Deliverables (`feat/push-incident-webhook`)

1. **Alertmanager Webhook Route (`POST /v1/webhooks/alertmanager`):**
   - Receives Prometheus Alertmanager firing alert notifications (`labels.alertname`, `labels.service`, `labels.env`, `startsAt`).
   - Invokes shared suspect ranker (`rankSuspects` from `@synapsestate/cli` or shared lib) with recent changes from `change_events`.
2. **Automated Incident Attribution & Annotations:**
   - Creates Grafana incident annotations (via Grafana HTTP API) annotating the suspected feature flag change.
   - Formats copy-pasteable emergency override commands for incident channels (`synapse lease create ...`).
3. **Audit Logging & Verification:**
   - Stages `INCIDENT_ALERT_RECEIVED` and `INCIDENT_ATTRIBUTION_EMITTED` into `audit_pending`.
   - Comprehensive test suite covering valid alerts, missing services, Grafana API timeouts, and ranker integration.

---

## 4. Immediate Next Steps for Next Session

1. **Merge PR 25 into `main`:**
   ```bash
   git checkout main
   git pull origin main
   git merge feat/dashboard-rbac-and-actions
   git push origin main
   ```
2. **Branch PR 26:**
   ```bash
   git checkout -b feat/push-incident-webhook
   ```
3. **Implement Alertmanager Webhook & Attribution Engine:**
   - Implement route in `apps/control-api/src/routes/webhooks.ts`.
   - Add unit and integration tests in `apps/control-api/src/routes/webhooks.test.ts`.
   - Verify monorepo quality gates (`pnpm run lint`, `pnpm run typecheck`, `pnpm test:coverage`).
