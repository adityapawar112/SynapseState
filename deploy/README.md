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

---

## 3. Observability, Dashboards & Alert Rules (ARCH §11, ROADMAP §5)

### Operations Grafana Dashboard (`deploy/helm/dashboards/synapsestate-operations.json`)

Production SRE dashboard structured into 4 operational domains:

1. **Active Incident & Overrides Overview:**
   - Stat: `synapse_leases_active{env}` — active break-glass leases per environment (target: 0 in steady state).
   - Timeseries: `sum by (from, to) (rate(synapse_lease_transitions_total[5m]))` — lifecycle state transitions rate.
   - Table: Active leases and transition event volume breakdown.
2. **SLO & Latency Performance:**
   - Timeseries: Histogram quantiles ($p50, p95, p99$) of `synapse_lease_propagation_seconds` with a $10\text{s}$ threshold marker (Target SLO: $p95 \le 10\text{s}$).
   - Timeseries: State poll request rate and $p95$ duration grouped by HTTP status code (`synapse_state_poll_duration_seconds`).
3. **Audit Ledger Health:**
   - Gauge: `synapse_audit_pending_queue_size` — depth of unsealed events in `audit_pending`.
   - Gauge / Timeseries: `synapse_audit_pending_age_seconds` — oldest unsealed event age (stall threshold: $30\text{s}$).
   - Stat: `synapse_audit_chain_length` — monotonic SHA-256 sealed ledger height.
4. **Client SDK Fleet Health:**
   - Timeseries: `max(synapse_sdk_state_age_seconds)` (threshold $60\text{s}$) & `max(synapse_sdk_keyset_age_seconds)` (ceiling $900\text{s} / 15\text{m}$).
   - Timeseries: `sum(rate(synapse_sdk_poll_errors_total[5m]))` and `sum(rate(synapse_sdk_telemetry_dropped_total[5m]))`.
   - Stat: `sum(synapse_sdk_active_overrides)` — active in-memory overrides across fleet.

### Multi-Window Multi-Burn-Rate Alert Rules (`deploy/helm/alerts/synapsestate-rules.yaml`)

Implements Google SRE Workbook Chapter 5 standards for State API availability SLO (99.5% over 30 days, error budget $0.005$):

- **Fast Burn (`SynapseStateApiAvailabilityFastBurn`):**
  - Burns 2% of 30-day budget in 1 hour ($14.4\times$ burn rate factor $\implies 7.2\%$ error rate).
  - Evaluates both short (5m) and long (1h) windows. Severity: `critical`.
- **Slow Burn (`SynapseStateApiAvailabilitySlowBurn`):**
  - Burns 5% of 30-day budget in 6 hours ($6\times$ burn rate factor $\implies 3.0\%$ error rate).
  - Evaluates both short (30m) and long (6h) windows. Severity: `warning`.
- **Lease Propagation Lag (`SynapseLeasePropagationDegraded`):**
  - Fires when $p95$ of `synapse_lease_propagation_seconds > 10\text{s}$ for $> 5\text{m}$. Severity: `warning`.
- **Audit Sealer Stalled (`SynapseAuditSealerLagging`):**
  - Fires when `synapse_audit_pending_age_seconds > 30` for $> 2\text{m}$. Severity: `critical`.
- **SDK Fleet Freshness:**
  - `SynapseStateStale`: Fires when `synapse_sdk_state_age_seconds > 60` for $> 5\text{m}$. Severity: `warning`.
  - `SynapseKeysetStale`: Fires when `synapse_sdk_keyset_age_seconds > 900` ($15\text{m}$). Severity: `critical`.
- **Active Emergency Leases (`SynapseActiveEmergencyLeases`):**
  - Informational alert when break-glass leases remain active for $> 30\text{m}$, prompting GitOps PR promotion.

### Helm Integration Options (`values.yaml`)

```yaml
monitoring:
  # Deploys ConfigMap with synapsestate-operations.json labeled for Grafana sidecar
  dashboards:
    enabled: true
    labels:
      grafana_dashboard: "1"

  # Deploys Prometheus Operator PrometheusRule CRD (monitoring.coreos.com/v1)
  prometheusRule:
    enabled: false
    additionalLabels:
      role: alert-rules

  # Deploys plain ConfigMap with synapsestate-rules.yaml for vanilla Prometheus
  alertsConfigMap:
    enabled: false
```
