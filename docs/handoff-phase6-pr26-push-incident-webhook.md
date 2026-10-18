# SynapseState Handoff: Phase 6 PR 26 Onboarding (Push Incident Automation Webhook)

> **Document Status:** Completed & Verified (Ready for Merge)  
> **Milestone:** Phase 6 (Weeks 11 – 12: Operations Dashboard & Optional Push Automation)  
> **Current Target:** PR 26 (`feat/push-incident-webhook`)  
> **Repository:** `adityapawar112/SynapseState` (`synapsestate/synapsestate`)  
> **Base PR:** PR #25 (`feat/dashboard-rbac-and-actions`) — Merged into `main` (`878c281`)  
> **PR 26 Head Commit:** `aff0e0a` (`feat(api): optional alertmanager incident webhook and grafana annotations (PR 26)`)  
> **Primary Charter & Specs:**
>
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants 1–8, §5 SLOs, §6 Verification Guidelines)
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§4.3 Webhook Reconciliation, §8 Operations Dashboard, §10 Security Threat Model, §11.4 Incident Investigation & Pure Ranker)
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 6, Deliverable 6.2 & PR 26)
> - Design System: [design.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/design.md)
> - Glossary: [GLOSSARY.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/GLOSSARY.md)

---

## 1. Suggested Skills

The next agent picking up this task should call the following skills:

- `test-driven-development`: Implement Alertmanager webhook listener, Grafana annotations integration, and Slack/channel suggestion formatting test-first.
- `domain-modeling`: Model Alertmanager alert schema, incident suspected flag ranking, and Grafana annotation events.
- `systematic-debugging`: Validate error handling for malformed alert payloads, Grafana API downtime, and missing change telemetry.
- `verification-before-completion`: Run all monorepo quality gates (`pnpm run lint`, `pnpm -r run build`, `pnpm run typecheck`, `pnpm test`) before making completion claims.

---

## 2. Executive Summary & Monorepo State (PR 25 Baseline)

**PR 25 (`feat/dashboard-rbac-and-actions`, commit `0747c57`)** has delivered:

- **GitHub OAuth Live Integration (`apps/dashboard/src/app/api/auth/`):**
  - Live OAuth redirect (`/api/auth/github`) with 256-bit CSPRNG state and HttpOnly cookie binding.
  - Token exchange callback (`/api/auth/callback`) querying `/user`, `/user/teams`, and `/user/orgs` defensively.
  - Team-to-role mapping via `SYNAPSE_ADMIN_TEAMS` and `SYNAPSE_OPERATOR_TEAMS`.
  - Immediate disposal of GitHub access token; only signed SynapseState HMAC tokens (`crypto.subtle`) are retained in secure cookies.
  - Path-safe cookie clearing (`res.cookies.set("synapse_oauth_state", "", { path: "/", maxAge: 0 })`).
- **Lease Promotion Trigger Seam (`/api/actions/promote`):**
  - Connected dashboard "Promote to Git" action to Control API `POST /v1/leases/:id/promote`.
  - Enforced operator/admin role check and CSRF header verification (`x-synapse-csrf`) with edge middleware parity in `apps/dashboard/src/middleware.ts`.
  - Staged `LEASE_PROMOTE_REQUESTED` and `DASHBOARD_PROMOTE_TRIGGERED` to `audit_pending` for cryptographic sealing.
  - Normalized error taxonomy: returns `STALE_PR_CONFLICT` with `existing_pr_url` for idempotent promotions and displays clickable PR links in `PromoteModal.tsx`.
- **UI Operations Modals & User Profile (`apps/dashboard/src/components/`):**
  - `PromoteModal.tsx`: Accessible dialog adhering to Voltage design system (solid fills, zero `rgba` opacity wash), explaining Dual-Control Invariant 4, and displaying live Draft PR link.
  - `LeaseCard.tsx`: Integrated "Promote to Git" action button when no promotion PR exists.
  - `UserProfileDropdown.tsx`: Real-time session countdown timer ticking down to `expiresAt`, mapped teams pill badges, role permissions explanation, and explicit logout trigger.
- **Control API Audit Event Staging (`POST /v1/audit/events`):**
  - Secured endpoint for staging administrative and operational events into `audit_pending` for asynchronous sealing by `AuditSealer`.
  - Enforced `ALLOWED_STAGED_AUDIT_EVENTS` allowlist (`DASHBOARD_LOGIN`, `DASHBOARD_REVOKE_TRIGGERED`, `DASHBOARD_PROMOTE_TRIGGERED`, `LEASE_PROMOTE_REQUESTED`, `INCIDENT_ALERT_RECEIVED`, `INCIDENT_ATTRIBUTION_EMITTED`) rejecting ledger pollution with HTTP 400 `INVALID_EVENT_TYPE`.
- **Monorepo Baseline Health:**
  - `pnpm run lint`: 0 errors, 0 warnings.
  - `pnpm run typecheck`: 0 errors across all 8 workspace projects, load test, and root test tsconfigs.
  - `pnpm -r run build`: Clean compilation across all packages and Next.js 15 app router.
  - `pnpm test`: 100% passing across the monorepo (Dashboard 10/10 suites, 74 tests; Control API 17/17 suites, 154 tests; CLI 8/8 suites, 124 tests; Conformance 4/4 suites, 43 tests; Drills 3/3 suites, 14 tests).

---

## 3. PR 26 Scope & Architecture (`feat/push-incident-webhook`)

