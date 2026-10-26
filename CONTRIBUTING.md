# Contributing to SynapseState

Thank you for your interest in contributing to **SynapseState**! This guide outlines our engineering practices, development workflows, testing requirements, and invariant enforcement.

> **Prime Directive:** All code modifications and pull requests must adhere to the 8 Non-Negotiable Invariants defined in [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) and the Zero-Buzzwords Policy in [PRODUCT.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/PRODUCT.md).

---

## 1. Prerequisites

Before developing locally, ensure you have installed:

- **Node.js**: `v22.x` (LTS recommended)
- **Package Manager**: `pnpm` (`v9.x` or higher)
- **Container Runtime**: Docker Desktop or Docker Engine (for PostgreSQL)
- **TypeScript**: `v5.8+` (managed by monorepo dependencies)

---

## 2. Monorepo Architecture & Directory Map

SynapseState is structured as a `pnpm` monorepo with strict package boundaries:

```
.
├── apps/
│   ├── control-api/        # Fastify + PostgreSQL governance & state delivery service
│   ├── dashboard/          # Next.js operations portal with GitHub OAuth & RBAC
│   ├── demo-shop/          # Example microservice app for verification & chaos injection
│   └── purger/             # Read-only TypeScript AST dead-flag qualifier (ts-morph)
├── packages/
│   ├── lease/              # Canonicalization (RFC 8785), Ed25519 signing & verification
│   ├── sdk/                # Pure TypeScript OpenFeature OverrideProvider & TelemetryHook
│   ├── cli/                # SRE command-line tool (`synapse`)
│   └── conformance/        # Language-neutral test vectors (JSON) & test runner
├── deploy/
│   ├── terraform/          # VM, networking, firewall, and cloud infra
│   └── helm/               # Helm charts for Control API, Postgres, Observability
├── docs/                   # Architectural specs, ADRs, runbooks, and benchmarks
└── load/                   # k6 load-testing & saturation scripts
```

---

## 3. Quickstart: Local Environment Setup

### 3.1 Install Dependencies

```bash
pnpm install
```

### 3.2 Start Local PostgreSQL Database

The monorepo includes a `docker-compose.yml` preconfigured for PostgreSQL:

```bash
docker compose up -d postgres
```

This starts PostgreSQL on port `5432` with user/password `postgres:postgres` and database `synapsestate`.

### 3.3 Apply Database Migrations

Run automatic migrations against the database:

```bash
pnpm --filter @synapsestate/control-api exec tsx -e "import { leasePool, runMigrations } from './src/db/index.js'; await runMigrations(leasePool); process.exit(0);"
```

### 3.4 Build Packages

Compile all internal packages in dependency order:

```bash
pnpm run build
```

---

## 4. Development Servers

### Running Control API

```bash
pnpm --filter @synapsestate/control-api run dev
```

The Control API listens on `http://localhost:3000` (or `PORT` specified in environment).

### Running Operations Dashboard

To run the Next.js operations portal in development mode with local operator authentication bypass:

```bash
$env:PORT="3010"; $env:SYNAPSE_DEV_AUTH="true"; pnpm --filter @synapsestate/dashboard run dev -- -p 3010
```

Navigate to `http://localhost:3010` to inspect active leases, flag telemetry, and the audit ledger.

---

## 5. Verification & Testing

Every pull request must pass the complete monorepo test suite, type checking, and linting.

### 5.1 Run Test Suite

```bash
pnpm test
```

This executes all unit, integration, and property tests across all apps and packages using `vitest`.

### 5.2 Run Type Checks

```bash
pnpm run typecheck
```

### 5.3 Run Linter

```bash
pnpm run lint
```

### 5.4 Run Conformance Tests

Verify cross-language cryptographic test vectors:

```bash
pnpm --filter @synapsestate/conformance test
```

### 5.5 Run Chaos Failure Drills

Execute automated catastrophic failure and disaster recovery drills (Airgap, Clock Skew, Revocation Partition):

```bash
pnpm run test:drills
```

### 5.6 Automated Documentation Screenshot Capture

Generate authentic operational screenshots directly from live Next.js Dashboard and Grafana instances:

```bash
pnpm run capture:docs
# Or using the pinned official container:
pnpm run capture:docs:docker
```

---

## 6. The 8 Non-Negotiable Architectural Invariants

Every pull request is reviewed against these system boundaries:

| #     | Invariant                              | Requirement                                                                                                                                                   |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **Fail-Safe Hot Path Delegation**      | The `OverrideProvider` must always fall back immediately to the delegate provider if no lease exists or on any error. Zero application crashes permitted.     |
| **2** | **Pinned Keyset Trust Root**           | SDKs verify Ed25519 signatures against a locally pinned keyset file mounted from Git. The Control API must never serve or modify the keyset.                  |
| **3** | **Deterministic Dual-Clock Expiry**    | Overrides enforce both monotonic process time and wall-clock bounds: `≤ min(wall_expiry, mono_expiry)`. Zero leases survive past their deadline.              |
| **4** | **Git Reconciliation as Dual Control** | Emergency overrides require single-signature break-glass; promoting to permanent configuration requires a GitHub PR with mandatory human peer review.         |
| **5** | **Zero-Context Telemetry**             | The `TelemetryHook` aggregates only `(flag_key, variant, reason)` tuples. It must never inspect, capture, or export user IDs, session context, or attributes. |
| **6** | **Read-Only Codebase Scanner**         | `synapse-purger` operates as a read-only AST scanner and candidate qualifier. It must never execute target repository test suites or build scripts.           |
| **7** | **Tamper-Evident Audit Ledger**        | State mutations stage to `audit_pending` and seal asynchronously to a SHA-256 hash-chained PostgreSQL ledger.                                                 |
| **8** | **Ecosystem & Library-First Reuse**    | Always prioritize native runtime APIs (`node:crypto`) and standard ecosystem libraries before implementing custom utilities.                                  |

---

## 7. Commit & Pull Request Guidelines

- **Conventional Commits:** Prefix all commit messages according to scope:
  - `feat(lease): ...`
  - `fix(sdk): ...`
  - `perf(api): ...`
  - `docs: ...`
  - `test(purger): ...`
  - `chore: ...`
- **Evidence Before Claims:** Always include test command output and verification logs in pull request descriptions.
- **Fail-Static Verification:** Any pull request modifying the SDK must include tests verifying that disconnecting the Control API leaves evaluation functional and active leases bounded by their TTL.
