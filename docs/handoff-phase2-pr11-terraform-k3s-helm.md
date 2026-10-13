# SynapseState Handoff: Phase 2 — Terraform VM Provisioning & Helm Charts for k3s

> **Target Session:** Implement PR 11 (`infra/terraform-k3s-helm`)  
> **Repository:** `synapsestate/synapsestate`  
> **Target Branch:** `infra/terraform-k3s-helm` (branch from `main` after merging PR 10)  
> **Primary Charter & Specs:**  
> - System Charter & Invariants: [AGENTS.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/AGENTS.md) (§1 Non-Goals, §2 Architectural Invariants)  
> - Authoritative Architecture: [docs/ARCHITECTURE.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ARCHITECTURE.md) (§12.1 Target Deployment Topology, §12.2 IaC Terraform, §13 Architectural Decisions)  
> - Delivery Roadmap: [docs/ROADMAP.md](file:///c:/Users/adity/Desktop/Projects/SynapseState/docs/ROADMAP.md) (§5 Phase 2.4, PR 11)  
> - Container Packaging Reference: [Dockerfile.control-api](file:///c:/Users/adity/Desktop/Projects/SynapseState/Dockerfile.control-api), [Dockerfile.demo-shop](file:///c:/Users/adity/Desktop/Projects/SynapseState/Dockerfile.demo-shop)  

---

## 1. Executive Summary & Monorepo State

PR 10 (`infra/docker-packaging`) implemented multi-stage distroless containerization (`Dockerfile.control-api`, `Dockerfile.demo-shop`), local multi-container orchestration in `docker-compose.yml`, and GHCR image building with Trivy vulnerability scanning (`.github/workflows/docker.yml`).

### Current Status:
- **Monorepo Health:** 100% green across all packages (Lint, Build, Typecheck, Test).
- **Test Suite:** 34 test files, 258 tests passing locally with Vitest v8 coverage.
- **Packaged Container Images:**
  - `synapsestate-control-api:local` (non-root distroless nodejs22 on port 3000)
  - `synapsestate-demo-shop:local` (non-root distroless nodejs22 on port 3001)
- **Local Compose Stack:** `docker compose up -d` brings up PostgreSQL 16, Control API with automatic schema migrations, and Demo Shop microservice.

---

## 2. Invariants & Architectural Requirements for PR 11

All Terraform configurations and Helm chart manifests for PR 11 must satisfy:

1. **Target Deployment Topology (ARCH §12.1):**
   - Clean Kubernetes namespaces:
     - `synapse-system`: Control API, Async Sealer, and PostgreSQL.
     - `observability`: Prometheus, Grafana, Alertmanager (prepared for Phase 3).
     - `workloads`: Application microservices running OpenFeature SDKs (e.g. `demo-shop`).

2. **Pod Security Standards & Container Hardening (ROADMAP §2.4, §13.3):**
   - Non-root user: `runAsUser: 65532`, `runAsGroup: 65532`, `runAsNonRoot: true`.
   - Security context: `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities: { drop: ["ALL"] }`.
   - Liveness & Readiness Probes:
     - Control API: `httpGet` to `/healthz` (liveness, port 3000) and `/readyz` (readiness, port 3000).
     - Demo Shop: `httpGet` to `/health` (liveness/readiness, port 3001).

3. **Isolated Checkpoint Signer CronJob (ROADMAP §2.4, ARCH §13):**
   - Independent Kubernetes CronJob (`synapse-checkpoint-signer`) running with isolated credentials.
   - Signs periodic tamper-evident checkpoints from the PostgreSQL audit ledger to external write-once storage.

4. **Terraform Infrastructure as Code (`deploy/terraform/`):**
   - Cloud VM provisioning, networking/VPC, security groups/firewall rules, and DNS records.
   - Clean variables, outputs, and remote state configuration.

5. **Helm Chart Modularity (`deploy/helm/`):**
   - `deploy/helm/control-api`: Deployment, Service, Ingress (TLS termination via cert-manager annotations), ConfigMap, Secret references.
   - `deploy/helm/demo-shop`: Reference microservice deployment connecting to Control API.

---

## 3. Scope of Deliverables for PR 11

```
deploy/
├── terraform/
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   └── versions.tf
└── helm/
    ├── control-api/
    │   ├── Chart.yaml
    │   ├── values.yaml
    │   └── templates/
    │       ├── deployment.yaml
    │       ├── service.yaml
    │       ├── ingress.yaml
    │       ├── cronjob-checkpoint-signer.yaml
    │       └── configmap.yaml
    └── demo-shop/
        ├── Chart.yaml
        ├── values.yaml
        └── templates/
            ├── deployment.yaml
            └── service.yaml
```

---

## 4. Verification & Quality Gates

```bash
# 1. Monorepo Quality Gates
pnpm run lint
pnpm -r run build
pnpm -r run typecheck
pnpm run test:coverage

# 2. Terraform Syntax & Validation
cd deploy/terraform && terraform fmt -check && terraform validate

# 3. Helm Chart Linting & Dry-Run Templating
helm lint deploy/helm/control-api
helm lint deploy/helm/demo-shop
helm template synapse-control-api deploy/helm/control-api
helm template synapse-demo-shop deploy/helm/demo-shop
```