PR 26 implements optional Alertmanager incident webhook integration and Grafana annotations in `apps/control-api/src/routes/webhooks.ts` per `ROADMAP.md §5 Phase 6`:

### 3.1. Alertmanager Webhook Route (`POST /v1/webhooks/alertmanager`)
- **Payload Schema:** Receives Prometheus Alertmanager firing alert notifications:
  ```json
  {
    "version": "4",
    "status": "firing",
    "receiver": "synapse-webhook",
    "alerts": [
      {
        "status": "firing",
        "labels": {
          "alertname": "HighHttp5xxRate",
          "service": "checkout",
          "env": "production",
          "severity": "critical"
        },
        "annotations": {
          "summary": "High 5xx rate on checkout service"
        },
        "startsAt": "2026-10-18T14:30:00.000Z"
      }
    ]
  }
  ```
- **Authentication:** Validates `ALERTMANAGER_WEBHOOK_SECRET` via header (`Authorization: Bearer <secret>` or `X-Alertmanager-Secret`).
- **Attribution Logic:**
  - Queries recent `change_events` table for changes matching `service` (or repo) and `env` within a configurable lookback window (default: 60 minutes prior to `startsAt`).
  - Utilizes change suspect ranking heuristic (from `@synapsestate/cli/src/ranker.ts` or shared utility) to correlate the firing alert with the most likely causal flag change.
  - Formats copy-pasteable emergency override commands for incident responders:
    `synapse lease create --flag <flag_key> --variant <baseline_variant> --env <env> --ttl 30m --reason "Incident attribution: <alertname>"`

### 3.2. Grafana Annotations Integration
- When `GRAFANA_URL` and `GRAFANA_API_KEY` (or service account token) are configured:
  - Dispatches `POST /api/annotations` to Grafana.
  - Attaches annotation on dashboard timelines:
    - `tags`: `["synapse", "incident", "suspected-flag", "env:<env>", "service:<service>"]`
    - `text`: `[SynapseState Alert Correlation] Suspected flag: <flag_key> (Changed <time_ago>). Remediation: synapse lease create --flag <flag_key> ...`
  - Graceful timeout and fail-open behavior: failures in Grafana emission must never fail the Alertmanager webhook response (logs warning and proceeds).

### 3.3. Tamper-Evident Ledger Audit Event
- Stages `INCIDENT_ALERT_RECEIVED` and `INCIDENT_ATTRIBUTION_EMITTED` into `audit_pending` with alert details, suspected flag, and remediation command.
- Note: Both event types are already explicitly included in `ALLOWED_STAGED_AUDIT_EVENTS` in `apps/control-api/src/routes/audit.ts`.

---

## 4. Implementation Verification & Results (PR 26 Completed)

All requirements for Deliverable 6.2 and PR 26 have been implemented, tested test-first, and verified:

1. **Shared Attribution Ranker (`packages/lease/src/ranker.ts`):**
   - Extracted deterministic, pure `rankSuspects`, `quoteShellArg`, and associated interfaces (`ChangeEvent`, `FlagEvaluationRecord`, `SuggestedAction`, `RankedSuspect`) into `@synapsestate/lease`.
   - Maintained backward compatibility via re-exports in `@synapsestate/cli/src/ranker.ts`.
   - Added `--variant <val>` alias for `--value <val>` in `synapse lease create`.

2. **Grafana Client (`apps/control-api/src/grafana/`):**
   - Implemented `DefaultGrafanaClient` with fail-open timeout handling via `AbortController` (default 5s timeout).
   - Validated annotation payload tags (`["synapse", "incident", "suspected-flag", ...]`).
   - Covered by unit tests in `apps/control-api/src/grafana/client.test.ts` (3/3 passing).

3. **Alertmanager Webhook (`apps/control-api/src/routes/webhooks.ts`):**
   - Added `POST /v1/webhooks/alertmanager` endpoint.
   - Enforced timing-safe secret validation across `Authorization: Bearer <secret>` and `X-Alertmanager-Secret`.
   - Handled firing alerts, queried `change_events` and `flag_usage_daily` over lookback window (default 60m), and correlated suspect changes.
   - Formatted copy-pasteable emergency overrides:
     `synapse lease create --flag <flag_key> --value <quoted_val> --env <env> --ttl 30m --reason "Incident attribution: <alertname>"`
   - Staged `INCIDENT_ALERT_RECEIVED` and `INCIDENT_ATTRIBUTION_EMITTED` to `audit_pending`.
   - Emitted Grafana annotations with fail-open protection.

4. **Monorepo Quality Gate Evidence:**
   - `pnpm run lint`: 0 errors, 0 warnings.
   - `pnpm run typecheck`: 0 errors across all 8 workspace packages, load test, and root tsconfigs.
   - `pnpm -r run build`: Clean build across all packages and Next.js 15 dashboard.
   - `pnpm test`: 100% passing across all 445 tests in the monorepo:
     - `packages/lease`: 9 suites, 126 tests.
     - `apps/control-api`: 18 suites, 167 tests (including 22 webhooks tests, 3 Grafana tests).
     - `packages/cli`: 8 suites, 125 tests.
     - `packages/conformance`: 4 suites, 43 tests.
     - `test/drills`: 3 suites, 14 tests.
     - `apps/demo-shop`: 1 suite, 1 test.
     - `apps/dashboard`: 10 suites, 74 tests.

