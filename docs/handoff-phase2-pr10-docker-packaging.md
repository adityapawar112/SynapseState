# SynapseState Handoff: Phase 2 — Multi-Stage Distroless Docker Packaging & GHCR Publishing

> **Target Session:** Implement PR 10 (`infra/docker-packaging`)  
> **Repository:** `synapsestate/synapsestate`  
> **Target Branch:** `infra/docker-packaging` (branch from `main` after merging PR 9, or from commit `04be0c0`)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§12.1 Target Deployment Topology, §13 Architectural Decisions)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 2.3 & Phase 2.4, PR 10)  
> - CI Pipeline Reference: [.github/workflows/ci.yml](file:///c:/Users/adity/Desktop/Projects/SynapseState/.github/workflows/ci.yml)  

---

## 1. Executive Summary & Monorepo State

PR 9 (`feat/control-api-telemetry-changes`) implemented the bulkhead telemetry batch ingestion endpoint (`POST /v1/telemetry/batches`), incident attribution change event feed (`GET /v1/changes`), and hardened zero-context schema validations and connection lifecycle hygiene ([`9fb980b`](https://github.com/adityapawar112/SynapseState/commit/9fb980b) & [`04be0c0`](https://github.com/adityapawar112/SynapseState/commit/04be0c0)).

### Current Status:
- **Monorepo Health:** 100% green across all workspace packages (Lint, Build, Typecheck, Test).
- **Test Suite:** 33 test files, 257 tests passing locally with Vitest v8 coverage.
- **Applications Ready for Packaging:**
  - `apps/control-api`: Control Plane service with Fastify, PostgreSQL connection pools (`leasePool`, `telemetryPool`), and embedded migrations.
  - `apps/demo-shop`: Reference microservice using `@synapsestate/sdk` with OpenFeature and `@openfeature/flagd-provider`.
- **Existing Container Environment:**
  - `docker-compose.yml` provides a local PostgreSQL 16 container (`synapse-postgres` on port 5432).

---

## 2. Invariants & Architectural Requirements for PR 10

All container specifications and CI workflows for PR 10 must satisfy:

1. **Multi-Stage Build Isolation:**
   - Builder stage: Uses `node:22-alpine` or `node:22-bookworm-slim` with `pnpm@10.18.3` to install workspace dependencies and compile TypeScript assets (`pnpm -r run build`).
   - Production pruning: Extract only production dependencies required for runtime execution (`pnpm --filter ... deploy` or selective copy of production workspace packages).

2. **Distroless & Non-Root Runtime Hardening (ROADMAP §2.4, ARCH §12.1):**
   - Base image: `gcr.io/distroless/nodejs22-debian12:nonroot` (or official sha256 pinned digest).
   - Execution user: Non-root user `USER nonroot` (UID `65532:65532`).
   - Security constraints: Minimal attack surface, zero package managers (`apk`, `apt`), zero interactive shells (`bash`, `sh`).
   - Read-only root filesystem compatibility: Application processes must not attempt write operations to root paths.

3. **Artifact Completeness & Startup Correctness:**
   - **`Dockerfile.control-api`:**
     - Must copy compiled code (`dist/`), production dependencies, migration SQL files (`src/db/migrations/`), and package metadata.
     - Entrypoint: `["dist/index.js"]`.
     - Exposes port 3000 (`PORT=3000`).
   - **`Dockerfile.demo-shop`:**
     - Must copy compiled code (`dist/`), production dependencies, and package metadata.
     - Entrypoint: `["dist/index.js"]`.
     - Exposes port 3001 (`PORT=3001`).

4. **CI/CD Image Publishing Workflow (`.github/workflows/docker.yml`):**
   - Triggered on push to `main` and on pull requests targeting `main`.
   - Uses `docker/build-push-action@v6` with GitHub Actions cache (`type=gha`).
   - Tags: Git commit SHA (`sha-${{ github.sha }}`), branch name, and `latest` (on `main`).
   - Image registry: GitHub Container Registry (`ghcr.io/${{ github.repository_owner }}/control-api`, `ghcr.io/${{ github.repository_owner }}/demo-shop`).
   - Security scanning: Integrates vulnerability scanning (e.g. `aquasecurity/trivy-action` or Docker Scout) in PR checks.
   - Pushes to registry only on merges to `main` (skips push on PRs).

5. **Local Docker Compose Integration:**
   - Update `docker-compose.yml` to optionally build and run `control-api` and `demo-shop` alongside `postgres` for local end-to-end multi-container verification.

---

## 3. Scope of Deliverables for PR 10

```
.
├── Dockerfile.control-api      # Multi-stage distroless Dockerfile for Control Plane API
├── Dockerfile.demo-shop        # Multi-stage distroless Dockerfile for Demo Shop microservice
├── .dockerignore               # Monorepo docker ignore rules (node_modules, coverage, .git)
├── .github/workflows/docker.yml # GHCR build, scan, and push pipeline
└── docker-compose.yml          # Updated compose file supporting multi-service orchestration
```

---

## 4. Verification & Quality Gates

The implementation must pass all checks before PR creation:
```bash
# 1. Monorepo Quality Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm run test:coverage

# 2. Local Container Build Verification
docker build -f Dockerfile.control-api -t synapsestate-control-api:local .
docker build -f Dockerfile.demo-shop -t synapsestate-demo-shop:local .

# 3. Local Container Run Verification
docker run --rm -d --name test-control-api -e NODE_ENV=test -p 3000:3000 synapsestate-control-api:local
docker run --rm -d --name test-demo-shop -p 3001:3001 synapsestate-demo-shop:local
# Probe health: curl -f http://localhost:3000/healthz && curl -f http://localhost:3001/health
```

---

## 5. Suggested Skills to Invoke

When picking up this handoff, activate the following skills:
- `verification-before-completion`: Execute full build and docker smoke tests before submitting the PR.
- `requesting-code-review`: Provide structured review context with commit SHAs upon completion.
- `codebase-design`: Keep multi-stage Dockerfiles lean, layered for build-cache efficiency, and minimal.
