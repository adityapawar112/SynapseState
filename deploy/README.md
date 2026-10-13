# SynapseState Infrastructure & Deployment Guide

This directory contains Infrastructure as Code (Terraform) and Helm charts for deploying SynapseState on single-node k3s clusters.

---

## Architecture & Topology (ARCH §12.1)

```
k3s Cluster
├── synapse-system/
│   ├── Control API (apps/control-api)
│   ├── In-Process Audit Sealer
│   ├── PostgreSQL 16 (State & Audit Ledger)
│   └── synapse-checkpoint-signer (CronJob, PR 19)
├── observability/
│   ├── Prometheus
│   ├── Grafana
│   └── Alertmanager
└── workloads/
    └── Demo Shop (apps/demo-shop microservice)
```

---

## 1. Terraform VM Provisioning (`deploy/terraform`)

### Prerequisites & Dependencies (Review I4)
- An active AWS account with permissions for EC2, VPC, S3, IAM, and optionally Route53.
- Terraform `>= 1.5.0` installed locally or executed via CI.

### Security Hardening (ARCH §13.3, Review C1, I1, I5)
- **Fail-Closed Firewall:** Security groups default to `allowed_ssh_cidrs = []` and `allowed_k8s_api_cidrs = []`. To access SSH or the k3s API server, you must provide your operator CIDR explicitly in `terraform.tfvars`.
- **IMDSv2 Enforced:** Instance metadata service requires token headers (`http_tokens = "required"`, hop limit 1) to prevent SSRF credential exfiltration.
- **Reproducible k3s:** Installs pinned k3s version `v1.30.5+k3s1` with permissions `--write-kubeconfig-mode 600`.
- **Tamper-Evident Ledger:** S3 bucket created with S3 Object Lock in `COMPLIANCE` mode and versioning enabled (ARCH §8.3 & Invariant 7).

### Usage
```bash
cd deploy/terraform

# 1. Format and Validate
terraform fmt -check
terraform init -backend=false
terraform validate

# 2. Plan and Apply (requires AWS credentials & operator CIDR)
terraform apply -var="allowed_ssh_cidrs=[\"YOUR_IP/32\"]"
```

---

## 2. Helm Charts (`deploy/helm`)

### Prerequisites & Platform Dependencies (Review I4)
The Helm charts expect the following in the target cluster:
1. **Traefik Ingress Controller:** Bundled and enabled by default in k3s.
2. **cert-manager:** Installed for ACME / Let's Encrypt TLS certificate generation (`ClusterIssuer: letsencrypt-prod`).
3. **PostgreSQL Database:** PostgreSQL 16 running in `synapse-system` with credentials stored in secret `synapse-db-credentials`:
   ```bash
   kubectl create secret generic synapse-db-credentials -n synapse-system \
     --from-literal=DATABASE_URL="postgresql://user:pass@postgres:5432/synapsestate" \
     --from-literal=LEASE_DATABASE_URL="postgresql://user:pass@postgres:5432/synapsestate" \
     --from-literal=TELEMETRY_DATABASE_URL="postgresql://user:pass@postgres:5432/synapsestate"
   ```

### Trust Root Separation (ARCH §3.1, Invariant 2, Review C4)
Helm **never** owns or clobbers the Git-pinned Keyset trust root or emergency leases. These are mounted as read-only volumes and deployed directly via GitOps:
```bash
# Apply pinned Ed25519 keyset from Git:
kubectl apply -f git/keyset.yaml -n synapse-system

# Apply emergency break-glass leases (if operating in air-gapped emergency mode):
kubectl apply -f emergency-leases.yaml -n synapse-system
```

### Pod Security Standards (ARCH §13.3, Review I6)
- Distroless non-root user `runAsUser: 65532`, `runAsGroup: 65532`, `runAsNonRoot: true`.
- `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities: { drop: ["ALL"] }`.
- `seccompProfile: { type: RuntimeDefault }` applied at both pod and container level.
- Transient writes isolated to `/tmp` via `emptyDir: {}`.

### Checkpoint Signer CronJob (ARCH §8.3, Invariant 7, Review C3, I3)
- Checkpoint signer CLI logic is scheduled for implementation in **PR 19** (`ROADMAP §4`).
- Manifest template is fully parameterized with a dedicated ServiceAccount (`automountServiceAccountToken: false`) and non-optional secret keys.
- Defaults to `cronjob.enabled: false` until PR 19.
